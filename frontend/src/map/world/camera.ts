// Angled orthographic camera (the prototype's view): a pleasant default angle, free
// orbit/tilt/pan/zoom within limits (cameraRig.ts drives it), and a smooth fly-to.
import * as THREE from "three";

/** Direction from the target to the camera (prototype: (-16, 44, 52)). */
export const VIEW_DIR = new THREE.Vector3(-16, 44, 52).normalize();
export const VIEW_DISTANCE = 120;
/**
 * Tilt limits (polar angle from straight down): from nearly top-down to ~20° above the
 * floor. Zoom 1 frames the whole floor; 0.6 leaves room around it.
 */
export const ORBIT = { minPolar: 0.06, maxPolar: THREE.MathUtils.degToRad(70), minZoom: 0.6 } as const;
/** Room around the floor for the floating cards (KPI strip on top, journey card below). */
export const FRAME_MARGIN = 1.14;
/** Zoom used when flying to a selection. */
export const FOCUS_ZOOM = 2.2;

/**
 * Half height of an orthographic frustum (at zoom 1) that shows a `width` × `depth`
 * floor (centred on the origin, walls up to `height`) from direction `dir`, for a
 * viewport of `aspect` (w/h). The half width is `halfH * aspect`.
 */
export function fitOrtho(width: number, depth: number, aspect: number, dir: THREE.Vector3 = VIEW_DIR, height = 2, margin = FRAME_MARGIN): number {
  const f = dir.clone().negate().normalize();
  const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, f).normalize();
  let maxR = 0, maxU = 0;
  const p = new THREE.Vector3();
  for (const x of [-width / 2, width / 2]) for (const z of [-depth / 2, depth / 2]) for (const y of [0, height]) {
    p.set(x, y, z);
    maxR = Math.max(maxR, Math.abs(p.dot(right)));
    maxU = Math.max(maxU, Math.abs(p.dot(up)));
  }
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return Math.max(maxU, maxR / a, 1) * margin;
}

/** Largest useful zoom for a floor: enough to see a single bed on big floors. */
export function maxZoomFor(width: number, depth: number): number {
  return Math.max(4, Math.max(width, depth) / 12);
}

/**
 * Camera handle other modules use (HUD cards, problem pins, panels): positions are
 * layout metres on the current floor. Exposed by MapView3D through its `cameraRef`.
 */
export type MapCamera = {
  /** Smoothly bring `point` to the centre of the view at `zoom` (default: close enough to read a room). */
  flyTo(point: readonly [number, number], zoom?: number): void;
  /** Fly to a zone of the current floor, zoomed to fit it. False when it is not on this floor. */
  flyToZone(zoneId: string): boolean;
  /** Back to the default framing of the whole floor. */
  reset(): void;
  /** Where the camera looks now (layout metres), its zoom, and its angles (radians; read-only, for tests and debugging). */
  view(): CameraReadout;
};

/** Read-only camera view (debug hook `window.__liveopsMap.view()`). */
export type CameraReadout = {
  target: [number, number];
  zoom: number;
  /** Yaw: 0 = north up on screen; positive turns the map clockwise. */
  azimuth: number;
  /** Tilt from straight down (0) towards the horizon. */
  polar: number;
  following: boolean;
  paused: boolean;
};

/**
 * Zoom that shows a `w` × `h` area (metres) with room around it, for a frustum of
 * `frameHalf` half height at zoom 1 and viewport `aspect`; within [min, max].
 */
export function zoomToFit(frameHalf: number, aspect: number, w: number, h: number, min: number, max: number): number {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // Ortho half extents at zoom z: frameHalf / z (vertical), frameHalf * a / z (horizontal).
  // The angled view foreshortens depth, so a zone's depth counts a little less than its width.
  const need = Math.max(h * 0.8, w / a, 1) * 1.8;
  const z = (2 * frameHalf) / need;
  return Math.min(max, Math.max(min, z));
}

// ---------------------------------------------------------------------------
// Free camera (camera fix): the view is a target on the floor, an azimuth (yaw),
// a polar angle (tilt) and an orthographic zoom. Everything below is pure math so
// it can be unit-tested; cameraRig.ts applies it to the Three.js camera.

/** Camera pose: `target` on the floor (world X/Z, Y = 0), `azimuth` and `polar` in radians, ortho `zoom`. */
export type CameraView = { target: THREE.Vector3; azimuth: number; polar: number; zoom: number };

/** Allowed region and zoom range for the current floor. */
export type CameraBounds = { halfW: number; halfD: number; margin: number; minZoom: number; maxZoom: number };

/** Default angle (prototype): azimuth and polar of VIEW_DIR. */
export const DEFAULT_AZIMUTH = Math.atan2(VIEW_DIR.x, VIEW_DIR.z);
export const DEFAULT_POLAR = Math.acos(VIEW_DIR.y);

/** Bounds for a `width` × `depth` floor: the target may leave the floor by a margin (10%, at least 4 m). */
export function boundsFor(width: number, depth: number, minZoom: number = ORBIT.minZoom, maxZoom = maxZoomFor(width, depth)): CameraBounds {
  return { halfW: width / 2, halfD: depth / 2, margin: Math.max(4, Math.max(width, depth) * 0.1), minZoom, maxZoom };
}

export function clampPolar(polar: number): number {
  return THREE.MathUtils.clamp(Number.isFinite(polar) ? polar : DEFAULT_POLAR, ORBIT.minPolar, ORBIT.maxPolar);
}

export function clampZoom(zoom: number, b: Pick<CameraBounds, "minZoom" | "maxZoom">): number {
  return THREE.MathUtils.clamp(Number.isFinite(zoom) ? zoom : 1, b.minZoom, b.maxZoom);
}

/** Azimuth folded into (-π, π]. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const t = Math.PI * 2;
  let r = ((a + Math.PI) % t + t) % t - Math.PI;
  if (r <= -Math.PI) r += t;
  return r;
}

/** Keep a target on the floor (plus margin), on the floor plane. */
export function clampTarget(t: THREE.Vector3, b: CameraBounds): THREE.Vector3 {
  t.x = THREE.MathUtils.clamp(Number.isFinite(t.x) ? t.x : 0, -b.halfW - b.margin, b.halfW + b.margin);
  t.z = THREE.MathUtils.clamp(Number.isFinite(t.z) ? t.z : 0, -b.halfD - b.margin, b.halfD + b.margin);
  t.y = 0;
  return t;
}

/** Applies every limit to a view in place. */
export function clampView(v: CameraView, b: CameraBounds): CameraView {
  v.polar = clampPolar(v.polar);
  v.azimuth = Number.isFinite(v.azimuth) ? v.azimuth : DEFAULT_AZIMUTH;
  v.zoom = clampZoom(v.zoom, b);
  clampTarget(v.target, b);
  return v;
}

/** Unit vector from the target towards the camera (three.js Spherical convention). */
export function viewDirection(azimuth: number, polar: number, out = new THREE.Vector3()): THREE.Vector3 {
  const s = Math.sin(polar);
  return out.set(s * Math.sin(azimuth), Math.cos(polar), s * Math.cos(azimuth));
}

/** Azimuth and polar of a camera at `position` looking at `target`. */
export function anglesOf(position: THREE.Vector3, target: THREE.Vector3): { azimuth: number; polar: number } {
  const d = position.clone().sub(target);
  const r = d.length() || 1;
  return { azimuth: Math.atan2(d.x, d.z), polar: Math.acos(THREE.MathUtils.clamp(d.y / r, -1, 1)) };
}

/** World metres per screen pixel at `zoom` for a frustum of `frameHalf` half height on a `viewportH` px tall canvas. */
export function metresPerPixel(frameHalf: number, zoom: number, viewportH: number): number {
  return (2 * frameHalf) / Math.max(1e-6, zoom) / Math.max(1, viewportH);
}

/**
 * Floor displacement of the target for a "grab" drag of (dx, dy) pixels: the floor
 * under the pointer follows the pointer. Screen-down on the angled floor covers
 * 1/cos(polar) metres per screen metre (foreshortening).
 */
export function panDelta(azimuth: number, polar: number, mpp: number, dxPx: number, dyPx: number): THREE.Vector3 {
  const right = new THREE.Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
  const forward = new THREE.Vector3(-Math.sin(azimuth), 0, -Math.cos(azimuth)); // floor direction that points screen-up
  const fore = 1 / Math.max(0.2, Math.cos(polar));
  return right.multiplyScalar(-dxPx * mpp).add(forward.multiplyScalar(dyPx * mpp * fore));
}

/**
 * Zoom by `factor` (> 1 zooms in) keeping the floor point `anchor` (under the cursor)
 * where it is on screen. Orthographic: the target slides towards the anchor by 1 - 1/k.
 * Returns the new target and zoom (zoom clamped; the slide uses the clamped ratio).
 */
export function zoomTowards(target: THREE.Vector3, zoom: number, factor: number, anchor: THREE.Vector3 | null, b: Pick<CameraBounds, "minZoom" | "maxZoom">): { target: THREE.Vector3; zoom: number } {
  const next = clampZoom(zoom * factor, b);
  const t = target.clone();
  if (anchor) t.sub(anchor).multiplyScalar(zoom / next).add(anchor);
  return { target: t, zoom: next };
}

/** Rotate the target about a vertical axis through `pivot` (orbit around the point under the cursor). */
export function yawAround(target: THREE.Vector3, pivot: THREE.Vector3 | null, radians: number): THREE.Vector3 {
  if (!pivot) return target.clone();
  return target.clone().sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), radians).add(pivot);
}

/** Ease `from` towards `to` for a frame of `dtMs` with time constant `tauMs` (0 or less snaps). Returns the 0..1 factor. */
export function easeFactor(dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
}

/** Shortest signed angle from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/**
 * Follow (tracking) state: user orbit/zoom keep following (orbiting around the
 * figure); a pan pauses it until the user resumes.
 */
export type FollowState = { on: boolean; paused: boolean };
export type CameraInputKind = "orbit" | "tilt" | "zoom" | "pan";

export function followAfterInput(s: FollowState, kind: CameraInputKind): FollowState {
  if (!s.on || s.paused || kind !== "pan") return s;
  return { on: true, paused: true };
}

export function followResume(s: FollowState): FollowState {
  return s.on ? { on: true, paused: false } : s;
}

/** Is the camera following right now (on and not paused)? */
export function isTracking(s: FollowState): boolean {
  return s.on && !s.paused;
}

/**
 * Zoom that frames the whole floor seen from `dir`, relative to zoom 1 framing it from
 * the default angle (frameHalf is always fitted for the default angle so zoom keeps
 * its meaning when the user rotates).
 */
export function frameZoomFor(width: number, depth: number, aspect: number, dir: THREE.Vector3, height = 2): number {
  return fitOrtho(width, depth, aspect, VIEW_DIR, height) / fitOrtho(width, depth, aspect, dir, height);
}

/** Wheel event as the camera reads it: pinch (zoom), mouse wheel (zoom) or two-finger scroll (pan). */
export type WheelIntent = { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number };

/**
 * Interpret a wheel event. Browsers report a trackpad pinch as a wheel with ctrlKey.
 * A trackpad two-finger scroll has small, fractional or sideways deltas; a mouse wheel
 * has whole notches (deltaMode lines, or |deltaY| ≥ 50 px with no sideways part).
 * `mouseSeen` latches once a notch has been seen so a slow mouse wheel keeps zooming.
 */
export function readWheel(e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey?: boolean }, mouseSeen = false): WheelIntent {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) return { kind: "zoom", factor: Math.exp(-THREE.MathUtils.clamp(dy, -50, 50) * 0.01) };
  const notch = e.deltaMode !== 0 || (dx === 0 && Number.isInteger(dy) && Math.abs(dy) >= 50);
  if (notch || (mouseSeen && dx === 0)) return { kind: "zoom", factor: Math.exp(-THREE.MathUtils.clamp(dy, -240, 240) * 0.0015) };
  return { kind: "pan", dx, dy };
}

/** Is the camera wheel input from a notched mouse wheel? (latches `mouseSeen`) */
export function isWheelNotch(e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean }): boolean {
  return !e.ctrlKey && (e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50));
}

/**
 * Smallest useful zoom: the whole floor (and a bit) still fits from any angle the user
 * can reach, never more than ORBIT.minZoom.
 */
export function minZoomFor(width: number, depth: number, aspect: number): number {
  let m = Infinity;
  for (const polar of [ORBIT.minPolar, DEFAULT_POLAR, ORBIT.maxPolar]) {
    for (let i = 0; i < 8; i++) m = Math.min(m, frameZoomFor(width, depth, aspect, viewDirection((i * Math.PI) / 4, polar)));
  }
  return Math.min(ORBIT.minZoom, m * 0.85);
}
