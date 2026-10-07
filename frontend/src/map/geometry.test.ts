import type { Zone } from "../api/types";
import {
  MIN_ZONE, fitPolygon, nextZoneName, rectFromDrag, rectToPolygon, resizePolygon, setBounds, snap, translatePolygon, uniqueZoneId,
  validateLayout,
} from "./geometry";
import { polygonBounds } from "./placement";

const z = (id: string, name: string, x: number, y: number, w: number, h: number): Zone => ({ id, name, polygon: rectToPolygon({ x, y, w, h }) });

describe("editor geometry", () => {
  test("drag in any direction gives a normalised rect clipped to the floor", () => {
    expect(rectFromDrag([10, 20], [4, 5], 100, 60)).toEqual({ x: 4, y: 5, w: 6, h: 15 });
    expect(rectFromDrag([90, 50], [120, 80], 100, 60)).toEqual({ x: 90, y: 50, w: 10, h: 10 });
    expect(rectFromDrag([-5, -5], [3, 3], 100, 60)).toEqual({ x: 0, y: 0, w: 3, h: 3 });
  });

  test("snap rounds to the grid", () => {
    expect(snap(3.26)).toBe(3.5);
    expect(snap(3.24)).toBe(3);
    expect(snap(7, 5)).toBe(5);
  });

  test("move stops at floor edges", () => {
    const p = rectToPolygon({ x: 10, y: 10, w: 20, h: 10 });
    expect(polygonBounds(translatePolygon(p, 5, -3, 100, 60))).toEqual({ x: 15, y: 7, w: 20, h: 10 });
    expect(polygonBounds(translatePolygon(p, 500, 500, 100, 60))).toEqual({ x: 80, y: 50, w: 20, h: 10 });
    expect(polygonBounds(translatePolygon(p, -500, -500, 100, 60))).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  test("resize keeps the opposite corner fixed and enforces a minimum size", () => {
    const p = rectToPolygon({ x: 10, y: 10, w: 20, h: 10 });
    expect(polygonBounds(resizePolygon(p, "se", 40, 30, 100, 60))).toEqual({ x: 10, y: 10, w: 30, h: 20 });
    expect(polygonBounds(resizePolygon(p, "nw", 0, 5, 100, 60))).toEqual({ x: 0, y: 5, w: 30, h: 15 });
    expect(polygonBounds(resizePolygon(p, "ne", 2, 2, 100, 60))).toEqual({ x: 10, y: 2, w: MIN_ZONE, h: 18 });
    expect(polygonBounds(resizePolygon(p, "sw", -10, 999, 100, 60))).toEqual({ x: 0, y: 10, w: 30, h: 50 });
  });

  test("fitPolygon scales non-rect polygons into new bounds", () => {
    const tri: [number, number][] = [[0, 0], [10, 0], [0, 10]];
    expect(fitPolygon(tri, { x: 5, y: 5, w: 20, h: 5 })).toEqual([[5, 5], [25, 5], [5, 10]]);
  });

  test("setBounds clamps numeric input into the floor", () => {
    const p = rectToPolygon({ x: 0, y: 0, w: 10, h: 10 });
    expect(polygonBounds(setBounds(p, { x: 95, y: -4, w: 10, h: 0 }, 100, 60))).toEqual({ x: 90, y: 0, w: 10, h: MIN_ZONE });
  });

  test("new ids and names are unique", () => {
    const zs = [z("zone-1", "Zone 1", 0, 0, 1, 1), z("zone-3", "Zone 2", 0, 0, 1, 1)];
    expect(uniqueZoneId(zs)).toBe("zone-4");
    expect(nextZoneName(zs)).toBe("Zone 3");
  });

  test("validation explains what to fix", () => {
    expect(validateLayout([z("a", "ICU", 0, 0, 10, 10)], 100, 60)).toEqual([]);
    const out = validateLayout([z("a", "ICU", 95, 0, 10, 10), z("b", "icu", 0, 0, 5, 5), z("c", " ", 0, 0, 2, 2)], 100, 60);
    expect(out.some((m) => m.includes('"ICU" extends past'))).toBe(true);
    expect(out.some((m) => m.includes("2 zones are named"))).toBe(true);
    expect(out.some((m) => m.includes("has no name"))).toBe(true);
    expect(validateLayout([], 5, 60)[0]).toMatch(/Floor size/);
  });
});
