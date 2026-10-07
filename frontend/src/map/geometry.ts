// Pure geometry for the 2D layout editor. All values are layout units.
import type { Zone } from "../api/types";
import { polygonBounds, type Pt, type Rect } from "./placement";

export const MIN_ZONE = 1;
export const MIN_FLOOR = 10;
export const MAX_FLOOR = 2000;

export type Handle = "nw" | "ne" | "sw" | "se";

export function snap(v: number, step = 0.5): number {
  return Math.round(v / step) * step;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Rectangle spanned by two drag points, clipped to the floor. */
export function rectFromDrag(a: Pt, b: Pt, width: number, depth: number): Rect {
  const x0 = clamp(Math.min(a[0], b[0]), 0, width);
  const y0 = clamp(Math.min(a[1], b[1]), 0, depth);
  const x1 = clamp(Math.max(a[0], b[0]), 0, width);
  const y1 = clamp(Math.max(a[1], b[1]), 0, depth);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectToPolygon(r: Rect): Pt[] {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
}

/** Move a polygon by (dx, dy), stopping at the floor edges so it stays fully inside. */
export function translatePolygon(poly: readonly Pt[], dx: number, dy: number, width: number, depth: number): Pt[] {
  const b = polygonBounds(poly);
  const ddx = clamp(dx, -b.x, width - (b.x + b.w));
  const ddy = clamp(dy, -b.y, depth - (b.y + b.h));
  return poly.map(([x, y]) => [x + ddx, y + ddy]);
}

/** Map a polygon from one bounding rect to another (scales every vertex). */
export function fitPolygon(poly: readonly Pt[], to: Rect): Pt[] {
  const b = polygonBounds(poly);
  const sx = b.w > 0 ? to.w / b.w : 1;
  const sy = b.h > 0 ? to.h / b.h : 1;
  return poly.map(([x, y]) => [to.x + (x - b.x) * sx, to.y + (y - b.y) * sy]);
}

/** Drag a corner handle to (px, py); the opposite corner stays fixed. */
export function resizePolygon(poly: readonly Pt[], handle: Handle, px: number, py: number, width: number, depth: number): Pt[] {
  const b = polygonBounds(poly);
  const fx = handle === "nw" || handle === "sw" ? b.x + b.w : b.x; // fixed x
  const fy = handle === "nw" || handle === "ne" ? b.y + b.h : b.y; // fixed y
  let x = clamp(px, 0, width);
  let y = clamp(py, 0, depth);
  if (handle === "nw" || handle === "sw") x = Math.min(x, fx - MIN_ZONE); else x = Math.max(x, fx + MIN_ZONE);
  if (handle === "nw" || handle === "ne") y = Math.min(y, fy - MIN_ZONE); else y = Math.max(y, fy + MIN_ZONE);
  const r: Rect = { x: Math.min(x, fx), y: Math.min(y, fy), w: Math.abs(x - fx), h: Math.abs(y - fy) };
  return fitPolygon(poly, r);
}

/** Set a zone's bounds from numeric inputs, keeping it inside the floor and at least MIN_ZONE. */
export function setBounds(poly: readonly Pt[], r: Rect, width: number, depth: number): Pt[] {
  const w = clamp(r.w, MIN_ZONE, width);
  const h = clamp(r.h, MIN_ZONE, depth);
  const x = clamp(r.x, 0, width - w);
  const y = clamp(r.y, 0, depth - h);
  return fitPolygon(poly, { x, y, w, h });
}

export function uniqueZoneId(zones: readonly Zone[], base = "zone"): string {
  const ids = new Set(zones.map((z) => z.id));
  for (let i = zones.length + 1; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function nextZoneName(zones: readonly Zone[]): string {
  const names = new Set(zones.map((z) => z.name));
  for (let i = zones.length + 1; ; i++) if (!names.has(`Zone ${i}`)) return `Zone ${i}`;
}

/** Problems that block saving, each phrased so the user knows how to fix it. */
export function validateLayout(zones: readonly Zone[], width: number, depth: number): string[] {
  const out: string[] = [];
  if (!(width >= MIN_FLOOR && width <= MAX_FLOOR) || !(depth >= MIN_FLOOR && depth <= MAX_FLOOR)) {
    out.push(`Floor size must be between ${MIN_FLOOR} and ${MAX_FLOOR} on each side.`);
  }
  const seen = new Map<string, number>();
  for (const z of zones) {
    const name = z.name.trim();
    if (!name) out.push(`Zone ${z.id} has no name. Give it a name so assets can be matched to it.`);
    else seen.set(name.toLowerCase(), (seen.get(name.toLowerCase()) ?? 0) + 1);
    const b = polygonBounds(z.polygon);
    const eps = 1e-6;
    if (b.x < -eps || b.y < -eps || b.x + b.w > width + eps || b.y + b.h > depth + eps) {
      out.push(`Zone "${name || z.id}" extends past the ${width} × ${depth} floor. Move or resize it, or make the floor larger.`);
    }
  }
  for (const [name, n] of seen) if (n > 1) out.push(`${n} zones are named "${name}". Zone names must be unique so assets land in the right one.`);
  return out;
}
