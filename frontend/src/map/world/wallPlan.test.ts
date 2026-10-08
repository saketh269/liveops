import type { Zone } from "../../api/types";
import { floorLayout, floorsOf } from "../floors";
import { navGridFor } from "../navigation";
import type { Pt } from "../placement";
import { HS_LAYOUT } from "../testdata/hsLayout";
import { buildWorld } from "./build";
import { PALETTES, WORLD } from "./style";
import { planWalls } from "./walls";
import { WALL_CLEARANCE, deskBox, distToSeg, nurseDesk, segmentClear, wallPlanFor } from "./wallPlan";

const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const fonts = { data: "monospace", body: "sans-serif" };

describe("shared wall plan", () => {
  beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
  afterEach(() => { vi.restoreAllMocks(); });

  test.each(floorsOf(HS_LAYOUT).map((f) => f.id))("hs floor %s: the 3D builder draws exactly the walls navigation walks around", (id) => {
    const layout = floorLayout(HS_LAYOUT, id);
    // As scene.ts calls it.
    const world = buildWorld({
      width: layout.width!, depth: layout.depth!, zones: layout.zones ?? [], entrances: layout.entrances ?? [],
      ground: id === "1", palette: PALETTES.light, software: true, fonts,
    });
    const nav = navGridFor(layout);
    expect(world.plan).toBe(nav.plan); // one plan object, computed once
    expect(world.wallCount).toBe(nav.plan.inner.length + nav.plan.outer.length);
    // And it is the walls.ts plan of that floor, door gaps and all.
    const ref = planWalls({ width: layout.width!, depth: layout.depth!, zones: layout.zones ?? [], entrances: layout.entrances ?? [], doorWidth: WORLD.doorWidth });
    expect(nav.plan.inner).toEqual(ref.inner);
    expect(nav.plan.outer).toEqual(ref.outer);
  });

  test("walkable cells keep the clearance from every wall; door gaps are walkable", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(5, 5, 6, 6), doors: [[8, 11]] };
    const plan = wallPlanFor({ width: 20, depth: 20, zones: [room], entrances: [] });
    const { cell, cols, free } = plan.grid;
    for (let i = 0; i < free.length; i++) {
      if (!free[i]) continue;
      const p: Pt = [((i % cols) + 0.5) * cell, (Math.floor(i / cols) + 0.5) * cell];
      for (const w of plan.walls) expect(distToSeg(p, w.a, w.b)).toBeGreaterThanOrEqual(WALL_CLEARANCE);
    }
    const at = (x: number, y: number) => free[Math.floor(y / cell) * cols + Math.floor(x / cell)];
    expect(at(8.1, 11.1)).toBe(1); // in the doorway
    expect(at(6.1, 11.1)).toBe(0); // in the wall beside it
    expect(plan.doors).toHaveLength(1);
    expect(plan.grid.comp[Math.floor(8 / cell) * cols + Math.floor(8 / cell)]).toBe(plan.grid.comp[Math.floor(15 / cell) * cols + Math.floor(15 / cell)]);
  });

  test("nurse-station desks are obstacles, the same box the builder draws", () => {
    const ns: Zone = { id: "ED-NS", name: "ED-NS", kind: "waiting", polygon: rect(4, 4, 6, 3), doors: [[7, 4]] };
    const plan = wallPlanFor({ width: 14, depth: 11, zones: [ns], entrances: [] });
    expect(plan.desks).toEqual([deskBox(nurseDesk(ns))]);
    const { cell, cols, free } = plan.grid;
    expect(free[Math.floor(5.5 / cell) * cols + Math.floor(7 / cell)]).toBe(0);
    expect(plan.inner).toEqual([]); // stations have no walls
  });

  test("segmentClear: through a door gap yes, through a wall no", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(5, 5, 6, 6), doors: [[8, 11]] };
    const plan = wallPlanFor({ width: 20, depth: 20, zones: [room], entrances: [] });
    expect(segmentClear(plan, [8, 8], [8, 15], 0.2)).toBe(true);
    expect(segmentClear(plan, [6, 8], [6, 15], 0.2)).toBe(false);
    expect(segmentClear(plan, [8.6, 8], [8.6, 15], 0.2)).toBe(false); // too close to the gap's side
  });

  test("computed once per distinct floor", () => {
    const input = { width: 20, depth: 20, zones: [{ id: "r", name: "r", kind: "room" as const, polygon: rect(5, 5, 6, 6) }], entrances: [] };
    expect(wallPlanFor(input)).toBe(wallPlanFor({ ...input, zones: [...input.zones] }));
    expect(wallPlanFor(input)).not.toBe(wallPlanFor({ ...input, width: 21 }));
  });
});
