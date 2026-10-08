// Angled orthographic camera (the prototype's view): a fixed, pleasant default angle,
// orbit within limits, and a smooth fly-to used by selection.
import * as THREE from "three";

/** Direction from the target to the camera (prototype: (-16, 44, 52)). */
export const VIEW_DIR = new THREE.Vector3(-16, 44, 52).normalize();
export const VIEW_DISTANCE = 120;
export const ORBIT = { minPolar: 0.35, maxPolar: 1.12, minZoom: 0.6 } as const;
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

export type FlyGoal = { target: THREE.Vector3; zoom: number };

/**
 * One step of a fly-to: target and zoom ease towards the goal; the camera keeps
 * its angle (it moves with the target). Returns true when it has arrived.
 * `ease` 1 jumps (reduced motion).
 */
export function flyStep(camera: THREE.OrthographicCamera, target: THREE.Vector3, goal: FlyGoal, ease: number): boolean {
  const k = Math.min(1, Math.max(0, ease));
  const dx = (goal.target.x - target.x) * k;
  const dy = (goal.target.y - target.y) * k;
  const dz = (goal.target.z - target.z) * k;
  target.x += dx; target.y += dy; target.z += dz;
  camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
  camera.zoom += (goal.zoom - camera.zoom) * k;
  camera.updateProjectionMatrix();
  const done = target.distanceTo(goal.target) < 0.02 && Math.abs(camera.zoom - goal.zoom) < 0.005;
  if (done) {
    camera.position.add(goal.target.clone().sub(target));
    target.copy(goal.target);
    camera.zoom = goal.zoom;
    camera.updateProjectionMatrix();
  }
  return done;
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
  /** Where the camera looks now (layout metres) and its zoom. */
  view(): { target: [number, number]; zoom: number };
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
