import * as THREE from "three";
import { FigureLayer, type LayerEntry } from "./figureLayer";

const world = (x: number, y: number, out: THREE.Vector3) => out.set(x, 0, y);
const sphere = new THREE.Sphere(new THREE.Vector3(), 100);
const red = new THREE.Color(1, 0, 0);
const blue = new THREE.Color(0, 0, 1);
const entry = (id: string, x: number, key: LayerEntry["key"] = "nurse", moving = false): LayerEntry =>
  ({ id, key, pose: { x, y: 0, heading: 0, level: 0, size: 1 }, moving, color: red });
const meshes = (l: FigureLayer) => l.group.children as THREE.Mesh[];
const drawn = (m: THREE.Mesh) => (m.visible ? m.geometry.drawRange.count : 0);

test("one merged mesh per model; walkers move into a separate batch and back", () => {
  const l = new FigureLayer(world);
  l.rebuild([entry("a", 0), entry("b", 5), entry("c", 10, "bed")], sphere);
  expect(meshes(l).map((m) => m.name).sort()).toEqual(["figures:bed", "figures:nurse"]);
  expect(l.count).toBe(3);

  l.write("a", { x: 2, y: 0, heading: 0, level: 0, size: 1 }, true);
  l.flush();
  const walkers = meshes(l).find((m) => m.name === "walkers:nurse")!;
  expect(l.walkers).toBe(1);
  expect(drawn(walkers)).toBeGreaterThan(0);
  // The resting slot is collapsed while walking (all zeros).
  const rest = meshes(l).find((m) => m.name === "figures:nurse")!;
  const pos = rest.geometry.getAttribute("position").array as Float32Array;
  const per = pos.length / 2;
  expect(pos.subarray(0, per).every((v) => v === 0)).toBe(true);

  l.write("a", { x: 3, y: 0, heading: 0, level: 0, size: 1 }, false);
  l.flush();
  expect(l.walkers).toBe(0);
  expect(drawn(walkers)).toBe(0);
  expect(pos.subarray(0, per).some((v) => v !== 0)).toBe(true);
});

test("colors are kept per figure and follow it into the walking batch", () => {
  const l = new FigureLayer(world);
  l.rebuild([entry("a", 0)], sphere);
  expect(l.colorOf("a")).toBe(`#${red.getHexString()}`);
  l.setColor("a", blue);
  expect(l.colorOf("a")).toBe(`#${blue.getHexString()}`);
  l.write("a", { x: 1, y: 0, heading: 0, level: 0, size: 1 }, true);
  const walkers = meshes(l).find((m) => m.name === "walkers:nurse")!;
  const col = walkers.geometry.getAttribute("color").array as Float32Array;
  expect(col[2]).toBeGreaterThan(0); // blue channel
  expect(col[0]).toBe(0);
});

test("a straight move only shifts positions", () => {
  const l = new FigureLayer(world);
  l.rebuild([entry("a", 0, "person", true)], sphere);
  const walkers = meshes(l).find((m) => m.name === "walkers:person")!;
  const pos = walkers.geometry.getAttribute("position").array as Float32Array;
  const before = pos[0];
  l.write("a", { x: 1.5, y: 0, heading: 0, level: 0, size: 1 }, true);
  expect(pos[0]).toBeCloseTo(before + 1.5, 5);
});

test("picking hits the nearest figure along the ray, resting or walking", () => {
  const l = new FigureLayer(world);
  const e = [entry("a", 0), entry("b", 5, "bed", true)];
  l.rebuild(e, sphere);
  const poses = new Map(e.map((x) => [x.id, x.pose]));
  const down = (x: number) => new THREE.Ray(new THREE.Vector3(x, 10, 0), new THREE.Vector3(0, -1, 0));
  expect(l.pick(down(0), (id) => poses.get(id))).toBe("a");
  expect(l.pick(down(5), (id) => poses.get(id))).toBe("b");
  expect(l.pick(down(20), (id) => poses.get(id))).toBeNull();
});

test("a rebuild with the same figures keeps the buffers", () => {
  const l = new FigureLayer(world);
  l.rebuild([entry("a", 0), entry("b", 5)], sphere);
  const first = meshes(l)[0].geometry;
  l.rebuild([entry("a", 1), entry("b", 5)], sphere);
  expect(meshes(l)[0].geometry).toBe(first);
  l.rebuild([entry("a", 1)], sphere);
  expect(meshes(l)[0].geometry).not.toBe(first);
});
