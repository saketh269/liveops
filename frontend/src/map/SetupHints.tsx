// Notices on the live map that explain why assets are unplaced or grey, and fix
// the zone layout automatically from the data. Only actionable things open the card:
// movement-like or short-lived locations ("En route ED-07 → 4E-405A") are never
// offered as zones, and a dismissal is remembered per site until the notices change.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Asset, Mapping, Site, SiteLayout } from "../api/types";
import { appendMissingZones, buildAutoLayout, stateCoverage, zoneCoverage, type ZoneCoverage } from "./autoZones";
import { floorById, floorsOf } from "./floors";
import { isPatient, isStaff } from "./hud/model";
import { SETTLE_SECONDS, detailOnly, looksTransient, splitTransient } from "./labels";

type Props = {
  site: Site;
  assets: ReadonlyMap<string, Asset>;
  ready: boolean;
  onSite: (s: Site) => void;
  onEditLayout: () => void;
  /** Floor shown on the map; zones created here go on it. Default: the first floor. */
  floorId?: string;
};

const list = (m: Map<string, number>, max = 6) => {
  const items = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const shown = items.slice(0, max).map(([v, n]) => `${v} (${n})`).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
};

const DISMISS_KEY = (siteId: string) => `liveops.setup-dismissed.${siteId}`;

/** What was dismissed for this site (a signature of the notices), or null. Storage may be unavailable. */
function readDismissed(siteId: string): string | null {
  try { return window.localStorage.getItem(DISMISS_KEY(siteId)); } catch { return null; }
}

function writeDismissed(siteId: string, signature: string) {
  try { window.localStorage.setItem(DISMISS_KEY(siteId), signature); } catch { /* private window or blocked storage: dismissed for this visit only */ }
}

/** "3 people in transit", "1 record in transit". */
export function transitText(n: number, people: boolean): string {
  return `${n} ${people ? (n === 1 ? "person" : "people") : n === 1 ? "record" : "records"} in transit`;
}

/** Seconds since the epoch, ticking every `ms` while `on`. */
function useTick(on: boolean, ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

export default function SetupHints({ site, assets, ready, onSite, onEditLayout, floorId }: Props) {
  // Records that only add details to another one (a transport for a patient not on the map) are not placed on their own.
  const placed = useMemo(() => [...assets.values()].filter((a) => !detailOnly(a)), [assets]);
  const coverage = useMemo(() => zoneCoverage(site.layout, placed), [site.layout, placed]);
  const states = useMemo(() => stateCoverage(placed), [placed]);
  // When each unknown zone value was first seen: a value one record holds briefly is a passage, not a place.
  const firstSeen = useRef(new Map<string, number>());
  const fresh = [...coverage.missing.keys()].some((v) => !firstSeen.current.has(v) || Date.now() / 1000 - firstSeen.current.get(v)! < SETTLE_SECONDS);
  const now = Math.max(useTick(fresh), Date.now() / 1000);
  for (const v of coverage.missing.keys()) if (!firstSeen.current.has(v)) firstSeen.current.set(v, now);
  const split = splitTransient(coverage.missing, firstSeen.current, now);
  const zones: ZoneCoverage = { ...coverage, missing: split.places };
  const transientValues = new Set(split.transient.keys());
  const inTransit = placed.filter((a) => a.zone !== undefined && a.zone !== null && transientValues.has(String(a.zone).trim()));
  const transitPeople = inTransit.length > 0 && inTransit.every((a) => isPatient(a) || isStaff(a) || typeof a.role === "string");
  const [created, setCreated] = useState<{ names: string[]; previous: SiteLayout } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);
  const [hideStates, setHideStates] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed(site.id));
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});

  useEffect(() => {
    api.mappings(site.id).then(setMappings, () => setMappings(null));
    api.sources().then((l) => setSourceNames(Object.fromEntries(l.map((x) => [x.id, x.name]))), () => {});
  }, [site.id]);

  const save = async (layout: SiteLayout, previous: SiteLayout, names: string[]) => {
    setBusy(true);
    setError(null);
    try {
      onSite(await api.updateSite(site.id, { layout }));
      setCreated(names.length ? { names, previous } : null);
    } catch (e) {
      setError(`The zones could not be saved (${e instanceof Error ? e.message : String(e)}). Try again, or use Edit layout.`);
    } finally {
      setBusy(false);
    }
  };

  const floor = floorById(site.layout, floorId) ?? floorsOf(site.layout)[0];
  // A floor with a plan image was drawn on purpose: never replace its zones without asking.
  const protectedFloor = !!floor.plan;
  const onFloorName = floorsOf(site.layout).length > 1 ? ` to ${floor.name}` : "";

  // A layout where no zone matches the data is still the starting template: replace it
  // with zones built from the data once, without asking. Undo restores the old layout.
  // On a first layout every record's location counts (a single bed is still a room); only movement-like values are left out.
  const startZones: ZoneCoverage = { ...coverage, missing: new Map([...coverage.missing].filter(([v]) => !looksTransient(v))) };
  useEffect(() => {
    if (!ready || autoTried.current || startZones.missing.size === 0 || startZones.used.size > 0 || protectedFloor) return;
    autoTried.current = true;
    void save(buildAutoLayout(site.layout, startZones, floor.id), site.layout ?? {}, [...startZones.missing.keys()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, startZones.missing.size, startZones.used.size]);

  const dismiss = (signature: string) => {
    writeDismissed(site.id, signature);
    setDismissed(signature);
  };

  if (!ready) return null;
  if (assets.size === 0) {
    if (dismissed === "empty") return null;
    return (
      <Card onDismiss={() => dismiss("empty")}>
        <div className="notice info">
          No assets on this site yet. <Link to={`/sites/${encodeURIComponent(site.id)}/setup`}>Set up from a source</Link> to
          get suggestions, or <Link to={`/mapping/new?site=${encodeURIComponent(site.id)}`}>map a table by hand</Link>.
        </div>
      </Card>
    );
  }
  const missingCount = [...zones.missing.values()].reduce((a, b) => a + b, 0);
  const unrecognisedCount = [...states.unrecognised.values()].reduce((a, b) => a + b, 0);
  // Mappings that add details to another one (match_key differs from the ID) have no zone or state by design.
  const incomplete = (mappings ?? []).filter((m) => m.active && !(m.config.match_key && m.config.match_key !== m.config.id_field))
    .map((m) => ({ m, gaps: [!m.config.fields.zone && "Zone", !m.config.fields.state && "State"].filter(Boolean) as string[] }))
    .filter((x) => x.gaps.length > 0);
  const showMissing = zones.missing.size > 0 && (zones.used.size > 0 || protectedFloor);
  const showGaps = zones.noZone > 0 || states.noState > 0;
  const showStates = states.unrecognised.size > 0 && !hideStates;
  if (!error && !created && !showMissing && !showGaps && !showStates) return null;
  // The same notices as last dismissed stay away; new ones bring the card back.
  const signature = JSON.stringify([
    showMissing ? [...zones.missing.keys()].sort() : [],
    showGaps ? [zones.noZone > 0, states.noState > 0, incomplete.map((x) => x.m.id).sort()] : [],
    showStates ? [...states.unrecognised.keys()].sort() : [],
    created ? created.names : [],
  ]);
  if (!error && dismissed === signature) return null;

  return (
    <Card onDismiss={() => dismiss(signature)}>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {created && (
        <div className="notice info" role="status">
          Created {created.names.length} zone{created.names.length === 1 ? "" : "s"} from your data: {created.names.join(", ")}.{" "}
          <button type="button" className="btn lm-link-btn" onClick={onEditLayout}>Adjust layout</button>{" "}
          <button type="button" className="btn lm-link-btn" disabled={busy} onClick={() => void save(created.previous, created.previous, [])}>Undo</button>
        </div>
      )}
      {showMissing && (
        <div className="notice">
          {missingCount} asset{missingCount === 1 ? " is" : "s are"} in zones that aren't on the map yet: {list(zones.missing)}.{" "}
          <button type="button" className="btn primary lm-link-btn" disabled={busy}
            onClick={() => void save(appendMissingZones(site.layout, zones, floor.id), site.layout ?? {}, [...zones.missing.keys()])}>
            Add {zones.missing.size === 1 ? "this zone" : `these ${zones.missing.size} zones`}{onFloorName}
          </button>
        </div>
      )}
      {showGaps && (
        <div className="notice">
          {zones.noZone > 0 && <>{zones.noZone} asset{zones.noZone === 1 ? " has" : "s have"} no zone, so {zones.noZone === 1 ? "it sits" : "they sit"} in Unassigned. </>}
          {states.noState > 0 && <>{states.noState} asset{states.noState === 1 ? " has" : "s have"} no state, so {states.noState === 1 ? "it is" : "they are"} grey. </>}
          {incomplete.length > 0 ? (
            <ul>
              {incomplete.map(({ m, gaps }) => (
                <li key={m.id}>
                  <strong>{sourceNames[m.source_id] ?? "Source"}</strong> · <span className="mono">{m.dataset}</span>: {gaps.join(" and ")} not set.{" "}
                  {gaps.length === 2 && <>This table may not describe things on the map; check it's the one you meant. </>}
                  <Link to={`/mapping/${m.id}/edit`}>Fix this mapping</Link>
                </li>
              ))}
            </ul>
          ) : (
            <>In the <Link to="/mapping">mapping</Link>, set <strong>Zone</strong> to the column that says where each one is and <strong>State</strong> to the status column,
              or <Link to={`/sites/${encodeURIComponent(site.id)}/setup`}>set up from a source</Link> to get suggestions.</>
          )}
        </div>
      )}
      {inTransit.length > 0 && (
        <p className="lm-hints-transit">{transitText(inTransit.length, transitPeople)} (moving between places, so no zone is needed).</p>
      )}
      {showStates && (
        <div className="notice">
          {unrecognisedCount} asset{unrecognisedCount === 1 ? " is" : "s are"} grey because these state values aren't recognised: {list(states.unrecognised)}.
          {" "}In the <Link to="/mapping">mapping</Link>, translate each value to Free, In use, Cleaning or Alert.
          {" "}<button type="button" className="btn lm-link-btn" onClick={() => setHideStates(true)}>Dismiss</button>
        </div>
      )}
    </Card>
  );
}

/** The notices float over the map in one card that can be put away until the page is reloaded. */
function Card({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <section className="lm-glass lm-hud-hints" aria-labelledby="lm-hints-h">
      <div className="lm-hud-hints-head">
        <h2 id="lm-hints-h">Setup</h2>
        <button type="button" className="btn lm-link-btn" onClick={onDismiss} aria-label="Dismiss setup notices">Dismiss</button>
      </div>
      <div className="lm-hints">{children}</div>
    </section>
  );
}
