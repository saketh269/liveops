import type { Zone } from "../../api/types";
import * as THREE from "three";
import { RoomTiles, bayKerbs, buildWorld, chairSpots, roundedBox } from "./build";
import { PALETTES } from "./style";
import { pointInPolygon } from "../placement";

const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

describe("bayKerbs", () => {
  test("a bay without a door is kerbed on every edge", () => {
    expect(bayKerbs({ id: "b", name: "b", kind: "bay", polygon: rect(0, 0, 10, 8) })).toHaveLength(4);
  });
  test("the edge with the door stays open", () => {
    const k = bayKerbs({ id: "b", name: "b", kind: "bay", polygon: rect(0, 0, 10, 8), doors: [[5, 8]] });
    expect(k).toHaveLength(3);
    expect(k.some((s) => s.a[1] === 8 && s.b[1] === 8)).toBe(false);
  });
  test("bad polygons give nothing", () => {
    expect(bayKerbs({ id: "b", name: "b", kind: "bay", polygon: [] })).toEqual([]);
  });
});

describe("chairSpots", () => {
  test("seats sit inside the area and keep clear of its doors", () => {
    const z: Zone = { id: "w", name: "Waiting", kind: "waiting", polygon: rect(0, 0, 14, 8), doors: [[0, 2.5]] };
    const spots = chairSpots(z);
    expect(spots.length).toBeGreaterThan(5);
    for (const [x, y] of spots) {
      expect(pointInPolygon(x, y, z.polygon)).toBe(true);
      expect(Math.hypot(x, y - 2.5)).toBeGreaterThanOrEqual(2);
    }
    expect(chairSpots(z, 3)).toHaveLength(3);
  });
});

describe("buildWorld", () => {
  // jsdom has no canvas 2D: the floor falls back to a plain color (paintFloor returns null).
  beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
  afterEach(() => { vi.restoreAllMocks(); });

  test("derives furniture from zone kinds: desks for -NS, chairs for waiting, kerbs for bays, tiles for rooms", () => {
    const zones: Zone[] = [
      { id: "U-corridor", name: "U corridor", kind: "corridor", polygon: rect(0, 6, 30, 6) },
      { id: "R1", name: "R1", kind: "room", polygon: rect(0, 0, 5, 6), doors: [[2.5, 6]] },
      { id: "R2", name: "R2", kind: "room", polygon: rect(5, 0, 5, 6), doors: [[7.5, 6]] },
      { id: "U-NS", name: "U-NS", kind: "waiting", polygon: rect(12, 8, 6, 3) },
      { id: "W", name: "Waiting", kind: "waiting", polygon: rect(20, 0, 10, 6), doors: [[25, 6]] },
      { id: "B", name: "Bay", kind: "bay", polygon: rect(0, 14, 8, 6) },
    ];
    const w = buildWorld({ width: 30, depth: 20, zones, entrances: [], ground: false, palette: PALETTES.light, software: true, fonts: { data: "monospace", body: "sans-serif" } });
    expect([...w.tiles.ids()]).toEqual(["R1", "R2"]);
    expect(w.wallCount).toBeGreaterThan(4);
    const names = w.group.children.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["slab", "floor", "room-tiles", "statics"]));
    expect(names).not.toContain("ground");
  });

  test("a floor without zones still has a slab and floor (no crash)", () => {
    const w = buildWorld({ width: 10, depth: 10, zones: [], entrances: [], ground: true, palette: PALETTES.dark, software: false, fonts: { data: "monospace", body: "sans-serif" } });
    expect(w.tiles.mesh).toBeNull();
    expect(w.group.children.map((c) => c.name)).toEqual(expect.arrayContaining(["ground", "slab", "floor"]));
    expect(w.background).toBe(PALETTES.dark.ground);
  });

  test("software renderers: no full-screen grass plane (the clear color shows it), cheaper materials", () => {
    const w = buildWorld({ width: 10, depth: 10, zones: [], entrances: [], ground: true, palette: PALETTES.light, software: true, fonts: { data: "monospace", body: "sans-serif" } });
    expect(w.group.children.map((c) => c.name)).not.toContain("ground");
    expect(w.background).toBe(PALETTES.light.ground);
    const slab = w.group.children.find((c) => c.name === "slab") as unknown as { material: { type: string } };
    expect(slab.material.type).toBe("MeshLambertMaterial");
    const upper = buildWorld({ width: 10, depth: 10, zones: [], entrances: [], ground: false, palette: PALETTES.light, software: false, fonts: { data: "monospace", body: "sans-serif" } });
    expect(upper.background).toBe(PALETTES.light.sky);
  });
});

describe("RoomTiles", () => {
  test("every tile triangle faces up, whatever the polygon's winding (a downward face is lit from below)", () => {
    const toWorld = (x: number, y: number) => new THREE.Vector3(x, 0, y);
    const cw = rect(0, 0, 4, 5);
    const tiles = new RoomTiles([
      { id: "ccw", name: "a", kind: "room", polygon: cw },
      { id: "cw", name: "b", kind: "room", polygon: [...cw].reverse() },
      { id: "L", name: "c", kind: "room", polygon: [[10, 0], [14, 0], [14, 2], [12, 2], [12, 5], [10, 5]] },
    ], toWorld);
    const pos = tiles.mesh!.geometry.getAttribute("position");
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    expect(pos.count % 3).toBe(0);
    for (let i = 0; i < pos.count; i += 3) {
      v.forEach((p, k) => p.fromBufferAttribute(pos, i + k));
      const n = new THREE.Vector3().crossVectors(v[1].clone().sub(v[0]), v[2].clone().sub(v[0]));
      expect(n.y).toBeGreaterThan(0);
    }
  });
});

describe("roundedBox", () => {
  /** Area of the faces pointing straight up (the top cap). */
  const topArea = (g: THREE.BufferGeometry) => {
    const ng = g.index ? g.toNonIndexed() : g;
    const pos = ng.getAttribute("position");
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let area = 0;
    for (let i = 0; i < pos.count; i += 3) {
      v.forEach((p, k) => p.fromBufferAttribute(pos, i + k));
      const n = new THREE.Vector3().crossVectors(v[1].clone().sub(v[0]), v[2].clone().sub(v[0]));
      if (n.y > 0 && Math.abs(n.x) < 1e-9 && Math.abs(n.z) < 1e-9) area += n.y / 2;
    }
    return area;
  };

  test("with a hole the top is only the ring around it (no overdraw under the floor)", () => {
    const full = topArea(roundedBox(12, 8, 0.8, 0.35));
    const ring = topArea(roundedBox(12, 8, 0.8, 0.35, [10.8, 6.8]));
    expect(full).toBeGreaterThan(90);
    expect(ring).toBeCloseTo(full - 10.8 * 6.8, 1);
  });
});
