import { useEffect, useId, useMemo, useState } from "react";
import type { Asset, Floor, SiteLayout } from "../../api/types";
import { humanize } from "../../components/format";
import { FIGURE_LABELS } from "../figures";
import { assetName, type FeedEntry } from "../reducer";
import { STATE_KEYS, STATE_LABELS, stateKey, type StateKey } from "../stateColors";
import { isBed, isHeadline, headline, isPatient, isStaff, modelOf, plural, rawStatus, shortLabels, zoneOf } from "./model";
import { ageOf, clock, fmtDur, parseTs } from "./time";

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
};

const BAR_ORDER: StateKey[] = ["in-use", "alert", "cleaning", "free", "unknown"];

/** Right card: the floor overview, or the selected record. A bottom sheet on phones. */
export default function SideCard(props: Props) {
  const { selected } = props;
  const [open, setOpen] = useState(false);
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
        <button type="button" className="lm-hud-side-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          {open ? "Hide details" : selected ? "Show details" : "Show rooms and events"}
        </button>
      </header>
      <div className="lm-hud-side-body" id={bodyId}>
        {selected ? <AssetBody {...props} selected={selected} /> : <Overview {...props} />}
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
    eyebrow: `${FIGURE_LABELS[modelOf(a)]} · ${zone ? zone.name || zone.id : "Unassigned"}`,
    title: assetName(a),
    meta: (
      <>
        <span className={`lm-hud-chip lm-hud-chip--${k}`}>{rawStatus(a)}{age !== null ? ` · ${fmtDur(age)}` : ""}</span>
        {typeof a.updated_ts === "number" && <span className="lm-hud-updated">updated <span className="mono">{clock(a.updated_ts)}</span></span>}
      </>
    ),
  };
}

function Overview({ floorAssets, feed, selected, now, onSelect }: Props) {
  const list = useMemo(() => [...floorAssets.values()], [floorAssets]);
  const beds = useMemo(() => list.filter(isBed).sort((a, b) => assetName(a).localeCompare(assetName(b), undefined, { numeric: true })), [list]);
  const counted = beds.length ? beds : list;
  const counts = Object.fromEntries(STATE_KEYS.map((k) => [k, 0])) as Record<StateKey, number>;
  for (const a of counted) counts[stateKey(a.state)]++;
  const short = shortLabels(beds.map(assetName));
  const events = feed.filter((e) => e.assetId && floorAssets.has(e.assetId) && isHeadline(e)).slice(0, 8);
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
                  aria-label={`${assetName(b)}: ${STATE_LABELS[k]}${timed ? ` for ${fmtDur(age!)}` : ""}`} onClick={() => onSelect(b.asset_id)}>
                  <span className="mono">{short[i]}</span>
                  <small className="mono">{timed ? fmtDur(age!) : STATE_LABELS[k]}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <EventList events={events} onSelect={onSelect} assets={floorAssets} empty="No changes on this floor yet. They appear here as your sources report them." />
    </>
  );
}

function EventList({ events, onSelect, assets, empty }: { events: FeedEntry[]; onSelect: (id: string) => void; assets: ReadonlyMap<string, Asset>; empty: string }) {
  return (
    <div>
      <h3 className="lm-hud-sec">Live events</h3>
      {events.length === 0 ? (
        <p className="lm-hud-empty">{empty}</p>
      ) : (
        <ol className="lm-hud-feed" role="log" aria-live="off">
          {events.map((e) => {
            const h = headline(e) ?? { name: null, what: e.text };
            const known = e.assetId ? assets.get(e.assetId) : undefined;
            // Server lines name the record by id; show its label when we have it.
            const name = known && h.name === e.assetId ? assetName(known) : h.name;
            const what = h.what;
            return (
              <li key={e.id}>
                <time className="mono">{clock(e.ts)}</time>
                {e.assetId ? (
                  <button type="button" className="lm-link" onClick={() => onSelect(e.assetId!)}>{name ? <><b>{name}</b> {what}</> : what}</button>
                ) : <span>{what}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const HIDDEN = new Set(["site_id", "asset_id", "_sources", "attributes", "label", "kind", "updated_ts"]);

function showValue(v: unknown, now: number): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = parseTs(v);
    if (t !== null) return `${clock(t)} · ${fmtDur(Math.max(0, now - t))} ago`;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Fact = { key: string; label: string; value: string };

/** The record's fields grouped by the source that set them. */
function factsBySource(a: Asset, sourceNames: Record<string, string>, now: number): { source: string; facts: Fact[] }[] {
  const src = a._sources ?? {};
  const groups = new Map<string, Fact[]>();
  const add = (sid: string | undefined, f: Fact) => {
    const name = sid ? sourceNames[sid] ?? sid : "Unknown source";
    groups.set(name, [...(groups.get(name) ?? []), f]);
  };
  for (const k of Object.keys(a).sort()) {
    if (HIDDEN.has(k)) continue;
    add(src[k], { key: k, label: humanize(k), value: showValue(a[k], now) });
  }
  for (const [k, v] of Object.entries(a.attributes ?? {}).sort(([x], [y]) => x.localeCompare(y))) {
    add(src[`attributes.${k}`] ?? src.attributes, { key: `attributes.${k}`, label: humanize(k), value: showValue(v, now) });
  }
  return [...groups.entries()].map(([source, facts]) => ({ source, facts }));
}

function AssetBody({ layout, assets, feed, selected: a, sourceNames, now, onSelect, onBack }: Props & { selected: Asset }) {
  const groups = factsBySource(a, sourceNames, now);
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
  const events = feed.filter((e) => e.assetId === a.asset_id && isHeadline(e)).slice(0, 5);
  return (
    <>
      <div className="lm-hud-actions">
        <button type="button" className="btn" onClick={onBack}>Back</button>
      </div>
      {related.length > 0 && (
        <div>
          <h3 className="lm-hud-sec">{zone ? `With it in ${zone.name || zone.id}` : "Linked"}</h3>
          <ul className="lm-hud-related">
            {related.map((o) => (
              <li key={o.asset_id}>
                <button type="button" className={`lm-hud-chip lm-hud-chip--${stateKey(o.state)}`} onClick={() => onSelect(o.asset_id)}>
                  {assetName(o)} <span className="lm-hud-chip-kind">{FIGURE_LABELS[modelOf(o)].toLowerCase()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.source} aria-label={`From ${g.source}`}>
          <h3 className="lm-hud-sec">From {g.source}</h3>
          <dl className="lm-hud-facts">
            {g.facts.map((f) => (
              <div key={f.key} className="lm-hud-fact" title={f.key}>
                <dt>{f.label}</dt>
                <dd className="mono">{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <EventList events={events} onSelect={onSelect} assets={assets} empty="No changes to this record since the map opened." />
    </>
  );
}
