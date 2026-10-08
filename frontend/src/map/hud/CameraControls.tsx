// On-screen camera controls (camera fix): rotate, tilt, zoom, reset, a compass that
// shows where north is (click: face north), Follow and "Resume tracking". Used by the
// 3D view and by the 2D fallback (no tilt there). Rendered into the HUD slot when the
// page gives one, so it takes its own place among the cards on phones.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./camera.css";

/** Camera state the controls draw (angles in radians). */
export type CameraControlsState = { azimuth: number; following: boolean; paused: boolean };

/** What the controls drive: the 3D scene (MapScene) or the 2D view. */
export type CameraControlsHandle = {
  /** `factor` < 1 zooms in. */
  zoom(factor: number): void;
  /** Positive turns the map clockwise. */
  rotate(radians: number): void;
  /** Positive tilts towards the horizon. Absent: no tilt (2D). */
  tilt?(radians: number): void;
  faceNorth(): void;
  reset(): void;
  resumeFollow?(): void;
  onCameraChange(fn: (s: CameraControlsState) => void): () => void;
};

type Props = {
  camera: CameraControlsHandle | null;
  /** Follow toggle (3D, with a selection). */
  follow?: { on: boolean; enabled: boolean; toggle: () => void };
  /** HUD slot to render into; null/undefined renders in place. */
  host?: HTMLElement | null;
};

const ROTATE_STEP = Math.PI / 8;
const TILT_STEP = Math.PI / 18;

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

/** Compass bearing text: how far the map is turned from north-up. */
export function bearingText(azimuth: number): string {
  const deg = Math.round(((((azimuth * 180) / Math.PI) % 360) + 360) % 360);
  if (deg === 0 || deg === 360) return "North is up";
  return deg <= 180 ? `Map turned ${deg}° clockwise` : `Map turned ${360 - deg}° anticlockwise`;
}

export default function CameraControls({ camera, follow, host }: Props) {
  const needle = useRef<SVGGElement>(null);
  const compass = useRef<HTMLButtonElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!camera) return;
    let label = "";
    return camera.onCameraChange((s) => {
      // The needle moves every frame while the user turns: write the DOM, not React state.
      needle.current?.setAttribute("transform", `rotate(${((s.azimuth * 180) / Math.PI).toFixed(2)} 10 10)`);
      const text = `Compass: ${bearingText(s.azimuth)}. Turn to face north`;
      if (text !== label && compass.current) {
        label = text;
        compass.current.setAttribute("aria-label", text);
        compass.current.title = text;
      }
      setPaused(s.following && s.paused);
    });
  }, [camera]);

  const off = !camera;
  const ui = (
    <div className="lm-cam lm-glass" role="group" aria-label="Camera">
      {paused && follow?.on && camera?.resumeFollow && (
        <button type="button" className="btn primary lm-cam-resume" onClick={() => camera.resumeFollow?.()}>
          Resume tracking
        </button>
      )}
      <div className={`lm-cam-grid ${camera?.tilt ? "" : "lm-cam-grid--flat"}`}>
        <button ref={compass} type="button" className="btn lm-cam-compass" onClick={() => camera?.faceNorth()} disabled={off} aria-label="Compass: turn to face north" title="Turn to face north">
          <svg viewBox="0 0 20 20" width="30" height="30" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="9" className="lm-cam-dial" />
            <g ref={needle}>
              <path d="M10 2.6 L12.6 10 L7.4 10 Z" className="lm-cam-north" />
              <path d="M10 17.4 L12.6 10 L7.4 10 Z" className="lm-cam-south" />
              <text x="10" y="5.2" className="lm-cam-n">N</text>
            </g>
          </svg>
        </button>
        <button type="button" className="btn" onClick={() => camera?.rotate(-ROTATE_STEP)} disabled={off} aria-label="Rotate left" title="Rotate left (Q)">
          <Icon><path d="M6 5.5A6 6 0 1 1 4.2 11" /><path d="M6.4 1.8 6 5.5 9.6 6" /></Icon>
        </button>
        <button type="button" className="btn" onClick={() => camera?.rotate(ROTATE_STEP)} disabled={off} aria-label="Rotate right" title="Rotate right (E)">
          <Icon><path d="M14 5.5A6 6 0 1 0 15.8 11" /><path d="M13.6 1.8 14 5.5 10.4 6" /></Icon>
        </button>
        {camera?.tilt && (
          <>
            <button type="button" className="btn" onClick={() => camera.tilt?.(TILT_STEP)} aria-label="Tilt up (towards the horizon)" title="Tilt up (W)">
              <Icon><path d="M3 15h14" /><path d="M10 12V3" /><path d="m6.5 6.5 3.5-3.5 3.5 3.5" /></Icon>
            </button>
            <button type="button" className="btn" onClick={() => camera.tilt?.(-TILT_STEP)} aria-label="Tilt down (towards a top view)" title="Tilt down (S)">
              <Icon><path d="M3 17h14" /><path d="M10 3v10" /><path d="m6.5 9.5 3.5 3.5 3.5-3.5" /></Icon>
            </button>
          </>
        )}
        <button type="button" className="btn" onClick={() => camera?.reset()} disabled={off} aria-label="Reset view" title="Reset view (0 or Home)">
          <Icon><path d="M3 9.2 10 3l7 6.2" /><path d="M5 8v8.5h10V8" /></Icon>
        </button>
        <button type="button" className="btn" onClick={() => camera?.zoom(0.8)} disabled={off} aria-label="Zoom in" title="Zoom in (+)">
          <Icon><path d="M10 4v12M4 10h12" /></Icon>
        </button>
        <button type="button" className="btn" onClick={() => camera?.zoom(1.25)} disabled={off} aria-label="Zoom out" title="Zoom out (−)">
          <Icon><path d="M4 10h12" /></Icon>
        </button>
        {follow && (
          <button
            type="button"
            className="btn lm-cam-follow"
            aria-pressed={follow.on}
            onClick={follow.toggle}
            disabled={off || !follow.enabled}
            title={follow.enabled ? "Keep the selected asset in view as it moves" : "Select an asset to follow it"}
          >
            <Icon><circle cx="10" cy="10" r="6.5" /><circle cx="10" cy="10" r="2" /><path d="M10 1.5v2.5M10 16v2.5M1.5 10H4M16 10h2.5" /></Icon>
            <span className="lm-cam-follow-text">Follow</span>
          </button>
        )}
      </div>
    </div>
  );
  return host ? createPortal(ui, host) : ui;
}
