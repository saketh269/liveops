// Deterministic placement of assets on the floor plan.
// Layout coordinates: x across the floor (0..width), y into the floor (0..depth).
//
// Anchors (ADR 0006/0007, LIVEOPS-102): a record whose `anchor` names another
// placed record on the site is drawn relative to it. A patient anchored to a bed
// lies in it (pose "lying") when its state is in_use; other people anchored to a
// bed stand at the bedside, facing it, fanned out. People whose zone is a bed id,
// or a room holding exactly one bed, are treated as anchored to that bed. An
// anchor that names nothing placed falls back to normal zone placement.
import type { Asset, SiteLayout, Zone } from "../api/types";
import { figureOf, isPerson } from "./figures";

export const DEFAULT_WIDTH = 100;
export const DEFAULT_DEPTH = 60;
/** Below this grid spacing assets stack in levels instead of shrinking further. */
export const MIN_SPACING = 0.6;
export const UNASSIGNED_GAP = 4;
export const UNASSIGNED_SPACING = 2;

export type Pt = [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

/** How a figure rests: people lie only in a bed (ADR 0007). */
export type Pose = "standing" | "lying";

export type Placement = {
  x: number;
  y: number;
  /** Resting direction (radians, atan2(dy, dx) in layout coordinates); undefined = the model's default. */
  heading?: number;
  /** "lying" for a patient in a bed; everything else stands. */
  pose: Pose;
  /** Asset this one is drawn relative to (its bed), or null. */
  anchorId: string | null;
  /** Where a walker steps to just before taking this place (the bedside of a bed it lies in). */
  approach?: Pt;
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
  const beds = new Set<string>();
  const loose: string[] = [];
  const overflow: string[] = [];

  const list = [...assets];
  const anchorOf = anchorResolver(zones, list);
  const anchored: Asset[] = [];

  for (const a of list) {
    if (anchorOf(a)) { anchored.push(a); continue; }
    const zone = resolveZone(zones, a.zone);
    const xy = explicitPosition(a);
    if (xy) {
      positions.set(a.asset_id, { x: xy[0], y: xy[1], zoneId: zone?.id ?? null, level: 0, size: 1, unassigned: false, pose: "standing", anchorId: null });
    } else if (zone) {
      const ids = byZone.get(zone.id) ?? [];
      ids.push(a.asset_id);
      byZone.set(zone.id, ids);
      if (figureOf(a) === "bed") beds.add(a.asset_id);
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
    if (ids.length === 1 && beds.has(ids[0])) {
      // A bed alone in its room: in the middle, pushed back from the door, foot towards the door.
      const { at, heading } = bedSpot(z);
      positions.set(ids[0], { x: at[0], y: at[1], heading, zoneId: z.id, level: 0, size: clampSize(Math.sqrt(polygonArea(z.polygon))), unassigned: false, pose: "standing", anchorId: null });
      continue;
    }
    ids.forEach((id, i) => {
      const [x, y] = slots[i % slots.length];
      positions.set(id, { x, y, zoneId: z.id, level: Math.floor(i / slots.length), size, unassigned: false, pose: "standing", anchorId: null });
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
      positions.set(id, { x: c * s + s / 2, y: unassigned!.y + r * s + s / 2, zoneId: null, level: 0, size: clampSize(s), unassigned: true, pose: "standing", anchorId: null });
    });
  }

  placeAnchored(zones, anchored, anchorOf, positions, list);

  return { positions, unassigned, overflow };
}

// ---- anchors ----

/** Bed footprint in units of the bed's `size` (figureGeometry: 1 long, 0.6 wide). */
const BED_HALF_WIDTH = 0.3;
const BED_HALF_LENGTH = 0.5;
/** Room a person standing at a bedside takes, in units of the bed's size. */
const BEDSIDE_CLEARANCE = 0.34;
/** Spacing along the bed between people fanned out on one side. */
const BEDSIDE_STEP = 0.36;

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** A patient lies in a bed when its state is in_use, or when no state is mapped (ADR 0007). */
export function liesInBed(a: Asset): boolean {
  const s = a.state;
  return s === undefined || s === null || s === "" || lower(s) === "in_use";
}

/** The `anchor` value as an asset id, or null. */
export function anchorField(a: Asset): string | null {
  const v = a.anchor;
  if (v === undefined || v === null || typeof v === "object" || typeof v === "boolean") return null;
  const t = String(v).trim();
  return t && t !== a.asset_id ? t : null;
}

/**
 * Returns, per asset, the id of the asset it is drawn at, or null. Only assets
 * with a known position of their own (an explicit x/y or a zone) and no anchor
 * of their own can be anchored to, so chains and cycles fall back to zones.
 */
export function anchorResolver(zones: readonly Zone[], assets: readonly Asset[]): (a: Asset) => string | null {
  const byId = new Map<string, Asset>();
  for (const a of assets) byId.set(a.asset_id, a);
  const zoneOf = new Map<Asset, Zone | undefined>();
  const zoneFor = (a: Asset) => {
    if (!zoneOf.has(a)) zoneOf.set(a, resolveZone(zones, a.zone));
    return zoneOf.get(a);
  };
  // Beds per zone (beds placed by zone only; an explicit x/y bed is matched by id).
  const bedsIn = new Map<string, string[]>();
  for (const a of assets) {
    if (figureOf(a) !== "bed" || explicitPosition(a)) continue;
    const z = zoneFor(a);
    if (!z) continue;
    const l = bedsIn.get(z.id) ?? [];
    l.push(a.asset_id);
    bedsIn.set(z.id, l);
  }
  const raw = (a: Asset): string | null => {
    const named = anchorField(a);
    if (named && byId.has(named)) return named;
    if (named || !isPerson(figureOf(a))) return null; // a missing anchor falls back to the zone
    const zv = a.zone === undefined || a.zone === null ? "" : String(a.zone);
    const byZoneId = zv && zv !== a.asset_id ? byId.get(zv) : undefined;
    if (byZoneId && figureOf(byZoneId) === "bed") return zv;
    const z = zoneFor(a);
    const inZone = z ? bedsIn.get(z.id) : undefined;
    if (!z || inZone?.length !== 1) return null;
    // A patient in a zone with exactly one bed is in that bed; staff only when the zone is that bed's room.
    return figureOf(a) === "patient" || z.kind === "room" ? inZone[0] : null;
  };
  const memo = new Map<string, string | null>();
  return (a: Asset) => {
    const hit = memo.get(a.asset_id);
    if (hit !== undefined) return hit;
    let out = raw(a);
    if (out) {
      const t = byId.get(out)!;
      if (raw(t) || (!explicitPosition(t) && !zoneFor(t))) out = null; // the target has no position of its own
    }
    memo.set(a.asset_id, out);
    return out;
  };
}

/** Where a bed rests in a room it has to itself: centred, pushed back from the door, foot towards the door. */
export function bedSpot(z: Zone): { at: Pt; heading: number } {
  const c = polygonCentroid(z.polygon);
  const doors = (z.doors ?? []).filter((d) => Array.isArray(d) && Number.isFinite(d[0]) && Number.isFinite(d[1]));
  if (!doors.length) {
    const b = polygonBounds(z.polygon);
    return { at: c, heading: b.h > b.w ? Math.PI / 2 : 0 };
  }
  let door = doors[0];
  for (const d of doors) if (Math.hypot(d[0] - c[0], d[1] - c[1]) < Math.hypot(door[0] - c[0], door[1] - c[1])) door = d;
  const vx = door[0] - c[0], vy = door[1] - c[1];
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) return { at: c, heading: 0 };
  const back = Math.min(len * 0.2, 1);
  const at: Pt = [c[0] - (vx / len) * back, c[1] - (vy / len) * back];
  return { at: pointInPolygon(at[0], at[1], z.polygon) ? at : c, heading: Math.atan2(vy, vx) };
}

/**
 * Bedside spot `k` around an anchor at `t`: alternating sides of the bed, then
 * further along it. Spots outside the anchor's zone are pulled in or moved to
 * the other side, so nobody stands in a wall.
 */
export function bedsideSpot(t: Placement, k: number, isBed: boolean, zone: Zone | undefined): Pt {
  const h = t.heading ?? 0;
  const ux = Math.cos(h), uy = Math.sin(h);
  const nx = -uy, ny = ux;
  const S = t.size;
  const half = (isBed ? BED_HALF_WIDTH : 0.5) * S;
  const j = Math.floor(k / 2);
  const along = (j % 2 === 1 ? 1 : -1) * Math.ceil(j / 2) * BEDSIDE_STEP * S;
  const alongC = isBed ? Math.max(-BED_HALF_LENGTH * S * 1.4, Math.min(BED_HALF_LENGTH * S * 1.4, along)) : along;
  const first = k % 2 === 0 ? 1 : -1;
  const at = (side: number, d: number): Pt => [t.x + nx * side * d + ux * alongC, t.y + ny * side * d + uy * alongC];
  const d0 = half + BEDSIDE_CLEARANCE * S;
  if (!zone) return at(first, d0);
  for (const side of [first, -first]) {
    for (let d = d0; d >= half * 0.6; d -= 0.1 * S) {
      const p = at(side, d);
      if (pointInPolygon(p[0], p[1], zone.polygon)) return p;
    }
  }
  return at(first, d0);
}

function placeAnchored(zones: readonly Zone[], anchored: Asset[], anchorOf: (a: Asset) => string | null, positions: Map<string, Placement>, all: readonly Asset[]) {
  const kinds = new Map(all.map((a) => [a.asset_id, figureOf(a)]));
  const groups = new Map<string, Asset[]>();
  for (const a of anchored) {
    const t = anchorOf(a)!;
    const l = groups.get(t) ?? [];
    l.push(a);
    groups.set(t, l);
  }
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  for (const tid of [...groups.keys()].sort(compareIds)) {
    const t = positions.get(tid);
    const members = groups.get(tid)!.sort((x, y) => compareIds(x.asset_id, y.asset_id));
    if (!t) continue; // cannot happen: the resolver only names placed assets
    const isBed = kinds.get(tid) === "bed";
    const zone = t.zoneId ? zoneById.get(t.zoneId) : undefined;
    const heading = t.heading ?? 0;
    const sleeper = isBed ? members.find((m) => figureOf(m) === "patient" && liesInBed(m)) : undefined;
    if (sleeper) {
      positions.set(sleeper.asset_id, {
        x: t.x, y: t.y, heading, zoneId: t.zoneId, level: 0, size: t.size, unassigned: t.unassigned,
        pose: "lying", anchorId: tid, approach: bedsideSpot(t, 0, true, zone),
      });
    }
    let k = 0;
    for (const m of members) {
      if (m === sleeper) continue;
      const [x, y] = bedsideSpot(t, k++, isBed, zone);
      positions.set(m.asset_id, {
        x, y, heading: Math.atan2(t.y - y, t.x - x), zoneId: t.zoneId, level: 0, size: t.size, unassigned: t.unassigned,
        pose: "standing", anchorId: tid,
      });
    }
  }
}

/** Key that changes only when something affecting placement changes (order-sensitive; a reorder just recomputes). */
export function placementKey(layout: SiteLayout | null | undefined, assets: Iterable<Asset>): string {
  const parts: string[] = [];
  // anchor, role and whether a patient lies in bed change anchored placement and pose; other state changes don't.
  for (const a of assets) parts.push(`${a.asset_id}\u0001${a.zone ?? ""}\u0001${a.x ?? ""}\u0001${a.y ?? ""}\u0001${a.kind ?? ""}\u0001${anchorField(a) ?? ""}\u0001${a.role ?? ""}\u0001${figureOf(a) === "patient" && liesInBed(a) ? 1 : 0}`);
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
