// Routes drawn on the map: where a record went (from its history) on the floor shown,
// with markers where it changed floors. Walking paths come from walkPath() only.
import type { HistoryEntry, SiteLayout, Zone } from "../../api/types";
import { floorLayout, floorsOf, zonesOnFloor } from "../floors";
import { navGridFor } from "../navigation";
import { polygonCentroid, type Pt } from "../placement";

export type RouteStop = { at: Pt; ts: number; label: string; zoneId: string };
export type RouteLeg = { points: Pt[]; ts: number; /** 0..1, newer legs are stronger. */ fade: number };
export type FloorMark = { at: Pt; ts: number; text: string; dir: "up" | "down" | "" };
export type Route = { floorId: string; legs: RouteLeg[]; stops: RouteStop[]; marks: FloorMark[] };

const views = new WeakMap<SiteLayout, Map<string, SiteLayout>>();

/** One floor's layout, kept per layout object so its navigation grid is built once. */
function floorView(layout: SiteLayout, floorId: string): SiteLayout {
  let m = views.get(layout);
  if (!m) { m = new Map(); views.set(layout, m); }
  let v = m.get(floorId);
  if (!v) { v = floorLayout(layout, floorId); m.set(floorId, v); }
  return v;
}

/**
 * How a person walks between two points of one floor: along corridors and through
 * doors (map/navigation.ts). The only place the route code uses navigation; if the
 * search fails it falls back to a straight line.
 */
export function walkPath(layout: SiteLayout, floorId: string, from: Pt, to: Pt): Pt[] {
  try {
    const r = navGridFor(floorView(layout, floorId)).route(from, to);
    return r.points.length >= 2 ? r.points : [from, to];
  } catch {
    return [from, to];
  }
}

function zoneById(layout: SiteLayout, floorId: string): Map<string, Zone> {
  return new Map(zonesOnFloor(layout, floorId).map((z) => [z.id, z]));
}

/** The point a visit to a zone is drawn at (its centre). */
export function zoneCenter(z: Zone): Pt | null {
  return Array.isArray(z.polygon) && z.polygon.length >= 3 ? polygonCentroid(z.polygon) : null;
}

/** Route on `floorId` through the places in the history (oldest first). */
export function buildRoute(layout: SiteLayout, floorId: string, entries: readonly HistoryEntry[], since?: number): Route {
  const here = zoneById(layout, floorId);
  const level = new Map(floorsOf(layout).map((f) => [f.id, f.level]));
  const legs: RouteLeg[] = [];
  const stops: RouteStop[] = [];
  const marks: FloorMark[] = [];
  type Visit = { ts: number; floorId: string | null; floor: string | null; at: Pt | null; zoneId: string | null; label: string };
  let prev: Visit | null = null;
  for (const e of entries) {
    if (since !== undefined && e.ts < since && e.kind !== "arrived" && e.kind !== "move") continue;
    if (e.kind === "left") { prev = null; continue; }
    if (e.kind !== "arrived" && e.kind !== "move") continue;
    const zid = e.zone_id ?? (e.bed && here.has(e.bed) ? e.bed : null);
    const z = zid ? here.get(zid) : undefined;
    const onHere = e.floor_id === floorId || (!!z && (e.floor_id === null || e.floor_id === undefined));
    const cur: Visit = { ts: e.ts, floorId: e.floor_id, floor: e.floor, at: onHere && z ? zoneCenter(z) : null, zoneId: z ? z.id : null, label: e.zone ?? e.bed ?? "" };
    if (since !== undefined && e.ts < since) { prev = cur; continue; } // context only
    if (cur.at && cur.zoneId) stops.push({ at: cur.at, ts: cur.ts, label: cur.label, zoneId: cur.zoneId });
    if (prev) {
      if (prev.at && cur.at) {
        if (prev.zoneId !== cur.zoneId) legs.push({ points: walkPath(layout, floorId, prev.at, cur.at), ts: cur.ts, fade: 1 });
      } else if (prev.at && !cur.at && cur.floorId && cur.floorId !== floorId) {
        marks.push({ at: prev.at, ts: cur.ts, text: `To ${cur.floor ?? cur.floorId}`, dir: dirOf(level.get(floorId), level.get(cur.floorId)) });
      } else if (!prev.at && cur.at && prev.floorId && prev.floorId !== floorId) {
        marks.push({ at: cur.at, ts: cur.ts, text: `From ${prev.floor ?? prev.floorId}`, dir: dirOf(level.get(prev.floorId), level.get(floorId)) });
      }
    }
    prev = cur;
  }
  legs.forEach((l, i) => { l.fade = (i + 1) / legs.length; });
  return { floorId, legs, stops, marks };
}

function dirOf(from: number | undefined, to: number | undefined): FloorMark["dir"] {
  if (from === undefined || to === undefined || from === to) return "";
  return to > from ? "up" : "down";
}
