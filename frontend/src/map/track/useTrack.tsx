// History, route and live tracking for the selected record, wired into the live
// map page through a handful of nodes and callbacks (see LiveMapPage "track fix").
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Asset, Floor, SiteLayout } from "../../api/types";
import { assetFloorId } from "../floors";
import { assetName } from "../reducer";
import HistoryPanel, { sinceText, type HistoryFilter } from "./HistoryPanel";
import JourneyView from "./JourneyView";
import { buildRoute } from "./route";
import RouteOverlay, { type TrackHost } from "./RouteOverlay";
import { pushTrail, startTracking, trackStep, type TrackState, type TrailPoint } from "./tracking";
import { useAssetHistory } from "./useAssetHistory";
import "./track.css";

const NOTICE_MS = 6000;
const SAMPLE_MS = 300;

type Opts = {
  siteId: string;
  layout: SiteLayout;
  floors: Floor[];
  floorId: string;
  assets: ReadonlyMap<string, Asset>;
  selectedId: string | null;
  /** The selected record as the page has it (live, or still walking out). */
  selectedAsset: Asset | undefined;
  setFloor: (id: string) => void;
  now: number;
  /** The route and trail are drawn over the 3D view only. */
  is3d: boolean;
};

export function useTrack(o: Opts) {
  const { siteId, layout, floors, floorId, assets, selectedId, selectedAsset, now, is3d } = o;
  const [trackId, setTrackId] = useState<string | null>(null);
  const [host, setHost] = useState<TrackHost | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [showRoute, setShowRoute] = useState(false);
  const [notice, setNotice] = useState<{ text: string; n: number } | null>(null);
  const [tick, setTick] = useState(0);
  const state = useRef<TrackState | null>(null);
  const trail = useRef<TrailPoint[]>([]);
  const setFloor = useRef(o.setFloor);
  setFloor.current = o.setFloor;

  // The last data of the selected record, so its card and history stay open after it leaves the map.
  const lastKnown = useRef<Asset | undefined>(undefined);
  if (selectedAsset) lastKnown.current = selectedAsset;
  else if (lastKnown.current?.asset_id !== selectedId) lastKnown.current = undefined;
  const asset = selectedAsset ?? lastKnown.current;

  const history = useAssetHistory(siteId, selectedId, asset ? `${asset.updated_ts}|${assets.has(asset.asset_id)}` : null);

  const say = useCallback((text: string) => setNotice((n) => ({ text, n: (n?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const floorName = useCallback((id: string) => floors.find((f) => f.id === id)?.name ?? id, [floors]);

  const stop = useCallback(() => { setTrackId(null); state.current = null; trail.current = []; }, []);
  const toggle = () => {
    if (trackId) return stop();
    if (!selectedId) return;
    const a = assets.get(selectedId);
    state.current = startTracking(selectedId, a ? assetFloorId(layout, a) : null);
    trail.current = [];
    setTrackId(selectedId);
    if (a) {
      const fid = assetFloorId(layout, a);
      if (fid !== floorId) setFloor.current(fid);
      say(`Tracking ${assetName(a)}. Press Esc or Stop tracking to stop.`);
    }
  };
  // Selecting something else (or nothing) ends tracking.
  useEffect(() => { if (trackId && selectedId !== trackId) stop(); }, [selectedId, trackId, stop]);

  // Follow the record across floors; notice when it leaves the site.
  useEffect(() => {
    const st = state.current;
    if (!trackId || !st) return;
    const a = assets.get(trackId);
    const u = trackStep(st, a, Date.now() / 1000, (x) => assetFloorId(layout, x), floorName, a ? assetName(a) : asset ? assetName(asset) : trackId);
    state.current = u.next;
    if (u.switchTo) { trail.current = []; setFloor.current(u.switchTo); }
    if (u.notice) say(u.notice);
  }, [assets, trackId, layout, floorName, say, asset, tick]);
  // While the record is missing, keep checking (no data may arrive at all).
  const missing = !!trackId && !assets.has(trackId);
  useEffect(() => {
    if (!missing) return;
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [missing]);

  // The live trail: where the figure was drawn in the last few minutes on this floor.
  useEffect(() => { trail.current = []; }, [floorId]);
  useEffect(() => {
    if (!trackId || !host) return;
    const t = setInterval(() => {
      const p = host.positionOf(trackId);
      if (p && !p.leaving) trail.current = pushTrail(trail.current, { x: p.x, y: p.y, t: Date.now() / 1000 });
    }, SAMPLE_MS);
    return () => clearInterval(t);
  }, [trackId, host]);

  const entries = history.data?.entries;
  const route = useMemo(() => (showRoute && entries && selectedId ? buildRoute(layout, floorId, entries) : null), [showRoute, entries, layout, floorId, selectedId]);
  useEffect(() => { if (!selectedId) setShowRoute(false); }, [selectedId]);

  /** Esc: stop tracking first; returns true when it did. */
  const escape = useCallback(() => { if (!trackId) return false; stop(); say("Stopped tracking"); return true; }, [trackId, stop, say]);

  const tracking = !!trackId && trackId === selectedId;
  const gone = !!asset && !assets.has(asset.asset_id) && history.data?.present === false;

  const actions: ReactNode = selectedId ? (
    <div className="lm-track-actions">
      <button type="button" className={`btn ${tracking ? "primary" : ""}`} aria-pressed={tracking} onClick={toggle}
        title={tracking ? "Stop following (Esc)" : "Follow this record live, across floors"}>
        {tracking ? "Stop tracking" : "Track"}
      </button>
      {tracking && <span className="lm-track-live" aria-hidden="true">Following live · Esc stops</span>}
      {gone && <span className="lm-track-gone">No longer on the map</span>}
    </div>
  ) : null;

  const panel: ReactNode = selectedId ? (
    <HistoryPanel history={history} filter={filter} onFilter={setFilter} showRoute={showRoute} onShowRoute={setShowRoute}
      floorName={floorName(floorId)} canRoute={is3d} now={now} />
  ) : null;

  const journey: ReactNode = asset && history.data && history.data.asset_id === asset.asset_id
    ? <JourneyView asset={asset} history={history.data} now={now} />
    : asset && history.error ? <p className="lm-hud-empty">{history.error}</p> : undefined;

  const layer: ReactNode = (
    <>
      {is3d && <RouteOverlay host={host} route={route} trail={trail} trailOn={tracking} />}
      <div className={`lm-glass lm-track-notice ${notice ? "" : "lm-track-notice--off"}`} aria-live="polite">
        {notice?.text}
      </div>
    </>
  );

  return {
    /** Record for the cards: the selection, or its last data after it left. */
    asset,
    following: tracking && assets.has(trackId!),
    setHost,
    escape,
    actions,
    history: panel,
    journey,
    journeySub: history.data ? sinceText(history.data) : null,
    layer,
  };
}
