import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Asset, SiteLayout } from "../api/types";
import type { PlanView } from "./floors";
import { PlacementCache } from "./placement";
import type { MapState } from "./reducer";
import type { MapScene } from "./scene";
import type { MapCamera } from "./world/camera";
import type { FlushListener } from "./useLiveSite";
import type { TrackHost } from "./track/RouteOverlay"; // track fix

type Props = {
  layout: SiteLayout;
  stateRef: { current: MapState };
  listen: (fn: FlushListener) => () => void;
  selectedId: string | null;
  onHover: (id: string | null, x: number, y: number) => void;
  onSelect: (id: string | null) => void;
  /** WebGL could not start: the page switches to the 2D view. */
  onFail: (reason: string) => void;
  debug?: boolean;
  /** Floor plan image drawn on the floor. */
  plan?: PlanView | null;
  /** Narrows the live assets to what this view shows (e.g. one floor). Keep it stable (useCallback). */
  assetFilter?: (assets: ReadonlyMap<string, Asset>) => ReadonlyMap<string, Asset>;
  /** Changing this re-frames the camera (e.g. the floor id). */
  viewKey?: string;
  /** False (?motion=off) makes every change jump instead of walking. */
  motion?: boolean;
  /** Removed records still walking out, with their final data (for the details panel). */
  onDeparting?: (assets: Map<string, Asset>) => void;
  // --- scene hook (ADR 0007): camera presets. Keep minimal. ---
  /** Zone id to fly the camera to (e.g. a room picked in a panel); changing it flies again. */
  focusZone?: string | null;
  /** Filled with the camera handle (flyTo, flyToZone, reset, view) while the 3D scene runs; null otherwise. */
  cameraRef?: MutableRefObject<MapCamera | null>;
  // --- end scene hook ---
  // --- ui-shell hook (ADR 0007): HUD pins and camera glide. Keep minimal. ---
  /** Gets a projector (asset id → page coordinates of its figure) while the scene runs; null when it stops. */
  onProject?: (screenOf: ((id: string) => { x: number; y: number } | null) | null) => void;
  /** Each new value eases the camera onto that (selected) asset once. */
  glide?: { id: string; seq: number } | null;
  // --- end ui-shell hook ---
  // --- track fix: live tracking keeps the camera on the selected figure; the overlay gets point projection ---
  track?: boolean;
  onTrackHost?: (host: TrackHost | null) => void;
  // --- end track fix ---
};

declare global {
  interface Window {
    __liveopsMap?: Record<string, unknown>;
  }
}

/** Hosts the Three.js scene. Asset updates bypass React and go straight to the scene. */
export default function MapView3D({ layout, stateRef, listen, selectedId, onHover, onSelect, onFail, debug, plan, assetFilter, viewKey, motion = true, onDeparting, focusZone, cameraRef, onProject, glide, track, onTrackHost }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<MapScene | null>(null);
  const [follow, setFollow] = useState(false);
  const [gliding, setGliding] = useState(false);
  const projectRef = useRef(onProject);
  projectRef.current = onProject;
  const cbRef = useRef({ onHover, onSelect, onFail, onDeparting });
  cbRef.current = { onHover, onSelect, onFail, onDeparting };

  useEffect(() => {
    let disposed = false;
    let s: MapScene | null = null;
    import("./scene")
      .then(({ MapScene }) => {
        if (disposed || !hostRef.current || !labelsRef.current) return;
        try {
          s = new MapScene(hostRef.current, labelsRef.current, {
            onHover: (id, x, y) => cbRef.current.onHover(id, x, y),
            onSelect: (id) => cbRef.current.onSelect(id),
            onDeparting: (m) => cbRef.current.onDeparting?.(m),
          });
          setScene(s);
        } catch (e) {
          cbRef.current.onFail(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e) => cbRef.current.onFail(`Could not load the 3D engine: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      disposed = true;
      s?.dispose();
      setScene(null);
    };
  }, []);

  useEffect(() => {
    if (!scene) return;
    const cache = new PlacementCache();
    // The first snapshot this view sees is placed instantly: no mass walk-in.
    let primed = false;
    const push = (st: MapState) => {
      const assets = assetFilter ? assetFilter(st.assets) : st.assets;
      const placement = cache.get(layout, assets.values());
      scene.setLayout(layout, placement.unassigned);
      scene.setAssets(assets, placement, !primed);
      if (st.snapshotReceived) primed = true;
    };
    push(stateRef.current);
    const off = listen(push);
    if (debug) {
      window.__liveopsMap = {
        ready: true,
        stats: () => scene.stats(),
        colorOf: (id: string) => scene.colorOf(id),
        screenOf: (id: string) => scene.screenOf(id),
        positionOf: (id: string) => scene.positionOf(id),
        roomTintOf: (zoneId: string) => scene.roomTintOf(zoneId),
        flyTo: (x: number, y: number, zoom?: number) => scene.flyTo([x, y], zoom),
        flyToZone: (zoneId: string) => scene.flyToZone(zoneId),
        view: () => scene.view(),
        assetCount: () => stateRef.current.assets.size,
      };
    }
    return () => {
      off();
      if (debug) delete window.__liveopsMap;
    };
  }, [scene, layout, listen, stateRef, debug, assetFilter]);

  const framedKey = useRef(viewKey);
  useEffect(() => {
    if (!scene || framedKey.current === viewKey) return;
    framedKey.current = viewKey;
    scene.resetCamera();
  }, [scene, viewKey]);

  useEffect(() => { scene?.setPlan(plan ?? null); }, [scene, plan]);

  useEffect(() => { scene?.setSelected(selectedId); }, [scene, selectedId]);
  // scene hook: fly to a picked zone; hand the camera handle out while the scene runs.
  useEffect(() => { if (focusZone) scene?.flyToZone(focusZone); }, [scene, focusZone]);
  useEffect(() => {
    if (!cameraRef) return;
    cameraRef.current = scene;
    return () => { cameraRef.current = null; };
  }, [scene, cameraRef]);
  // --- end scene hook ---
  useEffect(() => { scene?.setMotionAllowed(motion); }, [scene, motion]);
  // ui-shell hook: hand the projector to the HUD; a glide follows the asset briefly.
  useEffect(() => {
    if (!scene) return;
    projectRef.current?.((id) => scene.screenOf(id));
    return () => projectRef.current?.(null);
  }, [scene]);
  useEffect(() => {
    if (!scene || !glide) return;
    scene.setSelected(glide.id);
    setGliding(true);
    const t = setTimeout(() => setGliding(false), 1200);
    return () => clearTimeout(t);
  }, [scene, glide]);
  // --- track fix ---
  const trackHostRef = useRef(onTrackHost);
  trackHostRef.current = onTrackHost;
  useEffect(() => {
    if (!scene) return;
    trackHostRef.current?.({ screenOfPoint: (x, y) => scene.screenOfPoint(x, y), positionOf: (id) => scene.positionOf(id) });
    return () => trackHostRef.current?.(null);
  }, [scene]);
  const following = (follow || gliding || !!track) && !!selectedId;
  // --- end track fix ---
  useEffect(() => { scene?.setFollow(following); }, [scene, following]);

  return (
    <div className="lm-viewport">
      <div
        ref={hostRef}
        className="lm-canvas-host"
        tabIndex={0}
        role="application"
        aria-roledescription="3D map"
        aria-label="3D site map. Drag to rotate, scroll to zoom, right-drag or arrow keys to pan. Use Find asset to select an asset with the keyboard."
      />
      <div ref={labelsRef} className="lm-labels" aria-hidden="true" />
      <div className="lm-view-controls" role="group" aria-label="Camera">
        <button type="button" className="btn" onClick={() => scene?.zoom(0.8)} aria-label="Zoom in" disabled={!scene}>+</button>
        <button type="button" className="btn" onClick={() => scene?.zoom(1.25)} aria-label="Zoom out" disabled={!scene}>−</button>
        <button type="button" className="btn" onClick={() => scene?.rotate(-Math.PI / 8)} aria-label="Rotate left" disabled={!scene}>⟲</button>
        <button type="button" className="btn" onClick={() => scene?.rotate(Math.PI / 8)} aria-label="Rotate right" disabled={!scene}>⟳</button>
        <button
          type="button"
          className="btn"
          aria-pressed={following}
          onClick={() => setFollow((v) => !v)}
          disabled={!scene || !selectedId}
          title={selectedId ? "Keep the selected asset in view as it moves" : "Select an asset to follow it"}
        >Follow</button>
        <button type="button" className="btn" onClick={() => { setFollow(false); scene?.resetCamera(); }} disabled={!scene}>Reset view</button>
      </div>
      {!scene && <p className="lm-loading muted">Loading 3D view…</p>}
    </div>
  );
}
