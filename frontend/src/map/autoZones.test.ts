import type { Asset } from "../api/types";
import { appendMissingZones, buildAutoLayout, stateCoverage, zoneCoverage } from "./autoZones";
import { placeAssets } from "./placement";
import { validateLayout } from "./geometry";

const a = (id: string, zone?: string, state?: string): Asset => ({ site_id: "s", asset_id: id, updated_ts: 0, zone, state, _sources: {} });
const template = { width: 100, depth: 60, zones: [
  { id: "zone-1", name: "Zone 1", polygon: [[0, 0], [20, 0], [20, 10], [0, 10]] as [number, number][] },
] };

test("coverage separates missing zones, no-zone assets and used zones", () => {
  const cov = zoneCoverage(template, [a("1", "ICU"), a("2", "ICU"), a("3", "ER"), a("4"), a("5", "zone 1")]);
  expect([...cov.missing]).toEqual([["ICU", 2], ["ER", 1]]);
  expect(cov.noZone).toBe(1);
  expect([...cov.used]).toEqual(["zone-1"]);
});

test("auto layout replaces unused template zones and places every asset", () => {
  const assets = [a("B1", "ICU"), a("B2", "ER"), a("B3", "General"), a("B4", "General")];
  const layout = buildAutoLayout(template, zoneCoverage(template, assets));
  expect(layout.zones!.map((z) => z.name)).toEqual(["ER", "General", "ICU"]);
  expect(validateLayout(layout.zones!, layout.width!, layout.depth!)).toEqual([]);
  const placed = placeAssets(layout, assets);
  expect(placed.unassigned).toBeNull();
  expect(zoneCoverage(layout, assets).missing.size).toBe(0);
});

test("append keeps existing zones in place and grows the floor", () => {
  const assets = [a("1", "Zone 1"), a("2", "ICU")];
  const layout = appendMissingZones(template, zoneCoverage(template, assets));
  expect(layout.zones![0]).toEqual(template.zones[0]);
  expect(layout.zones![1].name).toBe("ICU");
  expect(layout.depth!).toBeGreaterThan(60);
  expect(validateLayout(layout.zones!, layout.width!, layout.depth!)).toEqual([]);
});

test("many zones still fit and validate", () => {
  const assets = Array.from({ length: 23 }, (_, i) => a(String(i), `Ward ${i}`));
  const layout = buildAutoLayout({}, zoneCoverage({}, assets));
  expect(layout.zones).toHaveLength(23);
  expect(validateLayout(layout.zones!, layout.width!, layout.depth!)).toEqual([]);
});

test("state coverage lists unrecognised values", () => {
  const c = stateCoverage([a("1", "x", "occupied"), a("2", "x", "weird"), a("3", "x")]);
  expect(c).toMatchObject({ total: 3, colored: 1, noState: 1 });
  expect([...c.unrecognised]).toEqual([["weird", 1]]);
});

const floored = {
  width: 100, depth: 60,
  floors: [
    { id: "g", name: "Ground", level: 0, width: 100, depth: 60 },
    { id: "l1", name: "Level 1", level: 1, width: 60, depth: 40 },
  ],
  zones: [
    { id: "zone-er", name: "ER", polygon: [[0, 0], [20, 0], [20, 10], [0, 10]] as [number, number][], floor_id: "g" },
    { id: "zone-old", name: "Old", polygon: [[0, 0], [20, 0], [20, 10], [0, 10]] as [number, number][], floor_id: "l1" },
  ],
};

test("auto layout on a floor: only that floor's zones change, ids stay unique", () => {
  const cov = zoneCoverage(floored, [a("1", "ER"), a("2", "ICU"), a("4", "Old ")]);
  const layout = buildAutoLayout(floored, cov, "l1");
  expect(layout.zones!.filter((z) => z.floor_id === "g").map((z) => z.id)).toEqual(["zone-er"]);
  const l1 = layout.zones!.filter((z) => z.floor_id === "l1");
  expect(l1.map((z) => z.name)).toEqual(["Old", "ICU"]);
  expect(validateLayout(l1, 60, 40)).toEqual([]);
  expect(new Set(layout.zones!.map((z) => z.id)).size).toBe(layout.zones!.length);
  expect(layout.floors).toEqual(floored.floors);
});

test("append on a floor grows only that floor and avoids ids on other floors", () => {
  const withEr = { ...floored, zones: [...floored.zones, { id: "zone-icu", name: "Icu old", polygon: [], floor_id: "g" }] };
  const cov = zoneCoverage(withEr, [a("1", "ER"), a("2", "ICU")]);
  const layout = appendMissingZones(withEr, cov, "l1");
  const added = layout.zones!.find((z) => z.name === "ICU")!;
  expect(added.floor_id).toBe("l1");
  expect(added.id).toBe("zone-icu-2");
  expect(layout.floors![0]).toEqual(floored.floors[0]);
  expect(layout.floors![1].depth).toBeGreaterThan(40);
  expect(layout.depth).toBe(60); // top-level size follows the first floor
});

test("old layouts ignore the floor argument", () => {
  const cov = zoneCoverage(template, [a("1", "ICU")]);
  expect(buildAutoLayout(template, cov, "l1")).toEqual(buildAutoLayout(template, cov));
  expect(appendMissingZones(template, cov, "x")).toEqual(appendMissingZones(template, cov));
  expect(buildAutoLayout(template, cov).floors).toBeUndefined();
});
