// Pure model for the layout editor: floors, zones (with kinds and doors) and
// entrances. The editor always works on explicit floors; saving a plain single
// floor writes the 0.1 shape again so old layouts round-trip unchanged.
import type { Entrance, Floor, SiteLayout, Zone } from "../api/types";
import { validateLayout } from "./geometry";
import { MAIN_FLOOR_ID, floorIdOf, floorsOf, hasExplicitFloors, nearestEdgePoint } from "./floors";
import { polygonBounds, type Pt } from "./placement";

export type EditModel = { floors: Floor[]; zones: Zone[]; entrances: Entrance[] };

const IMPLICIT_NAME = "Main floor";
const r1 = (v: number) => Math.round(v * 10) / 10;

export function toEditModel(layout: SiteLayout | null | undefined): EditModel {
  const floors = floorsOf(layout).map((f) => structuredClone(f));
  if (!hasExplicitFloors(layout)) floors[0].name = IMPLICIT_NAME;
  const zones = (layout?.zones ?? []).map((z) => ({ ...structuredClone(z), floor_id: floorIdOf(layout, z) }));
  const entrances = (layout?.entrances ?? [])
    .filter((e) => Array.isArray(e.point))
    .map((e) => ({ ...structuredClone(e), floor_id: floorIdOf(layout, e) }));
  return { floors, zones, entrances };
}

function isPlainSingleFloor(m: EditModel): boolean {
  const f = m.floors[0];
  return m.floors.length === 1 && f.id === MAIN_FLOOR_ID && f.level === 0 && !f.plan && f.name === IMPLICIT_NAME && m.entrances.length === 0;
}

function cleanZone(z: Zone, keepFloor: boolean): Zone {
  const out: Zone = { ...z, name: z.name.trim(), polygon: z.polygon.map(([x, y]) => [r1(x), r1(y)] as Pt) };
  if (z.doors?.length) out.doors = z.doors.map(([x, y]) => [r1(x), r1(y)] as Pt); else delete out.doors;
  if (!keepFloor) delete out.floor_id;
  return out;
}

/** Layout to save. Keys the editor doesn't manage (from `base`) are kept. */
export function fromEditModel(base: SiteLayout | null | undefined, m: EditModel): SiteLayout {
  const rest: SiteLayout = { ...(base ?? {}) };
  delete rest.floors;
  delete rest.entrances;
  if (isPlainSingleFloor(m)) {
    const f = m.floors[0];
    return { ...rest, width: f.width, depth: f.depth, zones: m.zones.map((z) => cleanZone(z, false)) };
  }
  const floors = m.floors.map((f) => ({ ...f, name: f.name.trim() }));
  return {
    ...rest,
    // Older readers still see the first floor's size.
    width: floors[0].width,
    depth: floors[0].depth,
    floors,
    zones: m.zones.map((z) => cleanZone(z, true)),
    entrances: m.entrances.map((e) => ({ ...e, name: e.name.trim(), point: [r1(e.point[0]), r1(e.point[1])] as Pt })),
  };
}

export function uniqueFloorId(floors: readonly Floor[]): string {
  const ids = new Set(floors.map((f) => f.id));
  for (let i = floors.length + 1; ; i++) if (!ids.has(`floor-${i}`)) return `floor-${i}`;
}

function nextFloorName(floors: readonly Floor[]): string {
  const names = new Set(floors.map((f) => f.name.trim().toLowerCase()));
  for (let i = floors.length + 1; ; i++) if (!names.has(`floor ${i}`)) return `Floor ${i}`;
}

/** Add a floor above the top one, the same size as it. */
export function addFloor(m: EditModel): { model: EditModel; id: string } {
  const top = m.floors[m.floors.length - 1];
  const id = uniqueFloorId(m.floors);
  const floor: Floor = { id, name: nextFloorName(m.floors), level: top ? top.level + 1 : 0, width: top?.width ?? 100, depth: top?.depth ?? 60 };
  return { model: { ...m, floors: [...m.floors, floor] }, id };
}

/** Swap a floor with the one below (-1) or above (+1). Levels are swapped too. */
export function moveFloor(m: EditModel, id: string, dir: -1 | 1): EditModel {
  const i = m.floors.findIndex((f) => f.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= m.floors.length) return m;
  const floors = [...m.floors];
  const a = floors[i];
  const b = floors[j];
  floors[i] = { ...b, level: a.level };
  floors[j] = { ...a, level: b.level };
  return { ...m, floors };
}

/** Remove a floor with its zones and entrances. The last floor can't be removed. */
export function deleteFloor(m: EditModel, id: string): EditModel {
  if (m.floors.length <= 1) return m;
  return {
    floors: m.floors.filter((f) => f.id !== id),
    zones: m.zones.filter((z) => z.floor_id !== id),
    entrances: m.entrances.filter((e) => e.floor_id !== id),
  };
}

export function patchFloor(m: EditModel, id: string, p: Partial<Floor>): EditModel {
  return { ...m, floors: m.floors.map((f) => (f.id === id ? { ...f, ...p } : f)) };
}

/**
 * Keep doors on a zone's edge after the zone moved or was resized: map them
 * through the change of bounds, then snap each one onto the nearest edge.
 */
export function moveDoors(oldPoly: readonly Pt[], newPoly: readonly Pt[], doors: readonly Pt[] | undefined): Pt[] | undefined {
  if (!doors?.length) return doors ? [] : undefined;
  const a = polygonBounds(oldPoly);
  const b = polygonBounds(newPoly);
  const sx = a.w > 0 ? b.w / a.w : 1;
  const sy = a.h > 0 ? b.h / a.h : 1;
  return doors.map(([x, y]) => {
    const p: Pt = [b.x + (x - a.x) * sx, b.y + (y - a.y) * sy];
    return nearestEdgePoint(newPoly, p)?.point ?? p;
  });
}

/** New polygon for a zone, with its doors carried along. */
export function reshapeZone(z: Zone, polygon: Pt[]): Partial<Zone> {
  return z.doors?.length ? { polygon, doors: moveDoors(z.polygon, polygon, z.doors) } : { polygon };
}

/**
 * Click at `p` while placing doors: removes a door within `tol`, otherwise adds
 * one at the nearest edge point if the click is within `tol` of an edge.
 */
export function toggleDoor(z: Zone, p: Pt, tol: number): { doors: Pt[]; change: "added" | "removed" | null } {
  const doors = z.doors ?? [];
  const hit = doors.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) <= tol);
  if (hit >= 0) return { doors: doors.filter((_, i) => i !== hit), change: "removed" };
  const near = nearestEdgePoint(z.polygon, p);
  if (!near || near.dist > tol) return { doors, change: null };
  return { doors: [...doors, [r1(near.point[0]), r1(near.point[1])]], change: "added" };
}

/** Plain names for a zone's edges: "top", "right"… for axis-aligned edges, else "edge N". */
export function edgeNames(poly: readonly Pt[]): string[] {
  const b = polygonBounds(poly);
  return poly.map((a, i) => {
    const c = poly[(i + 1) % poly.length];
    const eps = 1e-6;
    if (Math.abs(a[1] - c[1]) < eps && Math.abs(a[1] - b.y) < eps) return "top";
    if (Math.abs(a[1] - c[1]) < eps && Math.abs(a[1] - (b.y + b.h)) < eps) return "bottom";
    if (Math.abs(a[0] - c[0]) < eps && Math.abs(a[0] - b.x) < eps) return "left";
    if (Math.abs(a[0] - c[0]) < eps && Math.abs(a[0] - (b.x + b.w)) < eps) return "right";
    return `edge ${i + 1}`;
  });
}

/** Midpoint of edge `i`, where "Add door" puts a door without a pointer. */
export function edgeMidpoint(poly: readonly Pt[], i: number): Pt {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  return [r1((a[0] + b[0]) / 2), r1((a[1] + b[1]) / 2)];
}

export function uniqueEntranceId(entrances: readonly Entrance[]): string {
  const ids = new Set(entrances.map((e) => e.id));
  for (let i = entrances.length + 1; ; i++) if (!ids.has(`entrance-${i}`)) return `entrance-${i}`;
}

/** Problems that block saving, in plain language, naming the floor when there are several. */
export function validateModel(m: EditModel): string[] {
  const out: string[] = [];
  const many = m.floors.length > 1;
  const names = new Map<string, number>();
  for (const f of m.floors) {
    const name = f.name.trim();
    if (!name) out.push("A floor has no name. Give every floor a name, such as Ground floor or Level 2.");
    else names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1);
    const where = many ? `On ${name || "the unnamed floor"}: ` : "";
    const zones = m.zones.filter((z) => z.floor_id === f.id);
    for (const p of validateLayout(zones, f.width, f.depth)) out.push(where + p);
    if (f.plan && !(f.plan.w > 0 && f.plan.h > 0)) out.push(`${where}The floor plan image needs a width and depth above 0. Use Fit to floor.`);
    for (const e of m.entrances.filter((x) => x.floor_id === f.id)) {
      const [x, y] = e.point;
      if (!e.name.trim()) out.push(`${where}An entrance has no name. Name it, for example Main entrance.`);
      if (!(x >= 0 && y >= 0 && x <= f.width && y <= f.depth)) {
        out.push(`${where}Entrance "${e.name.trim() || e.id}" is outside the ${f.width} × ${f.depth} floor. Move it onto the floor.`);
      }
    }
  }
  for (const [name, n] of names) if (n > 1) out.push(`${n} floors are named "${name}". Floor names must be different so assets can name their floor.`);
  return out;
}

export const ENTRANCE_LABELS: Record<Entrance["kind"], string> = { walk: "Walk-in entrance", ambulance: "Ambulance bay" };

/**
 * Add an entrance on a floor. It starts where the default would be (walk-in:
 * middle of the bottom edge; ambulance: bottom-left corner), nudged if taken.
 */
export function addEntrance(m: EditModel, floorId: string, kind: Entrance["kind"]): { model: EditModel; id: string } {
  const f = m.floors.find((x) => x.id === floorId) ?? m.floors[0];
  const id = uniqueEntranceId(m.entrances);
  const taken = (p: Pt) => m.entrances.some((e) => e.floor_id === f.id && e.point[0] === p[0] && e.point[1] === p[1]);
  const p: Pt = kind === "walk" ? [r1(f.width / 2), f.depth] : [0, f.depth];
  while (taken(p) && p[0] + 2 <= f.width) p[0] = r1(p[0] + 2);
  const same = m.entrances.filter((e) => e.kind === kind).length;
  const name = same ? `${ENTRANCE_LABELS[kind]} ${same + 1}` : ENTRANCE_LABELS[kind];
  return { model: { ...m, entrances: [...m.entrances, { id, name, floor_id: f.id, point: p, kind }] }, id };
}

/**
 * Click at `p` while placing doors on a floor: removes the door nearest the
 * click if one is within `tol`, else adds a door on the zone edge nearest the
 * click (within `tol`). Returns null when the click is near no zone edge.
 */
export function doorClick(zones: readonly Zone[], p: Pt, tol: number): { zoneId: string; doors: Pt[]; change: "added" | "removed" } | null {
  let removeAt: { z: Zone; d: number } | null = null;
  for (const z of zones) {
    for (const [x, y] of z.doors ?? []) {
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d <= tol && (!removeAt || d < removeAt.d)) removeAt = { z, d };
    }
  }
  if (removeAt) {
    const r = toggleDoor(removeAt.z, p, tol);
    return { zoneId: removeAt.z.id, doors: r.doors, change: "removed" };
  }
  let best: { z: Zone; d: number } | null = null;
  for (const z of zones) {
    const near = nearestEdgePoint(z.polygon, p);
    if (near && near.dist <= tol && (!best || near.dist < best.d)) best = { z, d: near.dist };
  }
  if (!best) return null;
  const r = toggleDoor(best.z, p, tol);
  return { zoneId: best.z.id, doors: r.doors, change: "added" };
}
