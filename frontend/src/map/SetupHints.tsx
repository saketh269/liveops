// Notices on the live map that explain why assets are unplaced or grey, and fix
// the zone layout automatically from the data.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Asset, Site, SiteLayout } from "../api/types";
import { appendMissingZones, buildAutoLayout, stateCoverage, zoneCoverage } from "./autoZones";

type Props = {
  site: Site;
  assets: ReadonlyMap<string, Asset>;
  ready: boolean;
  onSite: (s: Site) => void;
  onEditLayout: () => void;
};

const list = (m: Map<string, number>, max = 6) => {
  const items = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const shown = items.slice(0, max).map(([v, n]) => `${v} (${n})`).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
};

export default function SetupHints({ site, assets, ready, onSite, onEditLayout }: Props) {
  const zones = useMemo(() => zoneCoverage(site.layout, assets.values()), [site.layout, assets]);
  const states = useMemo(() => stateCoverage(assets.values()), [assets]);
  const [created, setCreated] = useState<{ names: string[]; previous: SiteLayout } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);
  const [hideStates, setHideStates] = useState(false);

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

  // A layout where no zone matches the data is still the starting template: replace it
  // with zones built from the data once, without asking. Undo restores the old layout.
  useEffect(() => {
    if (!ready || autoTried.current || zones.missing.size === 0 || zones.used.size > 0) return;
    autoTried.current = true;
    void save(buildAutoLayout(site.layout, zones), site.layout ?? {}, [...zones.missing.keys()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, zones]);

  if (!ready || assets.size === 0) return null;
  const missingCount = [...zones.missing.values()].reduce((a, b) => a + b, 0);
  const grey = states.total - states.colored;

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
      {zones.missing.size > 0 && zones.used.size > 0 && (
        <div className="notice">
          {missingCount} asset{missingCount === 1 ? " is" : "s are"} in zones that aren't on the map yet: {list(zones.missing)}.{" "}
          <button type="button" className="btn primary lm-link-btn" disabled={busy}
            onClick={() => void save(appendMissingZones(site.layout, zones), site.layout ?? {}, [...zones.missing.keys()])}>
            Add {zones.missing.size === 1 ? "this zone" : `these ${zones.missing.size} zones`}
          </button>
        </div>
      )}
      {zones.noZone > 0 && (
        <div className="notice">
          {zones.noZone} asset{zones.noZone === 1 ? " has" : "s have"} no zone, so {zones.noZone === 1 ? "it sits" : "they sit"} in Unassigned.{" "}
          In the <Link to="/mapping">mapping</Link>, set <strong>Zone</strong> to the column that says where each one is (for example a unit or ward).
        </div>
      )}
      {grey > 0 && !hideStates && (
        <div className="notice">
          {grey} asset{grey === 1 ? " is" : "s are"} grey because{" "}
          {states.noState === states.total
            ? <>no state column is mapped. In the <Link to="/mapping">mapping</Link>, set <strong>State</strong> to the status column.</>
            : <>{states.unrecognised.size > 0 ? <>these state values aren't recognised: {list(states.unrecognised)}</> : "they have no state value"}.
                {" "}In the <Link to="/mapping">mapping</Link>, translate each value to Free, In use, Cleaning or Alert.</>}
          {" "}<button type="button" className="btn lm-link-btn" onClick={() => setHideStates(true)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
