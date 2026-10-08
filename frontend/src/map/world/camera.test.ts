import * as THREE from "three";
import {
  DEFAULT_AZIMUTH, DEFAULT_POLAR, FRAME_MARGIN, ORBIT, VIEW_DIR, anglesOf, boundsFor, clampTarget, clampView, easeFactor, fitOrtho,
  followAfterInput, followResume, frameZoomFor, isTracking, maxZoomFor, metresPerPixel, minZoomFor, panDelta, readWheel, viewDirection,
  wrapAngle, yawAround, zoomToFit, zoomTowards,
} from "./camera";

describe("fitOrtho", () => {
  test("a wider viewport needs a smaller frustum, and a bigger floor a bigger one", () => {
    expect(fitOrtho(60, 30, 2)).toBeLessThan(fitOrtho(60, 30, 1));
    expect(fitOrtho(120, 60, 1.6)).toBeGreaterThan(fitOrtho(60, 30, 1.6));
  });

  test("the whole floor fits: its corners project inside the frustum", () => {
    const dir = new THREE.Vector3(-16, 44, 52).normalize();
    const aspect = 1.5, half = fitOrtho(50, 26, aspect, dir);
    const cam = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 1000);
    cam.position.copy(dir).multiplyScalar(200);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    for (const x of [-25, 25]) for (const z of [-13, 13]) {
      const v = new THREE.Vector3(x, 0, z).project(cam);
      expect(Math.abs(v.x)).toBeLessThanOrEqual(1 / FRAME_MARGIN + 1e-6);
      expect(Math.abs(v.y)).toBeLessThanOrEqual(1 / FRAME_MARGIN + 1e-6);
    }
  });

  test("bad aspects fall back to square", () => {
    expect(fitOrtho(40, 20, 0)).toBeCloseTo(fitOrtho(40, 20, 1));
    expect(fitOrtho(40, 20, Number.NaN)).toBeCloseTo(fitOrtho(40, 20, 1));
  });
});

describe("zoom limits", () => {
  test("big floors allow more zoom; small floors keep a useful minimum", () => {
    expect(maxZoomFor(30, 20)).toBe(4);
    expect(maxZoomFor(240, 60)).toBe(20);
  });

  test("zoomToFit: smaller areas zoom closer, within the limits", () => {
    const room = zoomToFit(40, 1.6, 4.5, 5, 0.6, 8);
    const wing = zoomToFit(40, 1.6, 30, 12, 0.6, 8);
    expect(room).toBeGreaterThan(wing);
    expect(zoomToFit(40, 1.6, 0.1, 0.1, 0.6, 8)).toBe(8);
    expect(zoomToFit(40, 1.6, 500, 500, 0.6, 8)).toBe(0.6);
  });
});

/** Orthographic camera posed like the rig does, for checking projections. */
function poseCamera(target: THREE.Vector3, azimuth: number, polar: number, zoom: number, half = 30, aspect = 1.5) {
  const cam = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 1000);
  cam.zoom = zoom;
  cam.position.copy(viewDirection(azimuth, polar)).multiplyScalar(200).add(target);
  cam.up.set(0, 1, 0);
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

describe("angles", () => {
  test("the default angle is the prototype's view direction", () => {
    expect(viewDirection(DEFAULT_AZIMUTH, DEFAULT_POLAR).distanceTo(VIEW_DIR)).toBeLessThan(1e-9);
    const a = anglesOf(VIEW_DIR.clone().multiplyScalar(50), new THREE.Vector3());
    expect(a.azimuth).toBeCloseTo(DEFAULT_AZIMUTH);
    expect(a.polar).toBeCloseTo(DEFAULT_POLAR);
  });

  test("tilt stays between nearly top-down and 20° above the floor", () => {
    expect(ORBIT.minPolar).toBeLessThan(0.1);
    expect(90 - THREE.MathUtils.radToDeg(ORBIT.maxPolar)).toBeCloseTo(20);
    const b = boundsFor(60, 30);
    expect(clampView({ target: new THREE.Vector3(), azimuth: 0, polar: 3, zoom: 1 }, b).polar).toBe(ORBIT.maxPolar);
    expect(clampView({ target: new THREE.Vector3(), azimuth: 0, polar: -1, zoom: 1 }, b).polar).toBe(ORBIT.minPolar);
  });

  test("yaw is unlimited; wrapAngle folds it into (-π, π]", () => {
    const b = boundsFor(60, 30);
    expect(clampView({ target: new THREE.Vector3(), azimuth: 25, polar: 1, zoom: 1 }, b).azimuth).toBe(25);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI / 2 - 4 * Math.PI)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(Number.NaN)).toBe(0);
  });
});

describe("bounds", () => {
  test("the target stays on the floor plus a margin, on the floor plane", () => {
    const b = boundsFor(60, 30); // margin 6 (10% of 60)
    expect(b.margin).toBe(6);
    const t = clampTarget(new THREE.Vector3(500, 4, -500), b);
    expect(t.toArray()).toEqual([36, 0, -21]);
    expect(clampTarget(new THREE.Vector3(Number.NaN, 0, 3), b).toArray()).toEqual([0, 0, 3]);
    expect(boundsFor(20, 10).margin).toBe(4); // at least 4 m
  });

  test("zoom limits: from the whole floor (any angle) to a single room", () => {
    const b = boundsFor(74, 40, minZoomFor(74, 40, 1.6));
    const v = clampView({ target: new THREE.Vector3(), azimuth: 0, polar: 1, zoom: 100 }, b);
    expect(v.zoom).toBe(b.maxZoom);
    expect(clampView({ ...v, zoom: 0.01 }, b).zoom).toBe(b.minZoom);
    expect(b.minZoom).toBeLessThanOrEqual(ORBIT.minZoom);
    // At the closest zoom a room (about 5 m) fills a good part of the view.
    const half = fitOrtho(74, 40, 1.6);
    expect((2 * half) / b.maxZoom).toBeLessThan(20);
  });

  test("frameZoomFor: zoom 1 frames the default angle; a top view of a wide floor needs a little less", () => {
    expect(frameZoomFor(60, 30, 1.6, VIEW_DIR)).toBeCloseTo(1);
    const top = frameZoomFor(60, 30, 1.6, viewDirection(Math.PI / 2, ORBIT.minPolar));
    expect(top).toBeGreaterThan(0.2);
    expect(top).toBeLessThan(1.5);
  });
});

describe("zoom towards the cursor", () => {
  test("the floor point under the cursor stays put on screen", () => {
    const b = boundsFor(80, 50);
    const target = new THREE.Vector3(3, 0, -2), az = 0.7, polar = 0.9, zoom = 1.2;
    const anchor = new THREE.Vector3(15, 0, 9);
    const before = anchor.clone().project(poseCamera(target, az, polar, zoom));
    const z = zoomTowards(target, zoom, 1.5, anchor, b);
    expect(z.zoom).toBeCloseTo(1.8);
    const after = anchor.clone().project(poseCamera(z.target, az, polar, z.zoom));
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  test("zoom is clamped and the slide uses the clamped ratio; no anchor zooms around the centre", () => {
    const b = { minZoom: 0.5, maxZoom: 2 };
    const t = new THREE.Vector3(0, 0, 0);
    const z = zoomTowards(t, 1.5, 10, new THREE.Vector3(10, 0, 0), b);
    expect(z.zoom).toBe(2);
    expect(z.target.x).toBeCloseTo(10 - 10 * (1.5 / 2));
    expect(zoomTowards(t, 1, 1.5, null, b).target.toArray()).toEqual([0, 0, 0]);
  });
});

describe("pan and orbit", () => {
  test("panDelta is a grab: the floor point under the pointer moves with it", () => {
    const target = new THREE.Vector3(), az = -0.4, polar = 1.0, zoom = 1.5, half = 30, h = 800;
    const cam = poseCamera(target, az, polar, zoom, half);
    const p = new THREE.Vector3(5, 0, 5);
    const s0 = p.clone().project(cam);
    const mpp = metresPerPixel(half, zoom, h);
    const d = panDelta(az, polar, mpp, 40, -25); // drag right 40 px, up 25 px
    const s1 = p.clone().project(poseCamera(target.clone().add(d), az, polar, zoom, half));
    // NDC → px: 2 units = h px vertically and h·aspect px horizontally.
    expect(((s1.x - s0.x) / 2) * h * 1.5).toBeCloseTo(40, 4);
    expect((-(s1.y - s0.y) / 2) * h).toBeCloseTo(-25, 4);
    expect(d.y).toBeCloseTo(0);
  });

  test("yawAround keeps the pivot where it is on screen", () => {
    const target = new THREE.Vector3(2, 0, 3), pivot = new THREE.Vector3(10, 0, -6), az = 0.3, polar = 0.8;
    const s0 = pivot.clone().project(poseCamera(target, az, polar, 1));
    const t1 = yawAround(target, pivot, 0.5);
    const s1 = pivot.clone().project(poseCamera(t1, az + 0.5, polar, 1));
    expect(s1.x).toBeCloseTo(s0.x, 6);
    expect(s1.y).toBeCloseTo(s0.y, 6);
    expect(yawAround(target, null, 1).equals(target)).toBe(true);
  });

  test("easeFactor: frame-rate independent, and snaps without a time constant (reduced motion)", () => {
    const two = 1 - (1 - easeFactor(16, 100)) ** 2;
    expect(easeFactor(32, 100)).toBeCloseTo(two);
    expect(easeFactor(16, 0)).toBe(1);
  });
});

describe("follow", () => {
  test("orbit, tilt and zoom keep following; a pan pauses it until resumed", () => {
    const on = { on: true, paused: false };
    expect(followAfterInput(on, "orbit")).toBe(on);
    expect(followAfterInput(on, "tilt")).toBe(on);
    expect(followAfterInput(on, "zoom")).toBe(on);
    const paused = followAfterInput(on, "pan");
    expect(paused).toEqual({ on: true, paused: true });
    expect(isTracking(paused)).toBe(false);
    expect(isTracking(followResume(paused))).toBe(true);
    const off = { on: false, paused: false };
    expect(followAfterInput(off, "pan")).toBe(off);
    expect(followResume(off)).toBe(off);
  });
});

describe("readWheel", () => {
  const w = (deltaX: number, deltaY: number, o: Partial<{ deltaMode: number; ctrlKey: boolean }> = {}) => ({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, ...o });

  test("pinch (ctrl+wheel) zooms; spreading the fingers zooms in", () => {
    const r = readWheel(w(0, -8, { ctrlKey: true }));
    expect(r.kind).toBe("zoom");
    expect(r.kind === "zoom" && r.factor).toBeGreaterThan(1);
  });

  test("a mouse wheel notch zooms; scrolling down zooms out", () => {
    const r = readWheel(w(0, 100));
    expect(r.kind === "zoom" && r.factor).toBeLessThan(1);
    expect(readWheel(w(0, 3, { deltaMode: 1 })).kind).toBe("zoom");
  });

  test("two-finger trackpad scroll pans (small, fractional or sideways deltas)", () => {
    expect(readWheel(w(0, 4.5))).toEqual({ kind: "pan", dx: 0, dy: 4.5 });
    expect(readWheel(w(12, 60)).kind).toBe("pan");
    expect(readWheel(w(0, 7)).kind).toBe("pan");
    // ...unless a mouse wheel was just used: small vertical steps keep zooming.
    expect(readWheel(w(0, 7), true).kind).toBe("zoom");
  });
});
