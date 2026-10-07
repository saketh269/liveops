// Notices on the live map that explain why assets are unplaced or grey, and fix
// the zone layout automatically from the data.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Asset, Mapping, Site, SiteLayout } from "../api/types";
import { appendMissingZones, buildAutoLayout, stateCoverage, zoneCoverage } from "./autoZones";
import { floorById, floorsOf } from "./floors";

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

export default function SetupHints({ site, assets, ready, onSite, onEditLayout, floorId }: Props) {
  const zones = useMemo(() => zoneCoverage(site.layout, assets.values()), [site.layout, assets]);
  const states = useMemo(() => stateCoverage(assets.values()), [assets]);
  const [created, setCreated] = useState<{ names: string[]; previous: SiteLayout } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);
  const [hideStates, setHideStates] = useState(false);
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
  useEffect(() => {
    if (!ready || autoTried.current || zones.missing.size === 0 || zones.used.size > 0 || protectedFloor) return;
    autoTried.current = true;
    void save(buildAutoLayout(site.layout, zones, floor.id), site.layout ?? {}, [...zones.missing.keys()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, zones]);

  if (!ready || assets.size === 0) return null;
  const missingCount = [...zones.missing.values()].reduce((a, b) => a + b, 0);
  const unrecognisedCount = [...states.unrecognised.values()].reduce((a, b) => a + b, 0);
  const incomplete = (mappings ?? []).filter((m) => m.active)
    .map((m) => ({ m, gaps: [!m.config.fields.zone && "Zone", !m.config.fields.state && "State"].filter(Boolean) as string[] }))
    .filter((x) => x.gaps.length > 0);

  return (
    <div className="lm-hints">
      {error && <div className="notice bad" role="alert">{error}</div>}
      {created && (
        <div className="notice info" role="status">
          Created {created.names.length} zone{created.names.length === 1 ? "" : "s"} from your data: {created.names.join(", ")}.{" "}
          <button type="button" className="btn lm-link-btn" onClick={onEditLayout}>Adjust layout</button>{" "}
          <button type="button" className="btn lm-link-btn" disabled={busy} onClick={() => void save(created.previous, created.previous, [])}>Undo</button>
        </div>
      )}
      {zones.missing.size > 0 && (zones.used.size > 0 || protectedFloor) && (
        <div className="notice">
          {missingCount} asset{missingCount === 1 ? " is" : "s are"} in zones that aren't on the map yet: {list(zones.missing)}.{" "}
          <button type="button" className="btn primary lm-link-btn" disabled={busy}
            onClick={() => void save(appendMissingZones(site.layout, zones, floor.id), site.layout ?? {}, [...zones.missing.keys()])}>
            Add {zones.missing.size === 1 ? "this zone" : `these ${zones.missing.size} zones`}{onFloorName}
          </button>
        </div>
      )}
      {(zones.noZone > 0 || states.noState > 0) && (
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
            <>In the <Link to="/mapping">mapping</Link>, set <strong>Zone</strong> to the column that says where each one is and <strong>State</strong> to the status column.</>
          )}
        </div>
      )}
      {states.unrecognised.size > 0 && !hideStates && (
        <div className="notice">
          {unrecognisedCount} asset{unrecognisedCount === 1 ? " is" : "s are"} grey because these state values aren't recognised: {list(states.unrecognised)}.
          {" "}In the <Link to="/mapping">mapping</Link>, translate each value to Free, In use, Cleaning or Alert.
          {" "}<button type="button" className="btn lm-link-btn" onClick={() => setHideStates(true)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
