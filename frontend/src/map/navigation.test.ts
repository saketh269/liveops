import type { SiteLayout, Zone } from "../api/types";
import { NavGrid, corridorEnds, navFloorOf, navGridFor } from "./navigation";
import { type Pt } from "./placement";
import { expectClearOfWalls, samples } from "./testdata/wallCheck";

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Zone> = {}): Zone =>
  ({ id, name: id, polygon: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], ...extra });

const pathLength = (pts: Pt[]) => pts.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

const nearest = (pts: Pt[], q: Pt) => Math.min(...samples(pts).map((p) => Math.hypot(p[0] - q[0], p[1] - q[1])));

describe("navFloorOf", () => {
  test("an old layout: its size, zones and own entrances only (no made-up openings in the walls)", () => {
    const f = navFloorOf({ width: 80, depth: 40, zones: [] });
    expect([f.width, f.depth]).toEqual([80, 40]);
    expect(f.entrances).toEqual([]);
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
});

describe("routes on the wall plan", () => {
  // 40 × 20 floor: a corridor along y 8..12, rooms above it with doors onto it, a room below without doors.
  const corridor = rect("hall", 0, 8, 40, 4, { kind: "corridor" });
  const a = rect("A", 0, 0, 10, 8, { kind: "room", doors: [[5, 8]] });
  const b = rect("B", 30, 0, 10, 8, { kind: "room", doors: [[35, 8]] });
  const mid = rect("M", 12, 0, 16, 8, { kind: "room", doors: [[20, 8]] });
  const c = rect("C", 10, 12, 20, 8, { kind: "room" });
  const layout: SiteLayout = { width: 40, depth: 20, zones: [corridor, a, b, mid, c] };

  test("rooms are left and entered through their door gaps, never through a wall", () => {
    const g = new NavGrid(navFloorOf(layout));
    const r = g.route([5, 4], [35, 4]);
    expect(r.reached).toBe(true);
    expect(r.points[0]).toEqual([5, 4]);
    expect(r.points[r.points.length - 1]).toEqual([35, 4]);
    expectClearOfWalls(g.plan, r);
    expect(nearest(r.points, [5, 8])).toBeLessThan(0.5);
    expect(nearest(r.points, [35, 8])).toBeLessThan(0.5);
    expect(r.points.length).toBeLessThan(10); // string pulled: a handful of corners
    expect(pathLength(r.points)).toBeLessThan(30 + 2 * 8);
  });

  test("a room without doors is entered through the gap the 3D world draws on its corridor side", () => {
    const g = new NavGrid(navFloorOf(layout));
    const r = g.route([20, 10], [14, 18]);
    expect(r.reached).toBe(true);
    expectClearOfWalls(g.plan, r);
    expect(nearest(r.points, [20, 12])).toBeLessThan(0.5); // the gap is in the middle of its top edge
  });

  test("zones without walls (units, untyped areas) are walked through, as drawn", () => {
    const g = new NavGrid(navFloorOf({ width: 30, depth: 20, zones: [rect("U", 10, 0, 10, 15, { kind: "unit" })] }));
    const r = g.route([5, 5], [25, 5]);
    expect(r).toEqual({ points: [[5, 5], [25, 5]], reached: true });
  });

  test("short runs inside a room stay straight", () => {
    const g = new NavGrid(navFloorOf(layout));
    expect(g.route([3, 3], [7, 5])).toEqual({ points: [[3, 3], [7, 5]], reached: true });
  });

  test("corridors are preferred over open floor", () => {
    // Open floor above and below a corridor; going along, the walker keeps to the corridor.
    const l: SiteLayout = { width: 40, depth: 30, zones: [rect("hall", 0, 12, 40, 6, { kind: "corridor" }), rect("R", 15, 0, 10, 24, { kind: "room", doors: [[15, 15], [25, 15]] })] };
    const g = new NavGrid(navFloorOf(l));
    const r = g.route([2, 15], [38, 15]);
    expect(r.reached).toBe(true);
    expectClearOfWalls(g.plan, r);
    for (const p of samples(r.points)) expect(p[1] > 12 && p[1] < 18).toBe(true);
  });

  test("unreachable: walks to the nearest reachable point and says so; never through the wall", () => {
    // A room whose only door is on the building wall (no opening there): sealed.
    const sealed = rect("S", 20, 0, 10, 8, { kind: "room", doors: [[25, 0]] });
    const g = new NavGrid(navFloorOf({ width: 40, depth: 20, zones: [sealed] }));
    const r = g.route([5, 15], [25, 4]);
    expect(r.reached).toBe(false);
    expectClearOfWalls(g.plan, r);
    const end = r.points[r.points.length - 1];
    expect(Math.hypot(end[0] - 25, end[1] - 8)).toBeLessThan(1.2); // just outside the room, below its goal
  });

  test("off the floor (Unassigned strip): no walk, the figure is put in place", () => {
    const g = new NavGrid(navFloorOf({ width: 30, depth: 20, zones: [] }));
    expect(g.route([5, 26], [25, 5])).toEqual({ points: [[5, 26]], reached: false });
  });

  test("a point inside a wall's band snaps to the walkable side it is on", () => {
    const g = new NavGrid(navFloorOf(layout));
    const r = g.route([3, 7.95], [37, 3]); // just inside A, in its corridor wall
    expect(r.reached).toBe(true);
    expectClearOfWalls(g.plan, r, { startsInWall: true });
    expect(r.points[1][1]).toBeLessThan(7.95); // stepped back into A, not through the wall
  });

  test("walk(): legs in turn, through every waypoint", () => {
    const g = new NavGrid(navFloorOf(layout));
    const r = g.walk([[5, 4], [20, 10], [35, 4]]);
    expect(r.reached).toBe(true);
    expect(r.points).toContainEqual([20, 10]);
    expectClearOfWalls(g.plan, r);
  });

  test("routes are cached per layout and stay fast on a fine grid", () => {
    const zones: Zone[] = [rect("hall", 0, 30, 120, 10, { kind: "corridor" })];
    for (let i = 0; i < 12; i++) {
      zones.push(rect(`t${i}`, i * 10, 0, 10, 30, { kind: "room", doors: [[i * 10 + 5, 30]] }));
      zones.push(rect(`b${i}`, i * 10, 40, 10, 32, { kind: "room", doors: [[i * 10 + 5, 40]] }));
    }
    const l: SiteLayout = { width: 120, depth: 72, zones };
    const g = navGridFor(l);
    expect(navGridFor(l)).toBe(g);
    expect(g.cell).toBeLessThanOrEqual(0.3);
    let s = 1;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = (): Pt => [1 + rand() * 118, 1 + rand() * 70];
    for (let i = 0; i < 20; i++) g.route(pick(), pick()); // warm up the JIT
    const t0 = performance.now();
    const N = 100;
    for (let i = 0; i < N; i++) expect(g.route(pick(), pick()).reached).toBe(true);
    expect((performance.now() - t0) / N).toBeLessThan(25);
    const again = g.route([15, 10], [100, 60]);
    expect(g.route([15, 10], [100, 60])).toEqual(again);
  });
});

describe("entrances and cores", () => {
  const rect2 = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const upper: SiteLayout = { width: 20, depth: 25, zones: [
    { id: "R1", name: "R1", kind: "room", polygon: rect2(0, 0, 4, 7), doors: [[2, 7]] },
    { id: "C", name: "Corridor", kind: "corridor", polygon: rect2(0, 7, 20, 9) },
  ] };

  test("corridor ends stand for the lift and stair cores, a metre inside the building", () => {
    expect(corridorEnds(navFloorOf(upper))).toEqual([[1, 11.5], [19, 11.5]]);
    const g = navGridFor(upper);
    const west = g.exitNear([2, 3], "walk")!, east = g.exitNear([18, 3], "walk")!;
    expect(west[0]).toBeLessThan(2);
    expect(east[0]).toBeGreaterThan(18);
    for (const p of [west, east]) expect(g.walkable(p)).toBe(true);
  });

  test("corridors that continue into each other have no core at the joint", () => {
    const f = navFloorOf({ width: 40, depth: 10, zones: [
      { id: "a", name: "a", kind: "corridor", polygon: rect2(0, 0, 20, 4) },
      { id: "b", name: "b", kind: "corridor", polygon: rect2(20, 0, 20, 4) },
    ] });
    expect(corridorEnds(f).map((p) => p[0])).toEqual([1, 39]);
  });

  test("own entrances win; a spot on the building wall moves just inside", () => {
    const g = navGridFor({ ...upper, entrances: [{ id: "e", name: "E", point: [10, 25], kind: "walk" }] });
    const p = g.exitNear([2, 3], "walk")!;
    expect(Math.hypot(p[0] - 10, p[1] - 25)).toBeLessThan(0.8);
    expect(p[1]).toBeLessThan(25);
    expect(g.walkable(p)).toBe(true);
  });

  test("no corridors and no entrances: the middle of the floor; vehicles have no way in", () => {
    const g = navGridFor({ width: 30, depth: 20, zones: [] });
    const p = g.exitNear([0, 0], "walk")!;
    expect(Math.hypot(p[0] - 15, p[1] - 10)).toBeLessThan(0.5);
    expect(g.exitNear([0, 0], "ambulance")).toBeNull();
  });
});
