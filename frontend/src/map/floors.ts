// Floors of a site layout (ADR 0006). A layout without `floors` has one implicit
// floor, "main", sized by the layout's own width/depth, so 0.1 layouts behave as before.
import type { Asset, Entrance, Floor, FloorPlan, SiteLayout, Zone, ZoneKind } from "../api/types";
import { DEFAULT_DEPTH, DEFAULT_WIDTH, floorSize, resolveZone, type Pt } from "./placement";

export const MAIN_FLOOR_ID = "main";
export const ZONE_KINDS: readonly ZoneKind[] = ["unit", "room", "bay", "corridor", "waiting", "entrance"];
export const ZONE_KIND_LABELS: Record<ZoneKind, string> = {
  unit: "Unit or ward",
  room: "Room",
  bay: "Bay",
  corridor: "Corridor (walkable)",
  waiting: "Waiting area",
  entrance: "Entrance area",
};
export const DEFAULT_PLAN_OPACITY = 0.7;

const positive = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** True when the layout lists its floors explicitly (0.2 layouts). */
export function hasExplicitFloors(layout: SiteLayout | null | undefined): boolean {
  return Array.isArray(layout?.floors) && layout!.floors!.length > 0;
}

/**
 * The site's floors, lowest level first (ties keep their order). Without
 * `floors`, one implicit floor `{id: "main", level: 0}` with the layout's size.
 */
export function floorsOf(layout: SiteLayout | null | undefined): Floor[] {
  const base = floorSize(layout);
  if (!hasExplicitFloors(layout)) {
    return [{ id: MAIN_FLOOR_ID, name: "Main floor", level: 0, width: base.width, depth: base.depth }];
  }
  return layout!.floors!
    .filter((f) => f && typeof f.id === "string" && f.id !== "")
    .map((f, i) => ({
      ...f,
      name: typeof f.name === "string" && f.name.trim() ? f.name : f.id,
      level: Number.isFinite(Number(f.level)) ? Number(f.level) : i,
      width: positive(f.width, base.width || DEFAULT_WIDTH),
      depth: positive(f.depth, base.depth || DEFAULT_DEPTH),
    }))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.level - b.f.level || a.i - b.i)
    .map(({ f }) => f);
}

/** Id of the first (lowest) floor: where zones, entrances and assets with no floor go. */
export function firstFloorId(layout: SiteLayout | null | undefined): string {
  return floorsOf(layout)[0]?.id ?? MAIN_FLOOR_ID;
}

export function floorById(layout: SiteLayout | null | undefined, id: string | null | undefined): Floor | undefined {
  return floorsOf(layout).find((f) => f.id === id);
}

/** Match a floor by id, then by name (case-insensitive), as used by an asset's `floor` field. */
export function resolveFloor(layout: SiteLayout | null | undefined, value: unknown): Floor | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const floors = floorsOf(layout);
  const v = String(value);
  const lv = v.trim().toLowerCase();
  return floors.find((f) => f.id === v)
    ?? floors.find((f) => f.name.trim().toLowerCase() === lv)
    ?? floors.find((f) => f.id.toLowerCase() === lv);
}

/** Floor id of a zone or entrance: its `floor_id` if that floor exists, else the first floor. */
export function floorIdOf(layout: SiteLayout | null | undefined, item: { floor_id?: string }): string {
  const floors = floorsOf(layout);
  return floors.some((f) => f.id === item.floor_id) ? item.floor_id! : floors[0].id;
}

export function zonesOnFloor(layout: SiteLayout | null | undefined, floorId: string): Zone[] {
  return (layout?.zones ?? []).filter((z) => floorIdOf(layout, z) === floorId);
}

/**
 * Entrances on a floor. A floor with none gets a default walk-in entrance at the
 * middle of its bottom edge; the first floor also gets a default ambulance bay at
 * its bottom-left corner. Defaults have ids starting with "default-".
 */
export function entrancesOf(layout: SiteLayout | null | undefined, floorId: string): Entrance[] {
  const own = (layout?.entrances ?? []).filter((e) => Array.isArray(e.point) && floorIdOf(layout, e) === floorId);
  if (own.length) return own;
  const f = floorById(layout, floorId);
  if (!f) return [];
  const out: Entrance[] = [{ id: "default-walk", name: "Main entrance", floor_id: f.id, point: [f.width / 2, f.depth], kind: "walk" }];
  if (f.id === firstFloorId(layout)) out.push({ id: "default-ambulance", name: "Ambulance bay", floor_id: f.id, point: [0, f.depth], kind: "ambulance" });
  return out;
}

/**
 * Floor id of an asset: its `floor` field (floor id or name) if it matches a
 * floor, else the floor of its zone, else the first floor (where the
 * Unassigned strip is drawn).
 */
export function assetFloorId(layout: SiteLayout | null | undefined, asset: Asset): string {
  const explicit = resolveFloor(layout, asset.floor);
  if (explicit) return explicit.id;
  const zone = resolveZone(layout?.zones ?? [], asset.zone);
  return zone ? floorIdOf(layout, zone) : firstFloorId(layout);
}

/**
 * One floor as a single-floor layout that the 2D and 3D views draw as is.
 * For an old layout without floors this returns the same object.
 */
export function floorLayout(layout: SiteLayout, floorId: string): SiteLayout {
  if (!hasExplicitFloors(layout)) return layout;
  const f = floorById(layout, floorId) ?? floorsOf(layout)[0];
  return {
    width: f.width,
    depth: f.depth,
    zones: zonesOnFloor(layout, f.id),
    entrances: (layout.entrances ?? []).filter((e) => floorIdOf(layout, e) === f.id),
    floors: [f],
  };
}

/** Assets on a floor. With a single floor this is the same map (no copying). */
export function assetsOnFloor(layout: SiteLayout, assets: ReadonlyMap<string, Asset>, floorId: string): ReadonlyMap<string, Asset> {
  if (floorsOf(layout).length <= 1) return assets;
  const out = new Map<string, Asset>();
  for (const [id, a] of assets) if (assetFloorId(layout, a) === floorId) out.set(id, a);
  return out;
}

/** Number of assets on each floor, keyed by floor id. */
export function countByFloor(layout: SiteLayout, assets: Iterable<Asset>): Map<string, number> {
  const out = new Map(floorsOf(layout).map((f) => [f.id, 0]));
  for (const a of assets) {
    const id = assetFloorId(layout, a);
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Plan rect that fits an image of the given pixel size inside the floor, centred, aspect kept. */
export function fitPlan(floor: Pick<Floor, "width" | "depth">, widthPx: number, heightPx: number): Pick<FloorPlan, "x" | "y" | "w" | "h"> {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  if (!(widthPx > 0 && heightPx > 0)) return { x: 0, y: 0, w: floor.width, h: floor.depth };
  const s = Math.min(floor.width / widthPx, floor.depth / heightPx);
  const w = widthPx * s;
  const h = heightPx * s;
  return { x: r1((floor.width - w) / 2), y: r1((floor.depth - h) / 2), w: r1(w), h: r1(h) };
}

export function planOpacity(plan: FloorPlan): number {
  const o = Number(plan.opacity);
  return Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : DEFAULT_PLAN_OPACITY;
}

export function planUrl(siteId: string, assetId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/plans/${encodeURIComponent(assetId)}`;
}

/** Everything the 2D and 3D views need to draw a floor's plan image. */
export type PlanView = { url: string; x: number; y: number; w: number; h: number; opacity: number };

export function planView(siteId: string, floor: Floor | undefined): PlanView | null {
  const p = floor?.plan;
  if (!p || !p.asset_id || !(p.w > 0 && p.h > 0)) return null;
  return { url: planUrl(siteId, p.asset_id), x: Number(p.x) || 0, y: Number(p.y) || 0, w: p.w, h: p.h, opacity: planOpacity(p) };
}

/** Every plan asset id a layout refers to. */
export function planAssetIds(layout: SiteLayout | null | undefined): Set<string> {
  return new Set((layout?.floors ?? []).map((f) => f.plan?.asset_id).filter((x): x is string => !!x));
}

/** Points where a door can be: the nearest point on the polygon's edges to `p`, with its distance. */
export function nearestEdgePoint(poly: readonly Pt[], p: Pt): { point: Pt; dist: number; edge: number } | null {
  if (poly.length < 2) return null;
  let best: { point: Pt; dist: number; edge: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const q: Pt = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || d < best.dist) best = { point: q, dist: d, edge: i };
  }
  return best;
}
