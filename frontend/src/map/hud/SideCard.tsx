import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Asset, Floor, SiteLayout } from "../../api/types";
import { FIGURE_LABELS } from "../figures";
import { attachedSections, durWords, fieldLabel, ownSources, primarySource, statusText, valueText, whoName, zoneLabel, type ValueContext } from "../labels";
import { assetName, type FeedEntry } from "../reducer";
import { STATE_KEYS, STATE_LABELS, stateKey, type StateKey } from "../stateColors";
import { headline, isBed, isPatient, isStaff, modelOf, plural, shortLabels, zoneOf, type HeadlineContext } from "./model";
import { ageOf, clock, fmtDur } from "./time";

type Props = {
  layout: SiteLayout;
  floor: Floor;
  /** Live assets on the floor shown. */
  floorAssets: ReadonlyMap<string, Asset>;
  /** All live assets (for related records). */
  assets: ReadonlyMap<string, Asset>;
  feed: FeedEntry[];
  /** Selected record (live, or still walking out). */
  selected: Asset | undefined;
  sourceNames: Record<string, string>;
  now: number;
  onSelect: (id: string) => void;
  onBack: () => void;
  // --- track fix: Track button and History tab for the selected record (map/track) ---
  actions?: ReactNode;
  history?: ReactNode;
  // --- end track fix ---
};

const BAR_ORDER: StateKey[] = ["in-use", "alert", "cleaning", "free", "unknown"];

/** Right card: the floor overview, or the selected record. A bottom sheet on phones. */
export default function SideCard(props: Props) {
  const { selected } = props;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"details" | "history">("details"); // track fix
  const bodyId = useId();
  const headId = useId();
  // On phones a new selection opens the sheet; the overview starts folded.
  useEffect(() => { if (selected) setOpen(true); }, [selected?.asset_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const head = selected ? assetHead(props.layout, selected, props.now) : overviewHead(props.floor, props.floorAssets);
  return (
    <aside className={`lm-glass lm-hud-side ${open ? "lm-hud-side--open" : ""}`} aria-labelledby={headId}>
      <header className="lm-hud-side-head">
        <div className="lm-hud-eyebrow">{head.eyebrow}</div>
        <h2 id={headId}>{head.title}</h2>
        <div className="lm-hud-meta">{head.meta}</div>
        {selected && props.actions /* track fix */}
        <button type="button" className="lm-hud-side-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          {open ? "Hide details" : selected ? "Show details" : "Show rooms and events"}
        </button>
      </header>
      <div className="lm-hud-side-body" id={bodyId}>
        {/* --- track fix: Details / History tabs --- */}
        {selected && props.history ? (
          <>
            <div className="lm-track-tabs" role="tablist" aria-label="Record">
              {(["details", "history"] as const).map((t) => (
                <button key={t} type="button" role="tab" id={`${bodyId}-${t}`} aria-selected={tab === t} aria-controls={`${bodyId}-panel`}
                  tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}
                  onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = t === "details" ? "history" : "details"; setTab(n); document.getElementById(`${bodyId}-${n}`)?.focus(); } }}>
                  {t === "details" ? "Details" : "History"}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`${bodyId}-panel`} aria-labelledby={`${bodyId}-${tab}`} className="lm-hud-side-tab">
              {tab === "history" ? props.history : <AssetBody {...props} selected={selected} />}
            </div>
          </>
        ) : selected ? <AssetBody {...props} selected={selected} /> : <Overview {...props} />}
        {/* --- end track fix --- */}
      </div>
    </aside>
  );
}

function overviewHead(floor: Floor, assets: ReadonlyMap<string, Asset>) {
  const list = [...assets.values()];
  const beds = list.filter(isBed).length;
  const staff = list.filter(isStaff).length;
  const patients = list.filter(isPatient).length;
  const parts = [beds && plural(beds, "bed"), staff && plural(staff, "staff", "staff"), patients && plural(patients, "patient")].filter(Boolean);
  return { eyebrow: "Floor overview", title: floor.name, meta: <>{parts.length ? parts.join(" · ") : plural(list.length, "asset")}</> };
}

function assetHead(layout: SiteLayout, a: Asset, now: number) {
  const k = stateKey(a.state);
  const age = ageOf(a, now);
  const zone = zoneOf(layout, a);
  return {
    eyebrow: `${FIGURE_LABELS[modelOf(a)]} · ${zone ? zoneLabel(zone.name || zone.id) : "Unassigned"}`,
    title: whoName(a),
    meta: (
      <>
        {/* The record's own status (the one its map colour comes from), never an attached source's. */}
        <span className={`lm-hud-chip lm-hud-chip--${k}`}>{statusText(a)}{age !== null ? ` · ${durWords(age)}` : ""}</span>
        {typeof a.updated_ts === "number" && <span className="lm-hud-updated">updated <span className="mono">{clock(a.updated_ts)}</span></span>}
      </>
    ),
  };
}

function Overview({ layout, floorAssets, assets, feed, selected, sourceNames, now, onSelect }: Props) {
  const list = useMemo(() => [...floorAssets.values()], [floorAssets]);
  const beds = useMemo(() => list.filter(isBed).sort((a, b) => assetName(a).localeCompare(assetName(b), undefined, { numeric: true })), [list]);
  const counted = beds.length ? beds : list;
  const counts = Object.fromEntries(STATE_KEYS.map((k) => [k, 0])) as Record<StateKey, number>;
  for (const a of counted) counts[stateKey(a.state)]++;
  const short = shortLabels(beds.map(assetName));
  const events = lines(feed, { layout, sourceNames, assets }, (e) => !!e.assetId && floorAssets.has(e.assetId), 8);
  const what = beds.length ? "Bed status" : "Status";
  return (
    <>
      <div className="lm-hud-occ">
        <div className="lm-hud-occ-row">
          <span>{what}</span>
          <span className="mono">{counts["in-use"]}/{counted.length} in use</span>
        </div>
        <div className="lm-hud-bar" role="img"
          aria-label={`${what}: ${BAR_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${STATE_LABELS[k].toLowerCase()}`).join(", ") || "nothing yet"}`}>
          {BAR_ORDER.map((k) => counts[k] ? <span key={k} className={`lm-s-${k}`} style={{ flexGrow: counts[k] }} /> : null)}
        </div>
      </div>
      {beds.length > 0 && (
        <div>
          <h3 className="lm-hud-sec">Rooms</h3>
          <div className="lm-hud-rooms">
            {beds.map((b, i) => {
              const k = stateKey(b.state);
              const age = ageOf(b, now);
              const timed = age !== null && (k === "cleaning" || k === "alert");
              return (
                <button key={b.asset_id} type="button" className={`lm-hud-room lm-hud-chip--${k}`} aria-pressed={selected?.asset_id === b.asset_id}
                  aria-label={`${assetName(b)}: ${statusText(b)}${timed ? ` for ${durWords(age!)}` : ""}`} onClick={() => onSelect(b.asset_id)}>
                  <span className="mono">{short[i]}</span>
                  <small className="mono">{timed ? fmtDur(age!) : STATE_LABELS[k]}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <EventList events={events} onSelect={onSelect} empty="No changes on this floor yet. They appear here as your sources report them." />
    </>
  );
}

type Line = { entry: FeedEntry; name: string | null; what: string };

/** Feed entries worth a line (newest first) as plain sentences; churn such as badge pings is left out. */
function lines(feed: FeedEntry[], ctx: HeadlineContext, keep: (e: FeedEntry) => boolean, max: number): Line[] {
  const out: Line[] = [];
  for (const e of feed) {
    if (out.length >= max) break;
    if (!keep(e)) continue;
    const h = headline(e, ctx);
    if (h) out.push({ entry: e, ...h });
  }
  return out;
}

function EventList({ events, onSelect, empty }: { events: Line[]; onSelect: (id: string) => void; empty: string }) {
  return (
    <div>
      <h3 className="lm-hud-sec">Live events</h3>
      {events.length === 0 ? (
        <p className="lm-hud-empty">{empty}</p>
      ) : (
        <ol className="lm-hud-feed" role="log" aria-live="off">
          {events.map(({ entry: e, name, what }) => (
            <li key={e.id}>
              <time className="mono">{clock(e.ts)}</time>
              {e.assetId ? (
                <button type="button" className="lm-link" onClick={() => onSelect(e.assetId!)}>{name ? <><b>{name}</b> {what}</> : what}</button>
              ) : <span>{what}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Fields not listed as facts: identity, and what the header already says. */
const HIDDEN = new Set(["site_id", "asset_id", "_sources", "attributes", "label", "kind", "updated_ts", "state"]);

type Fact = { key: string; label: string; value: string };

/** The record's own fields in plain words, grouped by the source that set them. Attached sources get their own sections. */
function factsBySource(a: Asset, sourceNames: Record<string, string>, ctx: ValueContext): { source: string; facts: Fact[] }[] {
  const src = a._sources ?? {};
  const own = ownSources(a);
  const primary = primarySource(a);
  const attrs = a.attributes ?? {};
  const attrValues = new Set(Object.values(attrs).map((v) => String(v)));
  const groups = new Map<string, Fact[]>();
  const add = (sid: string | undefined | null, key: string, v: unknown) => {
    const value = valueText(key, v, ctx);
    if (value === null) return; // empty values are hidden
    const name = sid ? sourceNames[sid] ?? sid : "Source";
    groups.set(name, [...(groups.get(name) ?? []), { key, label: fieldLabel(key), value }]);
  };
  for (const k of Object.keys(a).sort()) {
    if (HIDDEN.has(k)) continue;
    if (k === "anchor" && attrValues.has(String(a[k]))) continue; // repeats the record's own bed field
    add(src[k] ?? primary, k, a[k]);
  }
  for (const [k, v] of Object.entries(attrs).sort(([x], [y]) => x.localeCompare(y))) {
    const sid = src[`attributes.${k}`] ?? src.attributes ?? primary;
    if (sid && own.size > 0 && !own.has(sid)) continue; // an attached source's value: shown in its section
    add(sid, `attributes.${k}`, v);
  }
  const rank = (f: Fact) => { const i = FIRST_FACTS.indexOf(f.key.replace(/^attributes\./, "")); return i < 0 ? FIRST_FACTS.length : i; };
  return [...groups.entries()].map(([source, facts]) => ({ source, facts: facts.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label)) }));
}

/** Facts listed first, in this order; the rest follow alphabetically. */
const FIRST_FACTS = ["status", "zone", "current_location", "anchor", "bed_id", "room", "unit_id", "role", "department"];

/** Every field exactly as the sources sent it, for checking a mapping. */
function rawFacts(a: Asset): Fact[] {
  const show = (v: unknown) => (v === undefined || v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const out: Fact[] = [];
  for (const k of Object.keys(a).sort()) if (k !== "_sources" && k !== "attributes") out.push({ key: k, label: k, value: show(a[k]) });
  for (const [k, v] of Object.entries(a.attributes ?? {}).sort(([x], [y]) => x.localeCompare(y))) out.push({ key: `attributes.${k}`, label: `attributes.${k}`, value: show(v) });
  return out;
}

function Facts({ facts, raw = false }: { facts: Fact[]; raw?: boolean }) {
  return (
    <dl className={`lm-hud-facts${raw ? " lm-hud-facts--raw" : ""}`}>
      {facts.map((f) => (
        <div key={f.key} className="lm-hud-fact">
          <dt className={raw ? "mono" : undefined}>{f.label}</dt>
          <dd className={raw ? "mono" : undefined}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AssetBody({ layout, assets, feed, selected: a, sourceNames, now, onSelect, onBack }: Props & { selected: Asset }) {
  const [raw, setRaw] = useState(false);
  const ctx: ValueContext = { now, layout };
  const groups = factsBySource(a, sourceNames, ctx);
  const attached = attachedSections(a, sourceNames, ctx);
  const zone = zoneOf(layout, a);
  const related = useMemo(() => {
    const out: Asset[] = [];
    const anchor = typeof a.anchor === "string" ? assets.get(a.anchor) : undefined;
    if (anchor) out.push(anchor);
    for (const o of assets.values()) {
      if (o.asset_id === a.asset_id || o === anchor) continue;
      if (o.anchor === a.asset_id || (zone && zoneOf(layout, o)?.id === zone.id)) out.push(o);
      if (out.length >= 8) break;
    }
    return out;
  }, [a, assets, layout, zone]);
  const events = lines(feed, { layout, sourceNames, assets }, (e) => e.assetId === a.asset_id, 5);
  return (
    <>
      <div className="lm-hud-actions">
        <button type="button" className="btn" onClick={onBack}>Back</button>
      </div>
      {related.length > 0 && (
        <div>
          <h3 className="lm-hud-sec">{zone ? `With it in ${zoneLabel(zone.name || zone.id)}` : "Linked"}</h3>
          <ul className="lm-hud-related">
            {related.map((o) => (
              <li key={o.asset_id}>
                <button type="button" className={`lm-hud-chip lm-hud-chip--${stateKey(o.state)}`} onClick={() => onSelect(o.asset_id)}>
                  {whoName(o)} <span className="lm-hud-chip-kind">{FIGURE_LABELS[modelOf(o)].toLowerCase()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {attached.map((g) => (
        <section key={g.sourceId} className="lm-hud-attached" aria-label={g.title}>
          <h3 className="lm-hud-sec">{g.title}</h3>
          {g.summary && <p className="lm-hud-attached-sum">{g.summary}</p>}
          {g.facts.length > 0 && <Facts facts={g.facts} />}
        </section>
      ))}
      {groups.map((g) => (
        <section key={g.source} aria-label={`From ${g.source}`}>
          <h3 className="lm-hud-sec">From {g.source}</h3>
          <Facts facts={g.facts} />
        </section>
      ))}
      <EventList events={events} onSelect={onSelect} empty="No changes to this record since the map opened." />
      <div className="lm-hud-raw">
        <button type="button" className="btn lm-link-btn" aria-expanded={raw} onClick={() => setRaw(!raw)}>{raw ? "Hide raw fields" : "Show raw fields"}</button>
        {raw && <Facts facts={rawFacts(a)} raw />}
      </div>
    </>
  );
}
