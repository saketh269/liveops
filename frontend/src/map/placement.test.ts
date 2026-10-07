import type { Asset, SiteLayout } from "../api/types";
import {
  DEFAULT_DEPTH, DEFAULT_WIDTH, MIN_SPACING, PlacementCache, floorSize, packPolygon, placeAssets, pointInPolygon, resolveZone, type Pt,
} from "./placement";

const a = (id: string, zone?: string, extra: Partial<Asset> = {}): Asset =>
  ({ site_id: "s", asset_id: id, updated_ts: 0, zone, _sources: {}, ...extra });
const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const L: Pt[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]; // L-shape, concave

const layout: SiteLayout = {
  width: 100, depth: 60,
  zones: [
    { id: "icu", name: "ICU", polygon: rect(0, 0, 30, 20) },
    { id: "ward", name: "Ward A", polygon: L.map(([x, y]) => [x + 50, y + 10] as Pt) },
    { id: "tiny", name: "Tiny", polygon: rect(90, 50, 1, 1) },
  ],
};

describe("placement", () => {
  test("floor defaults to 100 × 60", () => {
    expect(floorSize(undefined)).toEqual({ width: DEFAULT_WIDTH, depth: DEFAULT_DEPTH });
    expect(floorSize({ width: 0, depth: -3 })).toEqual({ width: 100, depth: 60 });
    expect(floorSize({ width: 40, depth: 30 })).toEqual({ width: 40, depth: 30 });
  });

  test("pointInPolygon handles concave shapes", () => {
    expect(pointInPolygon(5, 5, L)).toBe(true);
    expect(pointInPolygon(15, 15, L)).toBe(false);
    expect(pointInPolygon(5, 15, L)).toBe(true);
  });

  test("zone matches by id, then name (case-insensitive)", () => {
    const zs = layout.zones!;
    expect(resolveZone(zs, "icu")?.id).toBe("icu");
    expect(resolveZone(zs, "ward a")?.id).toBe("ward");
    expect(resolveZone(zs, "ICU")?.id).toBe("icu");
    expect(resolveZone(zs, "Nope")).toBeUndefined();
    expect(resolveZone(zs, undefined)).toBeUndefined();
  });

  test("every packed point lies inside the polygon, with distinct positions", () => {
    for (const n of [1, 7, 50, 333]) {
      const { points } = packPolygon(L, n);
      expect(points).toHaveLength(n);
      for (const [x, y] of points) expect(pointInPolygon(x, y, L)).toBe(true);
      expect(new Set(points.map((p) => p.join())).size).toBe(n);
    }
  });

  test("assets land inside their zone polygon, deterministic regardless of input order", () => {
    const assets = [
      ...Array.from({ length: 40 }, (_, i) => a(`B${i}`, "ICU")),
      ...Array.from({ length: 25 }, (_, i) => a(`W${i}`, "Ward A")),
    ];
    const r1 = placeAssets(layout, assets);
    const r2 = placeAssets(layout, [...assets].reverse());
    for (const x of assets) expect(r2.positions.get(x.asset_id)).toEqual(r1.positions.get(x.asset_id));
    for (const x of assets) {
      const p = r1.positions.get(x.asset_id)!;
      const zone = layout.zones!.find((z) => z.id === p.zoneId)!;
      expect(zone.name).toBe(x.zone);
      expect(pointInPolygon(p.x, p.y, zone.polygon)).toBe(true);
      expect(p.level).toBe(0);
    }
    // natural id order: B2 before B10
    const b2 = r1.positions.get("B2")!, b10 = r1.positions.get("B10")!;
    expect(b2.y < b10.y || (b2.y === b10.y && b2.x < b10.x)).toBe(true);
    expect(r1.unassigned).toBeNull();
  });

  test("explicit x/y override zone packing", () => {
    const r = placeAssets(layout, [a("X", "ICU", { x: 12.5, y: "7" }), a("Y", undefined, { x: 70, y: 40 })]);
    expect(r.positions.get("X")).toMatchObject({ x: 12.5, y: 7, zoneId: "icu", unassigned: false });
    expect(r.positions.get("Y")).toMatchObject({ x: 70, y: 40, zoneId: null, unassigned: false });
    expect(r.unassigned).toBeNull();
  });

  test("unknown or missing zones go to the Unassigned strip below the floor", () => {
    const r = placeAssets(layout, [a("U1", "Mars"), a("U2"), ...Array.from({ length: 60 }, (_, i) => a(`Q${i}`, "Nowhere"))]);
    expect(r.unassigned).not.toBeNull();
    const u = r.unassigned!;
    expect(u.y).toBeGreaterThan(60);
    expect(u.h).toBeGreaterThan(2); // 62 assets wrap onto two rows of 50
    for (const p of r.positions.values()) {
      expect(p.unassigned).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(u.x);
      expect(p.x).toBeLessThanOrEqual(u.x + u.w);
      expect(p.y).toBeGreaterThanOrEqual(u.y);
      expect(p.y).toBeLessThanOrEqual(u.y + u.h);
    }
  });

  test("overflowing a tiny zone stacks assets in levels instead of escaping the polygon", () => {
    const r = placeAssets(layout, Array.from({ length: 10 }, (_, i) => a(`T${i}`, "Tiny")));
    expect(r.overflow).toEqual(["tiny"]);
    const ps = [...r.positions.values()];
    for (const p of ps) expect(pointInPolygon(p.x, p.y, layout.zones![2].polygon)).toBe(true);
    expect(Math.max(...ps.map((p) => p.level))).toBeGreaterThan(0);
    expect(packPolygon(rect(0, 0, 1, 1), 10).spacing).toBe(MIN_SPACING);
  });

  test("degenerate polygons are skipped (assets become unassigned)", () => {
    const r = placeAssets({ zones: [{ id: "bad", name: "Bad", polygon: [[0, 0], [1, 1]] }] }, [a("A", "Bad")]);
    expect(r.positions.get("A")!.unassigned).toBe(true);
  });

  test("handles 2,000 assets quickly", () => {
    const assets = Array.from({ length: 2000 }, (_, i) => a(`A${i}`, i % 3 === 0 ? "ICU" : i % 3 === 1 ? "Ward A" : "Mars"));
    const t = performance.now();
    const r = placeAssets(layout, assets);
    expect(performance.now() - t).toBeLessThan(500);
    expect(r.positions.size).toBe(2000);
  });

  test("cache returns the same result until something placement-relevant changes", () => {
    const c = new PlacementCache();
    const as = [a("A", "ICU"), a("B", "ICU")];
    const r1 = c.get(layout, as);
    expect(c.get(layout, [a("A", "ICU", { state: "busy" }), a("B", "ICU")])).toBe(r1);
    expect(c.get(layout, [a("A", "Ward A"), a("B", "ICU")])).not.toBe(r1);
  });
});
