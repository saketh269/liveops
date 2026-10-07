import type { Asset, SiteLayout } from "../api/types";
import {
  assetFloorId, assetsOnFloor, countByFloor, entrancesOf, firstFloorId, fitPlan, floorLayout, floorsOf, nearestEdgePoint,
  planAssetIds, planView, resolveFloor, zonesOnFloor,
} from "./floors";
import { placeAssets } from "./placement";

const sq = (x: number, y: number, s = 10): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const a = (id: string, extra: Partial<Asset> = {}): Asset => ({ site_id: "s", asset_id: id, updated_ts: 0, _sources: {}, ...extra });

const old: SiteLayout = { width: 80, depth: 40, zones: [{ id: "icu", name: "ICU", polygon: sq(0, 0) }] };
const multi: SiteLayout = {
  width: 100, depth: 60,
  floors: [
    { id: "l2", name: "Level 2", level: 2, width: 50, depth: 30 },
    { id: "g", name: "Ground", level: 0, width: 120, depth: 70, plan: { asset_id: "p1", x: 0, y: 0, w: 120, h: 70 } },
    { id: "l1", name: "Level 1", level: 1, width: 0, depth: -5 },
  ],
  zones: [
    { id: "er", name: "ER", polygon: sq(0, 0) },
    { id: "ward", name: "Ward", polygon: sq(0, 0), floor_id: "l1" },
    { id: "lab", name: "Lab", polygon: sq(20, 0), floor_id: "l2" },
    { id: "lost", name: "Lost", polygon: sq(30, 0), floor_id: "gone" },
  ],
  entrances: [{ id: "e1", name: "Side door", point: [5, 70], kind: "walk" }],
};

test("an old layout has one implicit main floor with its size", () => {
  expect(floorsOf(old)).toEqual([{ id: "main", name: "Main floor", level: 0, width: 80, depth: 40 }]);
  expect(floorsOf(null)[0]).toMatchObject({ id: "main", width: 100, depth: 60 });
  expect(floorsOf({ floors: [] })[0].id).toBe("main");
  expect(zonesOnFloor(old, "main").map((z) => z.id)).toEqual(["icu"]);
});

test("old layouts pass through floor helpers unchanged", () => {
  expect(floorLayout(old, "main")).toBe(old);
  const assets = new Map([["1", a("1", { zone: "ICU" })], ["2", a("2", { zone: "nowhere" })]]);
  expect(assetsOnFloor(old, assets, "main")).toBe(assets);
  expect(placeAssets(floorLayout(old, "main"), assets.values())).toEqual(placeAssets(old, assets.values()));
});

test("floors are sorted by level and sanitised", () => {
  const fs = floorsOf(multi);
  expect(fs.map((f) => f.id)).toEqual(["g", "l1", "l2"]);
  expect(fs[1]).toMatchObject({ width: 100, depth: 60 }); // bad size falls back to the layout's
  expect(firstFloorId(multi)).toBe("g");
});

test("zones without a known floor are on the first floor", () => {
  expect(zonesOnFloor(multi, "g").map((z) => z.id)).toEqual(["er", "lost"]);
  expect(zonesOnFloor(multi, "l1").map((z) => z.id)).toEqual(["ward"]);
  expect(zonesOnFloor(multi, "l2").map((z) => z.id)).toEqual(["lab"]);
});

test("asset floor: explicit floor by id or name, else its zone's floor, else the first", () => {
  expect(assetFloorId(multi, a("1", { floor: "l2" }))).toBe("l2");
  expect(assetFloorId(multi, a("1", { floor: " level 1 " }))).toBe("l1");
  expect(assetFloorId(multi, a("1", { floor: "Level 2", zone: "Ward" }))).toBe("l2"); // explicit wins
  expect(assetFloorId(multi, a("1", { zone: "ward" }))).toBe("l1");
  expect(assetFloorId(multi, a("1", { zone: "Lab" }))).toBe("l2");
  expect(assetFloorId(multi, a("1", { floor: "roof", zone: "Lab" }))).toBe("l2"); // unknown floor: use the zone
  expect(assetFloorId(multi, a("1", { zone: "nowhere" }))).toBe("g");
  expect(assetFloorId(multi, a("1"))).toBe("g");
  expect(resolveFloor(multi, "")).toBeUndefined();
});

test("a floor layout holds only that floor's zones, size and entrances", () => {
  const l1 = floorLayout(multi, "l1");
  expect(l1).toMatchObject({ width: 100, depth: 60, zones: [{ id: "ward" }], entrances: [] });
  expect(l1.floors).toHaveLength(1);
  const g = floorLayout(multi, "g");
  expect(g.zones!.map((z) => z.id)).toEqual(["er", "lost"]);
  expect(g.entrances!.map((e) => e.id)).toEqual(["e1"]);
  expect(floorLayout(multi, "missing").floors![0].id).toBe("g");
});

test("assets on a floor and counts per floor", () => {
  const assets = new Map([
    ["1", a("1", { zone: "ER" })], ["2", a("2", { zone: "Ward" })], ["3", a("3", { floor: "l2" })], ["4", a("4")],
  ]);
  expect([...assetsOnFloor(multi, assets, "g").keys()]).toEqual(["1", "4"]);
  expect([...assetsOnFloor(multi, assets, "l2").keys()]).toEqual(["3"]);
  expect(Object.fromEntries(countByFloor(multi, assets.values()))).toEqual({ g: 2, l1: 1, l2: 1 });
  // On its floor, an asset in a zone of that floor is placed in that zone.
  const placed = placeAssets(floorLayout(multi, "l1"), assetsOnFloor(multi, assets, "l1").values());
  expect(placed.positions.get("2")!.zoneId).toBe("ward");
});

test("entrances: own ones, else defaults (ambulance only on the first floor)", () => {
  expect(entrancesOf(multi, "g").map((e) => e.id)).toEqual(["e1"]);
  expect(entrancesOf(multi, "l1")).toEqual([{ id: "default-walk", name: "Main entrance", floor_id: "l1", point: [50, 60], kind: "walk" }]);
  expect(entrancesOf(old, "main")).toEqual([
    { id: "default-walk", name: "Main entrance", floor_id: "main", point: [40, 40], kind: "walk" },
    { id: "default-ambulance", name: "Ambulance bay", floor_id: "main", point: [0, 40], kind: "ambulance" },
  ]);
  expect(entrancesOf(old, "nope")).toEqual([]);
});

test("fit plan keeps the image aspect and centres it", () => {
  expect(fitPlan({ width: 100, depth: 60 }, 2000, 1000)).toEqual({ x: 0, y: 5, w: 100, h: 50 });
  expect(fitPlan({ width: 100, depth: 60 }, 600, 1200)).toEqual({ x: 35, y: 0, w: 30, h: 60 });
  expect(fitPlan({ width: 100, depth: 60 }, 0, 0)).toEqual({ x: 0, y: 0, w: 100, h: 60 });
});

test("plan view and referenced plan ids", () => {
  const g = floorsOf(multi)[0];
  expect(planView("s 1", g)).toEqual({ url: "/api/sites/s%201/plans/p1", x: 0, y: 0, w: 120, h: 70, opacity: 0.7 });
  expect(planView("s", { ...g, plan: { asset_id: "p", x: 0, y: 0, w: 0, h: 5 } })).toBeNull();
  expect(planView("s", { ...g, plan: { asset_id: "p", x: 1, y: 2, w: 5, h: 5, opacity: 3 } })!.opacity).toBe(1);
  expect(planView("s", undefined)).toBeNull();
  expect([...planAssetIds(multi)]).toEqual(["p1"]);
  expect(planAssetIds(old).size).toBe(0);
});

test("nearest edge point", () => {
  expect(nearestEdgePoint(sq(0, 0), [5, -1])).toEqual({ point: [5, 0], dist: 1, edge: 0 });
  expect(nearestEdgePoint(sq(0, 0), [12, 5])!.point).toEqual([10, 5]);
  expect(nearestEdgePoint([], [0, 0])).toBeNull();
});
