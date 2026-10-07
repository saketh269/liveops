// Deterministic placement of assets on the floor plan.
// Layout coordinates: x across the floor (0..width), y into the floor (0..depth).
import type { Asset, SiteLayout, Zone } from "../api/types";

export const DEFAULT_WIDTH = 100;
export const DEFAULT_DEPTH = 60;
/** Below this grid spacing assets stack in levels instead of shrinking further. */
export const MIN_SPACING = 0.6;
export const UNASSIGNED_GAP = 4;
export const UNASSIGNED_SPACING = 2;

export type Pt = [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

export type Placement = {
  x: number;
  y: number;
  /** Zone id the asset is drawn in; null for the Unassigned strip or explicit positions outside zones. */
  zoneId: string | null;
  /** Stack level (0 = on the floor). Only above 0 when a zone overflows. */
  level: number;
  /** Footprint edge length for drawing. */
  size: number;
  unassigned: boolean;
};

export type PlacementResult = {
  positions: Map<string, Placement>;
  /** Strip outside the floor holding assets whose zone is unknown; null when empty. */
  unassigned: Rect | null;
  /** Zone ids that could not fit all assets at MIN_SPACING. */
  overflow: string[];
};

export function floorSize(layout: SiteLayout | null | undefined): { width: number; depth: number } {
  const w = Number(layout?.width);
  const d = Number(layout?.depth);
  return { width: w > 0 ? w : DEFAULT_WIDTH, depth: d > 0 ? d : DEFAULT_DEPTH };
}

/** Ray-casting point-in-polygon (edges count as outside for robustness). */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

export function polygonBounds(poly: readonly Pt[]): Rect {
  if (!poly.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Area-weighted centroid; falls back to the bounds centre for degenerate polygons. */
export function polygonCentroid(poly: readonly Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const b = polygonBounds(poly);
    return [b.x + b.w / 2, b.y + b.h / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function gridPoints(poly: readonly Pt[], b: Rect, s: number): Pt[] {
  const pts: Pt[] = [];
  for (let y = b.y + s / 2; y < b.y + b.h; y += s) {
    for (let x = b.x + s / 2; x < b.x + b.w; x += s) {
      if (pointInPolygon(x, y, poly)) pts.push([x, y]);
    }
  }
  return pts;
}

/**
 * Grid-pack `n` slots inside a polygon, row by row. Spacing starts at
 * sqrt(area / n) and shrinks until everything fits or MIN_SPACING is reached.
 * Returns fewer than `n` points only on overflow.
 */
export function packPolygon(poly: readonly Pt[], n: number): { points: Pt[]; spacing: number } {
  if (n <= 0 || poly.length < 3) return { points: [], spacing: 0 };
  const b = polygonBounds(poly);
  const area = polygonArea(poly);
  if (area <= 0) return { points: [], spacing: 0 };
  let s = Math.sqrt(area / n);
  for (let i = 0; i < 60; i++) {
    if (s <= MIN_SPACING) break;
    const pts = gridPoints(poly, b, s);
    if (pts.length >= n) return { points: pts.slice(0, n), spacing: s };
    s *= 0.92;
  }
  s = MIN_SPACING;
  return { points: gridPoints(poly, b, s), spacing: s };
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });
export const compareIds = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** Match an asset's `zone` value to a zone by id, then by name (case-insensitive). */
export function resolveZone(zones: readonly Zone[], value: unknown): Zone | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value);
  const lv = v.trim().toLowerCase();
  return zones.find((z) => z.id === v)
    ?? zones.find((z) => (z.name ?? "").trim().toLowerCase() === lv)
    ?? zones.find((z) => z.id.toLowerCase() === lv);
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Explicit position from the asset's reserved `x`/`y` fields, if both are numeric. */
export function explicitPosition(a: Asset): Pt | null {
  const x = num(a.x);
  const y = num(a.y);
  return x === null || y === null ? null : [x, y];
}

const clampSize = (s: number) => Math.min(1.6, Math.max(0.3, s * 0.72));

export function placeAssets(layout: SiteLayout | null | undefined, assets: Iterable<Asset>): PlacementResult {
  const zones = (layout?.zones ?? []).filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3);
  const { width, depth } = floorSize(layout);
  const positions = new Map<string, Placement>();
  const byZone = new Map<string, string[]>();
  const loose: string[] = [];
  const overflow: string[] = [];

  for (const a of assets) {
    const zone = resolveZone(zones, a.zone);
    const xy = explicitPosition(a);
    if (xy) {
      positions.set(a.asset_id, { x: xy[0], y: xy[1], zoneId: zone?.id ?? null, level: 0, size: 1, unassigned: false });
    } else if (zone) {
      const list = byZone.get(zone.id) ?? [];
      list.push(a.asset_id);
      byZone.set(zone.id, list);
    } else {
      loose.push(a.asset_id);
    }
  }

  for (const z of zones) {
    const ids = byZone.get(z.id);
    if (!ids) continue;
    ids.sort(compareIds);
    const { points, spacing } = packPolygon(z.polygon, ids.length);
    const slots: Pt[] = points.length ? points : [polygonCentroid(z.polygon)];
    if (slots.length < ids.length) overflow.push(z.id);
    const size = clampSize(spacing || MIN_SPACING);
    ids.forEach((id, i) => {
      const [x, y] = slots[i % slots.length];
      positions.set(id, { x, y, zoneId: z.id, level: Math.floor(i / slots.length), size, unassigned: false });
    });
  }

  let unassigned: Rect | null = null;
  if (loose.length) {
    loose.sort(compareIds);
    const s = UNASSIGNED_SPACING;
    const cols = Math.max(1, Math.floor(width / s));
    const rows = Math.ceil(loose.length / cols);
    unassigned = { x: 0, y: depth + UNASSIGNED_GAP, w: width, h: rows * s };
    loose.forEach((id, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      positions.set(id, { x: c * s + s / 2, y: unassigned!.y + r * s + s / 2, zoneId: null, level: 0, size: clampSize(s), unassigned: true });
    });
  }

  return { positions, unassigned, overflow };
}

/** Key that changes only when something affecting placement changes (order-sensitive; a reorder just recomputes). */
export function placementKey(layout: SiteLayout | null | undefined, assets: Iterable<Asset>): string {
  const parts: string[] = [];
  for (const a of assets) parts.push(`${a.asset_id}\u0001${a.zone ?? ""}\u0001${a.x ?? ""}\u0001${a.y ?? ""}\u0001${a.kind ?? ""}`);
  return `${JSON.stringify(layout ?? null)}\u0002${parts.join("\u0002")}`;
}

/** Memoises placeAssets: returns the same object while the placement key is unchanged. */
export class PlacementCache {
  private key = "";
  private result: PlacementResult | null = null;
  get(layout: SiteLayout | null | undefined, assets: Iterable<Asset>): PlacementResult {
    const list = [...assets];
    const key = placementKey(layout, list);
    if (this.result && key === this.key) return this.result;
    this.key = key;
    this.result = placeAssets(layout, list);
    return this.result;
  }
}
