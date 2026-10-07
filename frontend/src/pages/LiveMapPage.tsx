import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { Asset, Site } from "../api/types";
import { assetFloorId, assetsOnFloor, countByFloor, floorLayout, floorsOf, planView } from "../map/floors";
import FloorRail from "../map/hud/FloorRail";
import JourneyCard from "../map/hud/JourneyCard";
import KpiStrip from "../map/hud/KpiStrip";
import { kpiDefinitions } from "../map/hud/kpis";
import { byAgeDesc, problemTone, zoneOf, type Focus } from "../map/hud/model";
import { problemPins, problemsByFloor } from "../map/hud/pins";
import ProblemPins, { type Projector } from "../map/hud/ProblemPins";
import SideCard from "../map/hud/SideCard";
import LayoutEditor from "../map/LayoutEditor";
import Map2D from "../map/Map2D";
import MapView3D from "../map/MapView3D";
import SetupHints from "../map/SetupHints";
import { Legend } from "../map/panels";
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

/** Seconds since the epoch, refreshed every 15 s so ages move on even when no data arrives. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Page-level classes on <body>: the map fills the window; demo mode also hides the app's navigation. */
function useBodyClass(cls: string, on: boolean) {
  useEffect(() => {
    if (!on) return;
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [cls, on]);
}

function SiteMap({ siteId }: { siteId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const editing = params.get("edit") === "1";
  const debug = params.get("debug") === "1";
  const force2d = params.get("view") === "2d";
  const motion = params.get("motion") !== "off";
  // ?demo=1: a clean screen for showing the live map. Data stays live; setup and editing chrome go.
  const demo = params.get("demo") === "1";
  const [site, setSite] = useState<Site | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(() => (webglAvailable() ? null : "WebGL is not available in this browser."));
  const [selected, setSelected] = useState<string | null>(null);
  const [glide, setGlide] = useState<{ id: string; seq: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [project, setProject] = useState<Projector | null>(null);
  const [find, setFind] = useState("");
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  // Removed records still walking out keep their last data in the card.
  const [departing, setDeparting] = useState<ReadonlyMap<string, Asset>>(() => new Map());
  const live = useLiveSite(siteId);
  const { ui } = live;
  const now = Math.max(useNow(), live.receivedAt ? live.receivedAt / 1000 : 0);
  useBodyClass("lm-live-body", !editing);
  useBodyClass("lm-demo", demo && !editing);

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
  const selectedAsset = selected ? ui.assets.get(selected) ?? departing.get(selected) : undefined;

  // Floors (ADR 0006): one floor is shown at a time; ?floor=<id> keeps the choice in the link.
  const floors = useMemo(() => floorsOf(layout), [layout]);
  // Without ?floor the map opens on the ground floor (level 0), else the lowest one.
  const homeFloor = floors.find((f) => f.level === 0) ?? floors[0];
  const floor = floors.find((f) => f.id === params.get("floor")) ?? homeFloor;
  const floorId = floor.id;
  const viewLayout = useMemo(() => floorLayout(layout, floorId), [layout, floorId]);
  const plan = useMemo(() => planView(siteId, floorsOf(layout).find((f) => f.id === floorId)), [siteId, layout, floorId]);
  const floorAssets = useMemo(() => assetsOnFloor(layout, ui.assets, floorId), [layout, ui.assets, floorId]);
  const assetFilter = useCallback((m: ReadonlyMap<string, Asset>) => assetsOnFloor(layout, m, floorId), [layout, floorId]);
  const floorCounts = useMemo(() => countByFloor(layout, ui.assets.values()), [layout, ui.assets]);
  const floorProblems = useMemo(() => problemsByFloor(ui.assets.values(), (a) => assetFloorId(layout, a), now), [layout, ui.assets, now]);
  const tiles = useMemo(() => kpiDefinitions({ layout }, ui.assets, now), [layout, ui.assets, now]);
  const pins = useMemo(() => problemPins(viewLayout, floorAssets.values(), now), [viewLayout, floorAssets, now]);

  const setFloor = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === homeFloor.id) next.delete("floor"); else next.set("floor", id);
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
  /** Select and bring into view (KPI tiles, room chips, events, Find). */
  const show = (id: string) => {
    select(id);
    setGlide((g) => ({ id, seq: (g?.seq ?? 0) + 1 }));
  };
  /** A KPI tile: an asset, the worst asset in a zone, or (null) the whole floor. */
  const focus = (f: Focus | null) => {
    if (!f) {
      select(null);
      setFrame((n) => n + 1);
      return;
    }
    if ("assetId" in f) return show(f.assetId);
    const inZone = [...ui.assets.values()].filter((a) => zoneOf(layout, a)?.id === f.zoneId);
    const worst = inZone.filter((a) => problemTone(a, now)).sort(byAgeDesc(now))[0] ?? inZone.sort(byAgeDesc(now))[0];
    if (worst) show(worst.asset_id);
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

  if (editing) {
    return (
      <section className="lm-page">
        <header className="page-head lm-head"><h1>{site.name}: layout</h1></header>
        <LayoutEditor site={site} onSaved={setSite} onClose={() => setEdit(false)} initialFloorId={floorId} />
      </section>
    );
  }

  const st = STATUS[live.status];
  const assetIds = ui.assets.size <= 5000 ? [...ui.assets.values()] : [];

  return (
    <section className={`lm-live ${demo ? "lm-live--demo" : ""}`} aria-label={`Live map of ${site.name}`}>
      <div className="lm-hud-stage">
        {use2d ? (
          <Map2D
            layout={viewLayout}
            assets={floorAssets}
            plan={plan}
            selectedId={selected}
            onSelect={select}
            onHover={() => {}}
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
            viewKey={`${floorId}#${frame}`}
            stateRef={live.stateRef}
            listen={live.listen}
            selectedId={selected}
            onHover={() => {}}
            onSelect={select}
            onFail={(r) => setGlError(`The 3D view could not start (${r}).`)}
            debug={debug}
            motion={motion}
            onDeparting={setDeparting}
            onProject={(p) => setProject(() => p)}
            glide={glide}
          />
        )}
      </div>
      {!use2d && <ProblemPins pins={pins} project={project} onSelect={select} />}

      <div className="lm-hud">
        <div className="lm-hud-top">
          <div className="lm-glass lm-hud-brand">
            <span className="lm-hud-mark" aria-hidden="true" />
            <div>
              <h1>{site.name}</h1>
              <p>
                <span className="lm-hud-floorname">{floor.name}</span>
                <span className={`pill ${st.cls}`} role="status">{st.text}</span>
                <span className="mono" title="Last update">{live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString() : "no data yet"}</span>
              </p>
            </div>
          </div>
          <KpiStrip tiles={tiles} onFocus={focus} />
        </div>
        <div className="lm-glass lm-hud-tools" role="toolbar" aria-label="Map tools">
          {sites.length > 1 && !demo && (
            <label className="lm-inline-field">
              <span className="lm-sr">Site</span>
              <select value={siteId} onChange={(e) => navigate(`/map/${encodeURIComponent(e.target.value)}`)}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="lm-inline-field">
            <span className="lm-sr">Find asset</span>
            <input
              list="lm-asset-ids"
              value={find}
              placeholder="Find asset"
              onChange={(e) => {
                setFind(e.target.value);
                const v = e.target.value.trim().toLowerCase();
                const hit = [...ui.assets.values()].find((a) => a.asset_id.toLowerCase() === v || assetName(a).toLowerCase() === v);
                if (hit) show(hit.asset_id);
              }}
            />
          </label>
          <datalist id="lm-asset-ids">
            {assetIds.slice(0, 500).map((a) => <option key={a.asset_id} value={a.asset_id}>{assetName(a)}</option>)}
          </datalist>
          {!glError && (
            <button type="button" className="btn" onClick={() => {
              const next = new URLSearchParams(params);
              if (force2d) next.delete("view"); else next.set("view", "2d");
              setParams(next);
            }}>{force2d ? "3D" : "2D"}<span className="lm-sr"> view</span></button>
          )}
          <Legend assets={ui.assets} />
          {!demo && <button type="button" className="btn" onClick={() => setEdit(true)}>Edit layout</button>}
        </div>

        {floors.length > 1 && <FloorRail floors={floors} current={floorId} counts={floorCounts} problems={floorProblems} onChange={setFloor} />}
        {!demo && <SetupHints site={site} assets={ui.assets} ready={ui.snapshotReceived} onSite={setSite} onEditLayout={() => setEdit(true)} floorId={floorId} />}

        <div className="lm-hud-dock">
          <SideCard
            layout={layout}
            floor={floor}
            floorAssets={floorAssets}
            assets={ui.assets}
            feed={ui.feed}
            selected={selectedAsset}
            sourceNames={sourceNames}
            now={now}
            onSelect={show}
            onBack={() => { select(null); setFind(""); }}
          />
          <JourneyCard asset={selectedAsset} />
        </div>
      </div>
    </section>
  );
}
