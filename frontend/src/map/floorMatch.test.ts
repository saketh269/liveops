import type { Asset, SiteLayout } from "../api/types";
import { assetFloorId, floorNumber, resolveFloor } from "./floors";

const named: SiteLayout = {
  floors: [
    { id: "main", name: "Main floor", level: 0, width: 50, depth: 30 },
    { id: "floor-2", name: "Floor 2", level: 1, width: 50, depth: 30 },
    { id: "floor-3", name: "Level 3", level: 2, width: 50, depth: 30 },
    { id: "b1", name: "Basement B1", level: -1, width: 50, depth: 30 },
  ],
  zones: [],
};
const asset = (floor: unknown): Asset => ({ site_id: "s", asset_id: "x", updated_ts: 0, _sources: {}, floor });

test("floor numbers in common spellings", () => {
  expect(floorNumber("2")).toBe(2);
  expect(floorNumber(2)).toBe(2);
  expect(floorNumber("Floor 2")).toBe(2);
  expect(floorNumber("level 03")).toBe(3);
  expect(floorNumber("2F")).toBe(2);
  expect(floorNumber("L4")).toBe(4);
  expect(floorNumber("2nd floor")).toBe(2);
  expect(floorNumber("B1")).toBe(-1);
  expect(floorNumber("Main floor")).toBeNull();
  expect(floorNumber("")).toBeNull();
});

test("a numeric floor value finds the floor by its name (the 'everything on Main floor' bug)", () => {
  expect(resolveFloor(named, 2)?.id).toBe("floor-2");
  expect(resolveFloor(named, "3")?.id).toBe("floor-3");
  expect(resolveFloor(named, "B1")?.id).toBe("b1");
  expect(assetFloorId(named, asset(2))).toBe("floor-2");
  expect(assetFloorId(named, asset(7))).toBe("b1"); // no such floor: the lowest floor, as before
});

test("ids and names still win over numbers", () => {
  const byId: SiteLayout = { floors: [
    { id: "1", name: "Floor 1", level: 0, width: 10, depth: 10 },
    { id: "2", name: "Floor 2", level: 1, width: 10, depth: 10 },
  ] };
  expect(resolveFloor(byId, 1)?.id).toBe("1");
  expect(resolveFloor(byId, "Floor 2")?.id).toBe("2");
});

test("a 0-based level never captures a floor number", () => {
  // The user's old site: "Main floor" (level 0) and "Floor 2" (level 1). Value 1 must not land on Floor 2.
  expect(resolveFloor(named, 1)).toBeUndefined();
});
