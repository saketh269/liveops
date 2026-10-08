import * as THREE from "three";
import { FRAME_MARGIN, fitOrtho, flyStep, maxZoomFor, zoomToFit } from "./camera";

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

describe("flyStep", () => {
  const setup = () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    cam.position.set(0, 10, 10);
    return { cam, target: new THREE.Vector3() };
  };

  test("eases target, camera and zoom towards the goal, keeping the view angle", () => {
    const { cam, target } = setup();
    const goal = { target: new THREE.Vector3(10, 0, -4), zoom: 3 };
    const before = cam.position.clone().sub(target);
    let done = false, steps = 0;
    while (!done && steps < 500) { done = flyStep(cam, target, goal, 0.1); steps++; }
    expect(done).toBe(true);
    expect(steps).toBeGreaterThan(10); // smooth, not a jump
    expect(target.distanceTo(goal.target)).toBe(0);
    expect(cam.zoom).toBe(3);
    expect(cam.position.clone().sub(target).distanceTo(before)).toBeLessThan(1e-9);
  });

  test("ease 1 arrives in one step (reduced motion)", () => {
    const { cam, target } = setup();
    expect(flyStep(cam, target, { target: new THREE.Vector3(5, 0, 5), zoom: 2 }, 1)).toBe(true);
    expect(target.toArray()).toEqual([5, 0, 5]);
  });
});
