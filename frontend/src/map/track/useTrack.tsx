// History, route and live tracking for the selected record, wired into the live
// map page through a handful of nodes and callbacks (see LiveMapPage "track fix").
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Asset, Floor, SiteLayout } from "../../api/types";
import { assetName } from "../reducer";
import HistoryPanel, { sinceText, type HistoryFilter } from "./HistoryPanel";
import JourneyView from "./JourneyView";
import { buildRoute } from "./route";
import RouteOverlay, { type TrackHost } from "./RouteOverlay";
import { placeOf, pushTrail, startTracking, trackStep, type TrackState, type TrailPoint } from "./tracking";
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
};

export function useTrack(o: Opts) {
  const { siteId, layout, floors, floorId, assets, selectedId, selectedAsset, now } = o;
  const [trackId, setTrackId] = useState<string | null>(null);
  const [host, setHost] = useState<TrackHost | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [showRoute, setShowRoute] = useState(false);
  const [notice, setNotice] = useState<{ text: string; n: number } | null>(null);
  const [tick, setTick] = useState(0);
  /** The user is looking at another floor than the tracked record's: following pauses. */
  const [away, setAway] = useState(false);
  /** Where the record is when the floor plan does not show it (null: on the plan). */
  const [offPlan, setOffPlan] = useState<string | null>(null);
  /** Bumped when the camera should glide to the record (new floor, arrival, return). */
  const [refocus, setRefocus] = useState(0);
  const state = useRef<TrackState | null>(null);
  /** Floor the tracker wants shown (the record's floor). */
  const wanted = useRef<string | null>(null);
  const floorNow = useRef(floorId);
  floorNow.current = floorId;
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

  const stop = useCallback(() => {
    setTrackId(null); setAway(false); setOffPlan(null);
    state.current = null; wanted.current = null; trail.current = [];
  }, []);
  /** Show the tracked record's floor (the tracker's own floor changes never count as the user looking away). */
  const showFloor = useCallback((fid: string | null) => {
    wanted.current = fid;
    if (fid !== null && fid !== floorNow.current) setFloor.current(fid);
    setRefocus((n) => n + 1);
  }, []);
  const toggle = useCallback(() => {
    if (trackId) return stop();
    if (!selectedId) return;
    const a = assets.get(selectedId);
    const p = a ? placeOf(layout, a) : null;
    state.current = startTracking(selectedId, p);
    trail.current = [];
    setTrackId(selectedId);
    setAway(false);
    setOffPlan(p && !p.onPlan ? p.where : null);
    showFloor(p?.floorId ?? floorNow.current);
    if (a) say(`Tracking ${assetName(a)}${p && !p.onPlan ? `, who is ${p.where}` : ""}. Press Esc or Stop tracking to stop.`);
  }, [trackId, selectedId, assets, layout, stop, showFloor, say]);
  // Selecting something else (or nothing) ends tracking.
  useEffect(() => { if (trackId && selectedId !== trackId) stop(); }, [selectedId, trackId, stop]);

  // Follow the record across floors (unless the user is looking at another floor), say
  // where it is when the plan does not show it, and stop when it leaves the site.
  useEffect(() => {
    const st = state.current;
    if (!trackId || !st) return;
    const a = assets.get(trackId);
    const name = a ? assetName(a) : asset ? assetName(asset) : trackId;
    const u = trackStep(st, a, Date.now() / 1000, (x) => placeOf(layout, x), floorName, name);
    if (u.stop) { stop(); if (u.notice) say(u.notice); return; }
    state.current = u.next;
    if (u.next !== st) setOffPlan(u.next.onPlan ? null : u.next.where);
    if (u.next.onPlan && !st.onPlan && !u.switchTo && !away) setRefocus((n) => n + 1); // arrived on this floor
    if (u.switchTo) {
      if (away) {
        wanted.current = u.switchTo;
        const what = u.next.onPlan ? `moved to ${floorName(u.switchTo)}` : `is ${u.next.where}`;
        say(`${name} ${what}. Press Return to ${returnNoun(a)} to follow.`);
        return;
      }
      trail.current = [];
      showFloor(u.switchTo);
    }
    if (u.notice) say(u.notice);
  }, [assets, trackId, layout, floorName, say, asset, tick, away, stop, showFloor]);
  // Picking another floor while tracking pauses following instead of fighting the user.
  useEffect(() => {
    if (!trackId) return;
    setAway(wanted.current !== null && floorId !== wanted.current);
  }, [floorId, trackId]);
  const returnTo = useCallback(() => {
    setAway(false);
    showFloor(wanted.current);
  }, [showFloor]);
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
      {tracking && !away && <span className="lm-track-live" aria-hidden="true">Following live · Esc stops</span>}
      {tracking && away && (
        <>
          <button type="button" className="btn lm-track-return" onClick={returnTo}>Return to {returnNoun(assets.get(trackId!) ?? asset)}</button>
          <span className="lm-track-live">Paused while you look at {floorName(floorId)}</span>
        </>
      )}
      {tracking && offPlan && <span className="lm-track-where">{sentence(offPlan)} · not on the floor plan</span>}
      {gone && <span className="lm-track-gone">No longer on the map</span>}
    </div>
  ) : null;

  const panel: ReactNode = selectedId ? (
    <HistoryPanel history={history} filter={filter} onFilter={setFilter} showRoute={showRoute} onShowRoute={setShowRoute}
      floorName={floorName(floorId)} canRoute now={now} />
  ) : null;

  const journey: ReactNode = asset && history.data && history.data.asset_id === asset.asset_id
    ? <JourneyView asset={asset} history={history.data} now={now} />
    : asset && history.error ? <p className="lm-hud-empty">{history.error}</p> : undefined;

  const layer: ReactNode = (
    <>
      <RouteOverlay host={host} route={route} trail={trail} trailOn={tracking} />
      <div className={`lm-glass lm-track-notice ${notice ? "" : "lm-track-notice--off"}`} aria-live="polite">
        {notice?.text}
      </div>

    </>
  );

  return {
    /** Record for the cards: the selection, or its last data after it left. */
    asset,
    following: tracking && !away && assets.has(trackId!),
    /** Each new value: the camera should glide to the record. */
    refocus,
    /** Start or stop tracking the selection (the Track button and the camera's Follow button). */
    toggle,
    setHost,
    escape,
    actions,
    history: panel,
    journey,
    journeySub: history.data ? sinceText(history.data) : null,
    layer,
  };
}

/** "patient" for a patient, else the record's name: "Return to patient", "Return to Nurse Ada". */
function returnNoun(a: Asset | undefined): string {
  if (!a) return "record";
  return (a.kind ?? "").toLowerCase() === "patient" ? "patient" : assetName(a);
}

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
