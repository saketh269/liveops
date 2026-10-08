import * as THREE from "three";
import { DEFAULT_AZIMUTH, ORBIT, boundsFor } from "./camera";
import { CameraRig } from "./cameraRig";

function setup(reduced = true) {
  const el = document.createElement("div");
  const host = document.createElement("div");
  host.tabIndex = 0;
  host.appendChild(el);
  document.body.appendChild(host);
  // jsdom has no layout: give the canvas a size.
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(el, "clientHeight", { value: 500 });
  const cam = new THREE.OrthographicCamera(-48, 48, 30, -30, 0.1, 1000);
  const rig = new CameraRig(cam, el, host);
  rig.reducedMotion = reduced;
  rig.bounds = boundsFor(80, 40, 0.5, 6);
  rig.frameHalf = 30;
  rig.jumpTo({ target: new THREE.Vector3(), azimuth: DEFAULT_AZIMUTH, polar: 0.9, zoom: 1 });
  return { rig, el, host, cam };
}

const key = (host: HTMLElement, k: string, o: KeyboardEventInit = {}) => host.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...o }));

describe("CameraRig", () => {
  test("writes the view into the camera: looks at the target from the azimuth/polar", () => {
    const { rig, cam } = setup();
    rig.jumpTo({ target: new THREE.Vector3(5, 0, -3), azimuth: 0, polar: 0.5 });
    const d = cam.position.clone().sub(new THREE.Vector3(5, 0, -3)).normalize();
    expect(d.x).toBeCloseTo(0);
    expect(Math.acos(d.y)).toBeCloseTo(0.5);
  });

  test("keyboard: arrows pan, Q/E and Shift+arrows rotate, W/S and PageUp/PageDown tilt, +/− zoom, 0 resets", () => {
    const { rig, host } = setup();
    const reset = vi.fn();
    rig.onReset = reset;
    const t0 = rig.current.target.clone();
    key(host, "ArrowLeft");
    expect(rig.current.target.distanceTo(t0)).toBeGreaterThan(0.5);
    const az = rig.current.azimuth;
    key(host, "e");
    expect(rig.current.azimuth).toBeGreaterThan(az);
    key(host, "ArrowLeft", { shiftKey: true });
    key(host, "Q");
    expect(rig.current.azimuth).toBeCloseTo(az - Math.PI / 12);
    const p = rig.current.polar;
    key(host, "w");
    expect(rig.current.polar).toBeGreaterThan(p);
    key(host, "PageDown"); key(host, "PageDown");
    expect(rig.current.polar).toBeLessThan(p);
    key(host, "+");
    expect(rig.current.zoom).toBeCloseTo(1.25);
    key(host, "-");
    expect(rig.current.zoom).toBeCloseTo(1);
    key(host, "Home");
    expect(reset).toHaveBeenCalledTimes(1);
    // Keys with Ctrl (browser shortcuts) are left alone.
    const z = rig.current.zoom;
    key(host, "+", { ctrlKey: true });
    expect(rig.current.zoom).toBe(z);
  });

  test("tilt is clamped", () => {
    const { rig } = setup();
    for (let i = 0; i < 40; i++) rig.tiltBy(0.2);
    expect(rig.current.polar).toBe(ORBIT.maxPolar);
    for (let i = 0; i < 40; i++) rig.tiltBy(-0.2);
    expect(rig.current.polar).toBe(ORBIT.minPolar);
  });

  test("wheel: a mouse notch zooms towards the cursor; a pinch zooms; a trackpad scroll pans", () => {
    const { rig, el } = setup();
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 700, clientY: 100, bubbles: true, cancelable: true }));
    expect(rig.current.zoom).toBeGreaterThan(1);
    expect(rig.current.target.length()).toBeGreaterThan(1); // slid towards the cursor, not the centre
    const z = rig.current.zoom;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, ctrlKey: true, clientX: 400, clientY: 250, bubbles: true, cancelable: true }));
    expect(rig.current.zoom).toBeLessThan(z);
    const t = rig.current.target.clone(), z2 = rig.current.zoom;
    el.dispatchEvent(new WheelEvent("wheel", { deltaX: 6.5, deltaY: 3.5, bubbles: true, cancelable: true }));
    expect(rig.current.zoom).toBe(z2);
    expect(rig.current.target.distanceTo(t)).toBeGreaterThan(0);
  });

  test("user input wins over a fly-to: it stops where it is", () => {
    const { rig } = setup(false);
    rig.flyTo(new THREE.Vector3(30, 0, 15), 3);
    let now = performance.now();
    for (let i = 0; i < 3; i++) rig.update((now += 16));
    expect(rig.isFlying).toBe(true);
    const mid = rig.current.target.clone();
    rig.rotateBy(0.3);
    expect(rig.isFlying).toBe(false);
    for (let i = 0; i < 200; i++) rig.update((now += 16));
    expect(rig.current.target.distanceTo(mid)).toBeLessThan(0.01);
    expect(rig.current.zoom).toBeLessThan(3);
  });

  test("follow: the camera tracks the figure; orbit/zoom keep tracking around it; a pan pauses; resume returns", () => {
    const { rig } = setup();
    const states: { following: boolean; paused: boolean }[] = [];
    rig.subscribe((s) => states.push({ following: s.following, paused: s.paused }));
    rig.setFollowing(true);
    rig.setFollowPoint(new THREE.Vector3(10, 0, 5));
    rig.update();
    expect(rig.current.target.toArray()).toEqual([10, 0, 5]);
    rig.rotateBy(1);
    rig.zoomBy(1.5);
    rig.update();
    expect(rig.tracking).toBe(true);
    expect(rig.current.target.toArray()).toEqual([10, 0, 5]);
    rig.panBy(200, 0);
    rig.setFollowPoint(new THREE.Vector3(12, 0, 5));
    rig.update();
    expect(rig.tracking).toBe(false);
    expect(rig.current.target.x).not.toBeCloseTo(12);
    expect(states.at(-1)).toEqual({ following: true, paused: true });
    rig.resumeFollow();
    rig.update();
    expect(rig.current.target.toArray()).toEqual([12, 0, 5]);
    expect(states.at(-1)).toEqual({ following: true, paused: false });
    rig.setFollowing(false);
    expect(states.at(-1)).toEqual({ following: false, paused: false });
  });

  test("faceNorth turns the short way to azimuth 0", () => {
    const { rig } = setup();
    rig.jumpTo({ azimuth: 2 * Math.PI + 0.4 });
    rig.faceNorth();
    expect(rig.current.azimuth).toBeCloseTo(2 * Math.PI);
  });

  test("dispose removes the listeners", () => {
    const { rig, host } = setup();
    rig.dispose();
    const z = rig.current.zoom;
    key(host, "+");
    expect(rig.current.zoom).toBe(z);
  });
});
