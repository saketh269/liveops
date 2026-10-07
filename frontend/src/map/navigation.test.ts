import type { SiteLayout, Zone } from "../api/types";
import { NavGrid, navFloorOf, navGridFor, nearestEntrance } from "./navigation";
import { pointInPolygon, type Pt } from "./placement";

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Zone> = {}): Zone =>
  ({ id, name: id, polygon: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], ...extra });

/** Points every `step` units along a polyline. */
function samples(pts: Pt[], step = 0.1): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}
const pathLength = (pts: Pt[]) => pts.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const inZone = (z: Zone, [x, y]: Pt) => pointInPolygon(x, y, z.polygon);
const distTo = (pts: Pt[], q: Pt) => Math.min(...samples(pts).map((p) => Math.hypot(p[0] - q[0], p[1] - q[1])));
// Correctness tests use a generous time cap so a busy test runner can't turn them into fallbacks.
const grid = (layout: SiteLayout) => {
  const g = new NavGrid(navFloorOf(layout));
  const route = g.route.bind(g);
  g.route = (from, to, opts = {}) => route(from, to, { maxMs: 10_000, ...opts });
  return g;
};

describe("navFloorOf", () => {
  test("applies the ADR 0006 entrance defaults to an old layout", () => {
    const f = navFloorOf({ width: 80, depth: 40, zones: [] });
    expect(f.width).toBe(80);
    expect(f.entrances).toEqual([
      expect.objectContaining({ kind: "walk", point: [40, 40] }),
      expect.objectContaining({ kind: "ambulance", point: [0, 40] }),
    ]);
  });

  test("uses the first floor and its zones and entrances", () => {
    const f = navFloorOf({
      floors: [{ id: "f2", name: "Two", level: 2, width: 50, depth: 30 }, { id: "f1", name: "One", level: 1, width: 70, depth: 35 }],
      zones: [rect("a", 0, 0, 5, 5, { floor_id: "f1" }), rect("b", 0, 0, 5, 5, { floor_id: "f2" }), rect("c", 10, 0, 5, 5)],
      entrances: [{ id: "e2", name: "E2", floor_id: "f2", point: [1, 1], kind: "walk" }, { id: "e1", name: "E1", floor_id: "f1", point: [3, 35], kind: "walk" }],
    });
    expect([f.width, f.depth]).toEqual([70, 35]);
    expect(f.zones.map((z) => z.id)).toEqual(["a", "c"]);
    expect(f.entrances.map((e) => e.id)).toEqual(["e1"]);
  });

  test("nearest entrance of a kind, falling back to any entrance", () => {
    const f = navFloorOf({ width: 100, depth: 50, entrances: [
      { id: "w1", name: "W1", point: [10, 50], kind: "walk" },
      { id: "w2", name: "W2", point: [90, 50], kind: "walk" },
    ] });
    expect(nearestEntrance(f, [80, 10], "walk").id).toBe("w2");
    expect(nearestEntrance(f, [80, 10], "ambulance").id).toBe("w2");
  });
});

describe("routes", () => {
  // 40 × 20 floor: a corridor along y 8..12, rooms above it with doors onto it, a room below with no doors.
  const corridor = rect("hall", 0, 8, 40, 4, { kind: "corridor" });
  const a = rect("A", 0, 0, 10, 8, { kind: "room", doors: [[5, 8]] });
  const b = rect("B", 30, 0, 10, 8, { kind: "room", doors: [[35, 8]] });
  const mid = rect("M", 12, 0, 16, 8, { kind: "room", doors: [[20, 8]] });
  const c = rect("C", 10, 12, 20, 8, { kind: "unit" });
  const layout: SiteLayout = { width: 40, depth: 20, zones: [corridor, a, b, mid, c] };

  test("corridors: rooms are left and entered through their doors, other rooms are never crossed", () => {
    const r = grid(layout).route([5, 4], [35, 4]);
    expect(r.fallback).toBe(false);
    expect(r.points[0]).toEqual([5, 4]);
    expect(r.points[r.points.length - 1]).toEqual([35, 4]);
    for (const p of samples(r.points)) {
      expect(inZone(mid, p) || inZone(c, p)).toBe(false);
      // Everything is inside the corridor or one of the two end rooms (or on their shared edge).
      expect(inZone(corridor, p) || inZone(a, p) || inZone(b, p) || Math.abs(p[1] - 8) < 1e-6).toBe(true);
    }
    expect(distTo(r.points, [5, 8])).toBeLessThan(1.2);
    expect(distTo(r.points, [35, 8])).toBeLessThan(1.2);
    // String pulling keeps it short: a handful of corners, not one point per cell.
    expect(r.points.length).toBeLessThan(10);
    expect(pathLength(r.points)).toBeLessThan(30 + 2 * 8);
  });

  test("a room without doors is entered at the edge point nearest the path", () => {
    const r = grid(layout).route([20, 10], [20, 16]);
    expect(r.fallback).toBe(false);
    expect(pathLength(r.points)).toBeCloseTo(6, 0);
    expect(r.points.length).toBe(2);
  });

  test("no corridors: all space outside zones is walkable and zones are walked around", () => {
    const wall = rect("R", 10, 0, 10, 15);
    const r = grid({ width: 30, depth: 20, zones: [wall] }).route([5, 5], [25, 5]);
    expect(r.fallback).toBe(false);
    for (const p of samples(r.points)) expect(inZone(wall, p)).toBe(false);
    expect(Math.max(...r.points.map((p) => p[1]))).toBeGreaterThan(15);
  });

  test("a room with a door is entered only there", () => {
    const room = rect("R", 10, 0, 10, 15, { doors: [[15, 15]] });
    const r = grid({ width: 30, depth: 20, zones: [room] }).route([5, 5], [15, 7.5]);
    expect(r.fallback).toBe(false);
    expect(distTo(r.points, [15, 15])).toBeLessThan(1.2);
    expect(pathLength(r.points)).toBeGreaterThan(15);
  });

  test("unreachable goal falls back to a straight line", () => {
    const left = rect("hall", 0, 0, 5, 20, { kind: "corridor" });
    const room = rect("R", 20, 0, 10, 20, { doors: [[20, 10]] });
    const r = grid({ width: 30, depth: 20, zones: [left, room] }).route([2, 10], [25, 10]);
    expect(r).toEqual({ points: [[2, 10], [25, 10]], fallback: true });
  });

  test("a search over its time budget falls back to a straight line", () => {
    const zones = Array.from({ length: 30 }, (_, i) => rect(`w${i}`, 5 + i * 6, i % 2 ? 4 : 0, 2, 196));
    let t = 0;
    const g = grid({ width: 200, depth: 200, zones });
    const r = g.route([1, 1], [199, 199], { maxMs: 5, now: () => (t += 1) });
    expect(r.fallback).toBe(true);
    // A timed-out search is not remembered: with time it is found.
    expect(g.route([1, 1], [199, 199]).fallback).toBe(false);
  });

  test("points off the floor (Unassigned strip) join the route with a straight run", () => {
    const r = grid({ width: 30, depth: 20, zones: [] }).route([5, 26], [25, 5]);
    expect(r.fallback).toBe(false);
    expect(r.points[0]).toEqual([5, 26]);
    expect(r.points[1]).toEqual([5, 20]);
  });

  test("routes are cached per layout and stay fast", () => {
    // Benchmark-sized floor: 120 × 72, 12 zones, no corridors.
    const zones: Zone[] = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) zones.push(rect(`z${j}${i}`, 2 + i * 29.5, 2 + j * 23.3, 27.5, 21.3));
    const l: SiteLayout = { width: 120, depth: 72, zones };
    const g = navGridFor(l);
    expect(navGridFor(l)).toBe(g);
    let s = 1;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 20; i++) g.route([rand() * 120, rand() * 72], [rand() * 120, rand() * 72], { maxMs: 10_000 }); // warm up the JIT
    const t0 = performance.now();
    const N = 200;
    let fallbacks = 0;
    for (let i = 0; i < N; i++) {
      const r = g.route([rand() * 120, rand() * 72], [rand() * 120, rand() * 72], { maxMs: 10_000 });
      if (r.fallback) fallbacks++;
    }
    const perPath = (performance.now() - t0) / N;
    expect(fallbacks).toBe(0);
    expect(perPath).toBeLessThan(5);
    const again = g.route([10, 10], [100, 60]);
    expect(g.route([10, 10], [100, 60])).toEqual(again);
  });
});
