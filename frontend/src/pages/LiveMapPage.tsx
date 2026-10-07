import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { Asset, Site } from "../api/types";
import FloorSwitcher from "../map/FloorSwitcher";
import { assetFloorId, assetsOnFloor, countByFloor, floorLayout, floorsOf, planView } from "../map/floors";
import LayoutEditor from "../map/LayoutEditor";
import Map2D from "../map/Map2D";
import MapView3D from "../map/MapView3D";
import SetupHints from "../map/SetupHints";
import { AssetDetails, EventFeed, KpiPanel, Legend } from "../map/panels";
import { assetName } from "../map/reducer";
import { webglAvailable } from "../map/webgl";
import { useLiveSite, type LinkStatus } from "../map/useLiveSite";
import "../map/map.css";

function errorText(e: unknown, what: string): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return `${what} was not found. It may have been deleted; pick another site.`;
    return `${what} could not be loaded: ${e.message}.${e.hint ? ` ${e.hint}` : ""}`;
  }
  return `${what} could not be loaded (${e instanceof Error ? e.message : String(e)}). Check that the Live Ops backend is running, then reload.`;
}

export default function LiveMapPage() {
  const { siteId } = useParams();
  return siteId ? <SiteMap key={siteId} siteId={siteId} /> : <SitePicker />;
}

function SitePicker() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.sites().then(setSites, (e) => setError(errorText(e, "The site list")));
  }, []);
  return (
    <section className="lm-page">
      <div className="page-head"><h1>Live map</h1></div>
      <p className="muted">Pick a site to watch its assets live.</p>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {!sites && !error && <p className="muted">Loading sites…</p>}
      {sites && sites.length === 0 && (
        <div className="notice info">No sites yet. <Link to="/sites">Create a site</Link>, then map a source to it.</div>
      )}
      {sites && sites.length > 0 && (
        <ul className="lm-site-list">
          {sites.map((s) => (
            <li key={s.id}>
              <Link className="panel lm-site-card" to={`/map/${encodeURIComponent(s.id)}`}>
                <strong>{s.name}</strong>
                <span className="muted lm-small">
                  {s.template}
                  {(s.layout?.floors?.length ?? 0) > 1 && <> · {s.layout.floors!.length} floors</>}
                  {" · "}{(s.layout?.zones ?? []).length} zones
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS: Record<LinkStatus, { cls: string; text: string }> = {
  connecting: { cls: "info", text: "Connecting" },
  live: { cls: "ok", text: "Live" },
  reconnecting: { cls: "warn", text: "Reconnecting" },
};

function SiteMap({ siteId }: { siteId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const editing = params.get("edit") === "1";
  const debug = params.get("debug") === "1";
  const force2d = params.get("view") === "2d";
  const motion = params.get("motion") !== "off";
  const [site, setSite] = useState<Site | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(() => (webglAvailable() ? null : "WebGL is not available in this browser."));
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  // Removed records still walking out keep their last data in the details panel.
  const [departing, setDeparting] = useState<ReadonlyMap<string, Asset>>(() => new Map());
  const live = useLiveSite(siteId);
  const { ui } = live;

  useEffect(() => {
    api.site(siteId).then(setSite, (e) => setError(errorText(e, `Site "${siteId}"`)));
    api.sites().then(setSites, () => setSites([]));
    // Show source names, not ids, in the feed and details.
    api.sources().then((list) => setSourceNames(Object.fromEntries(list.map((s) => [s.id, s.name]))), () => {});
  }, [siteId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const layout = useMemo(() => site?.layout ?? {}, [site]);
  const use2d = force2d || glError !== null;
  const recordOf = (id: string | null) => (id ? ui.assets.get(id) ?? departing.get(id) : undefined);
  const shown = recordOf(selected) || recordOf(hover) || null;

  // Floors (ADR 0006): one floor is shown at a time; ?floor=<id> keeps the choice in the link.
  const floors = useMemo(() => floorsOf(layout), [layout]);
  const floor = floors.find((f) => f.id === params.get("floor")) ?? floors[0];
  const floorId = floor.id;
  const viewLayout = useMemo(() => floorLayout(layout, floorId), [layout, floorId]);
  const plan = useMemo(() => planView(siteId, floorsOf(layout).find((f) => f.id === floorId)), [siteId, layout, floorId]);
  const floorAssets = useMemo(() => assetsOnFloor(layout, ui.assets, floorId), [layout, ui.assets, floorId]);
  const assetFilter = useCallback((m: ReadonlyMap<string, Asset>) => assetsOnFloor(layout, m, floorId), [layout, floorId]);
  const floorCounts = useMemo(() => (floors.length > 1 ? countByFloor(layout, ui.assets.values()) : null), [floors, layout, ui.assets]);

  const setFloor = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === floors[0].id) next.delete("floor"); else next.set("floor", id);
    setParams(next, { replace: true });
  };
  /** Select an asset; on a multi-floor site the map moves to the asset's floor. */
  const select = (id: string | null) => {
    setSelected(id);
    const a = id ? ui.assets.get(id) : undefined;
    if (a && floors.length > 1) {
      const fid = assetFloorId(layout, a);
      if (fid !== floorId) setFloor(fid);
    }
  };

  const setEdit = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set("edit", "1"); else next.delete("edit");
    setParams(next);
  };

  if (error) {
    return (
      <section className="lm-page">
        <div className="page-head"><h1>Live map</h1></div>
        <div className="notice bad" role="alert">{error}</div>
        <p><Link to="/map">Choose another site</Link></p>
      </section>
    );
  }
  if (!site) return <section className="lm-page"><p className="muted">Loading site…</p></section>;

  const st = STATUS[live.status];
  const assetIds = ui.assets.size <= 5000 ? [...ui.assets.values()] : [];

  return (
    <section className="lm-page">
      <header className="page-head lm-head">
        <div>
          <h1>{site.name}{editing ? ": layout" : ""}</h1>
          <p className="muted lm-small lm-meta">
            <span className={`pill ${st.cls}`} role="status">{st.text}</span>
            <span>
              Last update{" "}
              <span className="mono">{live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString() : "none yet"}</span>
            </span>
          </p>
        </div>
        <div className="lm-head-actions">
          {sites.length > 1 && (
            <label className="lm-inline-field">
              <span className="muted">Site</span>
              <select value={siteId} onChange={(e) => navigate(`/map/${encodeURIComponent(e.target.value)}`)}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {!editing && <button type="button" className="btn" onClick={() => setEdit(true)}>Edit layout</button>}
        </div>
      </header>

      {editing ? (
        <LayoutEditor site={site} onSaved={setSite} onClose={() => setEdit(false)} initialFloorId={floorId} />
      ) : (
        <div className="lm-grid">
          <div className="lm-main">
            {ui.snapshotReceived && ui.assets.size === 0 && (
              <div className="notice info">
                No assets on this site yet. <Link to={`/sites/${encodeURIComponent(site.id)}/setup`}>Set up from a source</Link> to
                get suggestions, or <Link to={`/mapping/new?site=${encodeURIComponent(site.id)}`}>map a table by hand</Link>.
              </div>
            )}
            <SetupHints site={site} assets={ui.assets} ready={ui.snapshotReceived} onSite={setSite} onEditLayout={() => setEdit(true)} floorId={floorId} />
            {floors.length > 1 && <FloorSwitcher floors={floors} current={floorId} counts={floorCounts} onChange={setFloor} />}
            <div className="lm-stage">
              {use2d ? (
                <Map2D
                  layout={viewLayout}
                  assets={floorAssets}
                  plan={plan}
                  selectedId={selected}
                  onSelect={select}
                  onHover={(id) => setHover(id)}
                  motion={motion}
                  ready={ui.snapshotReceived}
                  onDeparting={setDeparting}
                  reason={force2d ? "selected with ?view=2d." : `${glError} Showing a top view instead.`}
                />
              ) : (
                <MapView3D
                  layout={viewLayout}
                  plan={plan}
                  assetFilter={floors.length > 1 ? assetFilter : undefined}
                  viewKey={floorId}
                  stateRef={live.stateRef}
                  listen={live.listen}
                  selectedId={selected}
                  onHover={(id) => setHover(id)}
                  onSelect={select}
                  onFail={(r) => setGlError(`The 3D view could not start (${r}).`)}
                  debug={debug}
                  motion={motion}
                  onDeparting={setDeparting}
                />
              )}
              {shown && (
                <div className={`lm-details-wrap ${selected ? "lm-details-wrap--pinned" : ""}`}>
                  <AssetDetails asset={shown} layout={layout} pinned={!!selected} onClose={() => setSelected(null)} sourceNames={sourceNames} />
                </div>
              )}
            </div>
            <div className="lm-toolbar">
              <label className="lm-inline-field">
                <span className="muted">Find asset</span>
                <input
                  list="lm-asset-ids"
                  value={find}
                  placeholder="id or label"
                  onChange={(e) => {
                    setFind(e.target.value);
                    const v = e.target.value.trim().toLowerCase();
                    const hit = [...ui.assets.values()].find((a) => a.asset_id.toLowerCase() === v || assetName(a).toLowerCase() === v);
                    if (hit) select(hit.asset_id);
                  }}
                />
              </label>
              <datalist id="lm-asset-ids">
                {assetIds.slice(0, 500).map((a) => <option key={a.asset_id} value={a.asset_id}>{assetName(a)}</option>)}
              </datalist>
              {selected && <button type="button" className="btn" onClick={() => { setSelected(null); setFind(""); }}>Clear selection</button>}
              {!glError && (
                <button type="button" className="btn" onClick={() => {
                  const next = new URLSearchParams(params);
                  if (force2d) next.delete("view"); else next.set("view", "2d");
                  setParams(next);
                }}>{force2d ? "3D view" : "2D view"}</button>
              )}
            </div>
          </div>
          <div className="lm-side">
            <KpiPanel layout={layout} assets={ui.assets} floor={floors.length > 1 ? { name: floors.find((f) => f.id === floorId)?.name ?? "", layout: viewLayout, assets: floorAssets } : undefined} />
            <Legend />
            <EventFeed feed={ui.feed} onSelect={select} sourceNames={sourceNames} />
          </div>
        </div>
      )}
    </section>
  );
}
