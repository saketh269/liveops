// One wall plan per floor, shared by the 3D world builder and navigation (LIVEOPS-107).
//
// The builder draws exactly `inner` and `outer`; navigation walks on `grid`, the
// cells at least WALL_CLEARANCE away from every one of those segments and from
// the nurse-station desks. So people walk around what is drawn, and through the
// door gaps that are drawn. Pure geometry in layout metres, no three.js.
import type { Entrance, Zone } from "../../api/types";
import type { Pt } from "../placement";
import { WORLD } from "./style";
import { doorGaps, isNurseStation, isWalled, planWalls, type Seg } from "./walls";

/** Half the width of a walking figure (m). */
export const WALKER_RADIUS = 0.3;
/** How far a walker's centre stays from a wall's centre line: half the wall plus the walker. */
export const WALL_CLEARANCE = WORLD.wallThickness / 2 + WALKER_RADIUS;
/** Grid cell size (m); larger only on floors so big the grid would pass PLAN_MAX_CELLS per side. */
export const PLAN_CELL = 0.25;
export const PLAN_MAX_CELLS = 400;
/** Cells this much beyond the clearance count as "near a wall" (walkers prefer the middle of a corridor). */
const NEAR_WALL = 0.45;
/** Desk tops overhang the desk body by this much on every side (build.ts nurseDesk). */
const DESK_OVERHANG = 0.2;
const BUCKET = 2;
const PLAN_CACHE = 24;

export type PlanInput = { width: number; depth: number; zones: readonly Zone[]; entrances: readonly Entrance[] };

/** Axis-aligned rectangle (layout metres). */
export type Box = { x: number; y: number; w: number; h: number };

/** Nurse-station desk body: centre, length along the station, depth across it. */
export type Desk = { cx: number; cy: number; length: number; depth: number; along: boolean };

/** Walkable cells of a floor. */
export type WalkGrid = {
  cell: number;
  cols: number;
  rows: number;
  /** 1 where a walker's centre may be. */
  free: Uint8Array;
  /** 1 inside a corridor zone. */
  corridor: Uint8Array;
  /** Index into `rooms` of the walled zone holding the cell, -1 outside. */
  room: Int16Array;
  /** 1 for free cells close to a wall or desk. */
  nearWall: Uint8Array;
  /** Connected area id per free cell (4-neighbour), -1 for blocked cells. */
  comp: Int32Array;
  /** Id of the largest connected area. */
  mainComp: number;
  hasCorridors: boolean;
};

export type FloorWallPlan = {
  width: number;
  depth: number;
  /** Room and waiting-area walls, as drawn (door gaps already cut out). */
  inner: Seg[];
  /** Building walls, as drawn (entrance openings already cut out). */
  outer: Seg[];
  /** inner + outer. */
  walls: Seg[];
  /** Door gaps of walled zones (the openings in `inner`). */
  doors: Seg[];
  /** Walled zones (rooms, waiting areas): `grid.room` indexes this list. */
  rooms: Zone[];
  /** Nurse-station desks: obstacles. */
  desks: Box[];
  grid: WalkGrid;
  /** Wall indices per BUCKET-sized square, for quick segment queries. */
  buckets: Map<number, number[]>;
};

const validZone = (z: Zone) => Array.isArray(z.polygon) && z.polygon.length >= 3
  && z.polygon.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

/** The nurse-station desk drawn in a station zone (the builder draws it from this). */
export function nurseDesk(z: Zone): Desk {
  const b = bounds(z.polygon);
  const along = b.w >= b.h;
  const length = Math.max(1.6, (along ? b.w : b.h) * 0.85);
  const depth = Math.max(0.8, Math.min((along ? b.h : b.w) * 0.55, 1.6));
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, length, depth, along };
}

/** Footprint of a desk including its top. */
export function deskBox(d: Desk): Box {
  const w = (d.along ? d.length : d.depth) + 2 * DESK_OVERHANG;
  const h = (d.along ? d.depth : d.length) + 2 * DESK_OVERHANG;
  return { x: d.cx - w / 2, y: d.cy - h / 2, w, h };
}

const cache = new Map<string, FloorWallPlan>();

/** The wall plan of a floor; computed once per distinct floor and reused. */
export function wallPlanFor(input: PlanInput): FloorWallPlan {
  const zones = input.zones.filter(validZone);
  const entrances = input.entrances.filter((e) => Array.isArray(e.point) && Number.isFinite(e.point[0]) && Number.isFinite(e.point[1]));
  const key = JSON.stringify([input.width, input.depth, zones.map((z) => [z.id, z.name, z.kind, z.polygon, z.doors]), entrances.map((e) => [e.point, e.kind])]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const plan = computePlan(input.width, input.depth, zones, entrances);
  if (cache.size >= PLAN_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, plan);
  return plan;
}

function computePlan(width: number, depth: number, zones: Zone[], entrances: Entrance[]): FloorWallPlan {
  const { inner, outer } = planWalls({ width, depth, zones, entrances, doorWidth: WORLD.doorWidth });
  const walls = [...inner, ...outer];
  const corridors = zones.filter((z) => z.kind === "corridor");
  const rooms = zones.filter(isWalled);
  const doors = rooms.flatMap((z) => doorGaps(z, corridors, [width / 2, depth / 2], WORLD.doorWidth));
  const desks = zones.filter(isNurseStation).map((z) => deskBox(nurseDesk(z)));

  const cell = Math.max(PLAN_CELL, Math.max(width, depth) / PLAN_MAX_CELLS);
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(depth / cell));
  const n = cols * rows;
  const free = new Uint8Array(n).fill(1);
  const nearWall = new Uint8Array(n);
  const corridor = new Uint8Array(n);
  const room = new Int16Array(n).fill(-1);
  const cx = (c: number) => (c + 0.5) * cell;

  const near = WALL_CLEARANCE + NEAR_WALL;
  for (const s of walls) {
    const x0 = Math.min(s.a[0], s.b[0]) - near, x1 = Math.max(s.a[0], s.b[0]) + near;
    const y0 = Math.min(s.a[1], s.b[1]) - near, y1 = Math.max(s.a[1], s.b[1]) + near;
    forCells(x0, y0, x1, y1, cell, cols, rows, (c, r, i) => {
      const d = distToSeg([cx(c), cx(r)], s.a, s.b);
      if (d < WALL_CLEARANCE) free[i] = 0;
      else if (d < near) nearWall[i] = 1;
    });
  }
  for (const b of desks) {
    forCells(b.x - near, b.y - near, b.x + b.w + near, b.y + b.h + near, cell, cols, rows, (c, r, i) => {
      const d = distToBox([cx(c), cx(r)], b);
      if (d < WALKER_RADIUS) free[i] = 0;
      else if (d < WALKER_RADIUS + NEAR_WALL) nearWall[i] = 1;
    });
  }
  for (const z of corridors) raster(z.polygon, cell, cols, rows, (i) => { corridor[i] = 1; });
  // Smaller zones win where walled zones overlap.
  const order = rooms.map((z, i) => ({ z, i })).sort((a, b) => area(b.z.polygon) - area(a.z.polygon));
  for (const { z, i } of order) raster(z.polygon, cell, cols, rows, (k) => { room[k] = i; });

  // Connected areas (4-neighbour: diagonal steps need both side cells free, so this matches the search).
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let next = 0, mainComp = -1, best = 0;
  for (let s = 0; s < n; s++) {
    if (!free[s] || comp[s] !== -1) continue;
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = next;
    while (head < tail) {
      const i = queue[head++];
      const c = i % cols, r = (i - c) / cols;
      if (c > 0 && free[i - 1] && comp[i - 1] === -1) { comp[i - 1] = next; queue[tail++] = i - 1; }
      if (c < cols - 1 && free[i + 1] && comp[i + 1] === -1) { comp[i + 1] = next; queue[tail++] = i + 1; }
      if (r > 0 && free[i - cols] && comp[i - cols] === -1) { comp[i - cols] = next; queue[tail++] = i - cols; }
      if (r < rows - 1 && free[i + cols] && comp[i + cols] === -1) { comp[i + cols] = next; queue[tail++] = i + cols; }
    }
    if (tail > best) { best = tail; mainComp = next; }
    next++;
  }

  const buckets = new Map<number, number[]>();
  walls.forEach((s, k) => {
    const bx0 = Math.floor(Math.min(s.a[0], s.b[0]) / BUCKET), bx1 = Math.floor(Math.max(s.a[0], s.b[0]) / BUCKET);
    const by0 = Math.floor(Math.min(s.a[1], s.b[1]) / BUCKET), by1 = Math.floor(Math.max(s.a[1], s.b[1]) / BUCKET);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const id = bucketId(bx, by);
        const l = buckets.get(id);
        if (l) l.push(k); else buckets.set(id, [k]);
      }
    }
  });

  return {
    width, depth, inner, outer, walls, doors, rooms, desks, buckets,
    grid: { cell, cols, rows, free, corridor, room, nearWall, comp, mainComp, hasCorridors: corridors.length > 0 },
  };
}

const bucketId = (bx: number, by: number) => (by + 4096) * 8192 + (bx + 4096);

/** Walls whose bucket overlaps the box (each once). */
function wallsNear(plan: FloorWallPlan, x0: number, y0: number, x1: number, y1: number): Seg[] {
  const out = new Set<number>();
  const bx0 = Math.floor(x0 / BUCKET), bx1 = Math.floor(x1 / BUCKET), by0 = Math.floor(y0 / BUCKET), by1 = Math.floor(y1 / BUCKET);
  if ((bx1 - bx0 + 1) * (by1 - by0 + 1) > plan.buckets.size) return plan.walls;
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) for (const k of plan.buckets.get(bucketId(bx, by)) ?? []) out.add(k);
  return [...out].map((k) => plan.walls[k]);
}

/** Distance from a point to the nearest wall centre line (Infinity without walls). */
export function distToWalls(plan: FloorWallPlan, p: Pt, within = 3): number {
  let best = Infinity;
  for (const s of wallsNear(plan, p[0] - within, p[1] - within, p[0] + within, p[1] + within)) best = Math.min(best, distToSeg(p, s.a, s.b));
  return best;
}

/** True when the straight run a–b keeps at least `margin` from every wall centre line (and crosses none). */
export function segmentClear(plan: FloorWallPlan, a: Pt, b: Pt, margin: number): boolean {
  const near = wallsNear(plan, Math.min(a[0], b[0]) - margin, Math.min(a[1], b[1]) - margin, Math.max(a[0], b[0]) + margin, Math.max(a[1], b[1]) + margin);
  for (const s of near) {
    if (segmentsIntersect(a, b, s.a, s.b)) return false;
    if (margin > 0 && segSegDist(a, b, s.a, s.b) < margin) return false;
  }
  return true;
}

/** True when the straight run a–b clears every desk by `margin`. */
export function clearOfDesks(plan: FloorWallPlan, a: Pt, b: Pt, margin: number): boolean {
  for (const d of plan.desks) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      if (distToBox([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d) < margin) return false;
    }
  }
  return true;
}

// ---- geometry ----

function bounds(poly: readonly Pt[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function area(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

function inPoly(x: number, y: number, poly: readonly Pt[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

function forCells(x0: number, y0: number, x1: number, y1: number, cell: number, cols: number, rows: number, fn: (c: number, r: number, i: number) => void) {
  const c0 = Math.max(0, Math.floor(x0 / cell)), c1 = Math.min(cols - 1, Math.floor(x1 / cell));
  const r0 = Math.max(0, Math.floor(y0 / cell)), r1 = Math.min(rows - 1, Math.floor(y1 / cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(c, r, r * cols + c);
}

function raster(poly: readonly Pt[], cell: number, cols: number, rows: number, fn: (i: number) => void) {
  const b = bounds(poly);
  forCells(b.x, b.y, b.x + b.w, b.y + b.h, cell, cols, rows, (c, r, i) => {
    if (inPoly((c + 0.5) * cell, (r + 0.5) * cell, poly)) fn(i);
  });
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

function distToBox(p: Pt, b: Box): number {
  const dx = Math.max(b.x - p[0], 0, p[0] - (b.x + b.w));
  const dy = Math.max(b.y - p[1], 0, p[1] - (b.y + b.h));
  return Math.hypot(dx, dy);
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Segments p1–p2 and q1–q2 share a point (touching counts). */
export function segmentsIntersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const eps = 1e-12;
  return (Math.abs(d1) < eps && distToSeg(p1, q1, q2) < 1e-9) || (Math.abs(d2) < eps && distToSeg(p2, q1, q2) < 1e-9)
    || (Math.abs(d3) < eps && distToSeg(q1, p1, p2) < 1e-9) || (Math.abs(d4) < eps && distToSeg(q2, p1, p2) < 1e-9);
}

/** Shortest distance between two segments. */
export function segSegDist(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(distToSeg(p1, q1, q2), distToSeg(p2, q1, q2), distToSeg(q1, p1, p2), distToSeg(q2, p1, p2));
}
