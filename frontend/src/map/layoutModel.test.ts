import type { SiteLayout } from "../api/types";
import { translatePolygon } from "./geometry";
import {
  addFloor, deleteFloor, edgeMidpoint, edgeNames, fromEditModel, moveDoors, moveFloor, patchFloor, reshapeZone, toEditModel,
  toggleDoor, validateModel,
} from "./layoutModel";

const sq = (x: number, y: number, s = 10): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const old: SiteLayout = { width: 80, depth: 40, zones: [{ id: "icu", name: "ICU", polygon: sq(0, 0), color: "#123456" }] };

test("an old layout round-trips through the editor unchanged", () => {
  const m = toEditModel(old);
  expect(m.floors).toEqual([{ id: "main", name: "Main floor", level: 0, width: 80, depth: 40 }]);
  expect(m.zones[0].floor_id).toBe("main");
  expect(fromEditModel(old, m)).toEqual(old);
  expect(fromEditModel({ ...old, custom: 1 } as SiteLayout, m)).toHaveProperty("custom", 1);
});

test("adding a floor turns the layout into explicit floors", () => {
  const { model, id } = addFloor(toEditModel(old));
  expect(id).toBe("floor-2");
  expect(model.floors[1]).toEqual({ id: "floor-2", name: "Floor 2", level: 1, width: 80, depth: 40 });
  const saved = fromEditModel(old, model);
  expect(saved.floors!.map((f) => f.id)).toEqual(["main", "floor-2"]);
  expect(saved.zones![0].floor_id).toBe("main");
  expect(saved).toMatchObject({ width: 80, depth: 40, entrances: [] });
  // and back: deleting the extra floor restores the old shape
  expect(fromEditModel(old, deleteFloor(model, "floor-2"))).toEqual(old);
});

test("a plan or a renamed floor keeps explicit floors", () => {
  const m = toEditModel(old);
  expect(fromEditModel(old, patchFloor(m, "main", { name: "Ground" })).floors).toHaveLength(1);
  expect(fromEditModel(old, patchFloor(m, "main", { plan: { asset_id: "a", x: 0, y: 0, w: 8, h: 4 } })).floors![0].plan).toBeTruthy();
});

test("reorder swaps levels; zones stay on their floor", () => {
  let m = addFloor(addFloor(toEditModel(old)).model).model;
  m = { ...m, zones: [...m.zones, { id: "z2", name: "Lab", polygon: sq(0, 0), floor_id: "floor-3" }] };
  const moved = moveFloor(m, "floor-3", -1);
  expect(moved.floors.map((f) => [f.id, f.level])).toEqual([["main", 0], ["floor-3", 1], ["floor-2", 2]]);
  expect(moveFloor(moved, "main", -1)).toBe(moved);
  const saved = fromEditModel(old, moved);
  expect(saved.zones!.find((z) => z.id === "z2")!.floor_id).toBe("floor-3");
  expect(toEditModel(saved).floors.map((f) => f.id)).toEqual(["main", "floor-3", "floor-2"]);
});

test("delete removes a floor with its zones and entrances, never the last floor", () => {
  let m = addFloor(toEditModel(old)).model;
  m = { ...m, entrances: [{ id: "e", name: "Door", floor_id: "floor-2", point: [1, 1], kind: "walk" }] };
  const d = deleteFloor(m, "main");
  expect(d.floors.map((f) => f.id)).toEqual(["floor-2"]);
  expect(d.zones).toEqual([]);
  expect(d.entrances).toHaveLength(1);
  expect(deleteFloor(d, "floor-2")).toBe(d);
});

test("doors: click near an edge adds, click on a door removes, far clicks do nothing", () => {
  const z = { id: "r", name: "Room", polygon: sq(0, 0) };
  const added = toggleDoor(z, [4, 0.4], 1);
  expect(added).toEqual({ doors: [[4, 0]], change: "added" });
  const removed = toggleDoor({ ...z, doors: added.doors }, [4.3, 0.2], 1);
  expect(removed).toEqual({ doors: [], change: "removed" });
  expect(toggleDoor(z, [5, 5], 1).change).toBeNull();
});

test("doors follow their zone when it moves or is resized", () => {
  const poly = sq(0, 0);
  const moved = translatePolygon(poly, 5, 5, 100, 100);
  expect(moveDoors(poly, moved, [[4, 0], [10, 5]])).toEqual([[9, 5], [15, 10]]);
  const big = sq(0, 0, 20);
  expect(moveDoors(poly, big, [[10, 5]])).toEqual([[20, 10]]);
  expect(reshapeZone({ id: "a", name: "A", polygon: poly }, moved)).toEqual({ polygon: moved });
  expect(reshapeZone({ id: "a", name: "A", polygon: poly, doors: [[0, 5]] }, moved).doors).toEqual([[5, 10]]);
});

test("edge names and midpoints for keyboard door placement", () => {
  expect(edgeNames(sq(0, 0))).toEqual(["top", "right", "bottom", "left"]);
  expect(edgeNames([[0, 0], [10, 0], [5, 8]])).toEqual(["top", "edge 2", "edge 3"]);
  expect(edgeMidpoint(sq(0, 0), 2)).toEqual([5, 10]);
});

test("validation names the floor and explains the fix", () => {
  let m = addFloor(toEditModel(old)).model;
  m = patchFloor(m, "floor-2", { name: "Main floor" });
  m = { ...m, zones: [...m.zones, { id: "z", name: "Far", polygon: sq(75, 0), floor_id: "floor-2" }],
    entrances: [{ id: "e", name: " ", floor_id: "main", point: [100, 5], kind: "ambulance" }] };
  const problems = validateModel(m);
  expect(problems).toContain('On Main floor: Zone "Far" extends past the 80 × 40 floor. Move or resize it, or make the floor larger.');
  expect(problems).toContain("On Main floor: An entrance has no name. Name it, for example Main entrance.");
  expect(problems).toContain('On Main floor: Entrance "e" is outside the 80 × 40 floor. Move it onto the floor.');
  expect(problems).toContain('2 floors are named "main floor". Floor names must be different so assets can name their floor.');
  expect(validateModel(toEditModel(old))).toEqual([]);
  // single floor: no floor prefix
  const one = toEditModel({ ...old, zones: [{ id: "a", name: "", polygon: sq(0, 0) }] });
  expect(validateModel(one)[0]).toMatch(/^Zone a has no name/);
});
