import { useEffect, useRef, useState } from "react";
import type { Asset, SiteLayout } from "../api/types";
import type { PlanView } from "./floors";
import { PlacementCache } from "./placement";
import type { MapState } from "./reducer";
import type { MapScene } from "./scene";
import type { FlushListener } from "./useLiveSite";

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
};

declare global {
  interface Window {
    __liveopsMap?: Record<string, unknown>;
  }
}

/** Hosts the Three.js scene. Asset updates bypass React and go straight to the scene. */
export default function MapView3D({ layout, stateRef, listen, selectedId, onHover, onSelect, onFail, debug, plan, assetFilter, viewKey }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<MapScene | null>(null);
  const cbRef = useRef({ onHover, onSelect, onFail });
  cbRef.current = { onHover, onSelect, onFail };

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
    const push = (st: MapState) => {
      const assets = assetFilter ? assetFilter(st.assets) : st.assets;
      const placement = cache.get(layout, assets.values());
      scene.setLayout(layout, placement.unassigned);
      scene.setAssets(assets, placement);
    };
    push(stateRef.current);
    const off = listen(push);
    if (debug) {
      window.__liveopsMap = {
        ready: true,
        stats: () => scene.stats(),
        colorOf: (id: string) => scene.colorOf(id),
        screenOf: (id: string) => scene.screenOf(id),
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
        <button type="button" className="btn" onClick={() => scene?.resetCamera()} disabled={!scene}>Reset view</button>
      </div>
      {!scene && <p className="lm-loading muted">Loading 3D view…</p>}
    </div>
  );
}
