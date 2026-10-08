// Cut-away walls built from zone polygons (pure geometry, layout metres).
// - Room and walled waiting zones get a wall on every edge, with a door gap at each
//   of the zone's `doors`; without doors, one gap on the edge nearest a corridor.
// - Edges shared by two zones become one wall; a door on either side opens it.
// - Outer walls run around the floor's bounds with openings at the entrances.
import type { Entrance, Zone } from "../../api/types";
import type { Pt } from "../placement";

export type Seg = { a: Pt; b: Pt };
export type WallPlan = { inner: Seg[]; outer: Seg[] };

type Line = { key: string; d: Pt; n: Pt; c: number };
type Span = [number, number];

const EPS = 1e-6;
/** Shortest wall piece worth drawing (m). */
const MIN_PIECE = 0.08;

/** Zones that get walls: rooms, and waiting areas other than nurse stations. */
export function isWalled(z: Zone): boolean {
  if (z.kind === "room") return true;
  return z.kind === "waiting" && !isNurseStation(z);
}

/** A nurse station: a waiting zone whose name (or id) ends with "-NS". */
export function isNurseStation(z: Zone): boolean {
  if (z.kind !== "waiting") return false;
  return /-ns$/i.test((z.name || z.id || "").trim()) || /-ns$/i.test(z.id ?? "");
}

function lineOf(a: Pt, b: Pt): { line: Line; ta: number; tb: number } | null {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  dx /= len; dy /= len;
  // One direction per line: angle in [0, π).
  if (dy < -EPS || (Math.abs(dy) <= EPS && dx < 0)) { dx = -dx; dy = -dy; }
  const n: Pt = [-dy, dx];
  const c = n[0] * a[0] + n[1] * a[1];
  const ang = Math.round(Math.atan2(dy, dx) * 1000);
  const key = `${ang}:${Math.round(c * 50)}`;
  return { line: { key, d: [dx, dy], n, c }, ta: dx * a[0] + dy * a[1], tb: dx * b[0] + dy * b[1] };
}

function union(spans: Span[]): Span[] {
  const s = spans.filter(([a, b]) => b - a > EPS).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-3) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtract(solid: Span[], holes: Span[]): Span[] {
  let out = union(solid);
  for (const [h0, h1] of union(holes)) {
    const next: Span[] = [];
    for (const [a, b] of out) {
      if (h1 <= a || h0 >= b) { next.push([a, b]); continue; }
      if (h0 > a) next.push([a, h0]);
      if (h1 < b) next.push([h1, b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a >= MIN_PIECE);
}

/** Collects wall edges and door gaps per straight line, then resolves them. */
class LineSet {
  private lines = new Map<string, { line: Line; solid: Span[]; gaps: Span[] }>();

  private entry(a: Pt, b: Pt) {
    const l = lineOf(a, b);
    if (!l) return null;
    let e = this.lines.get(l.line.key);
    if (!e) { e = { line: l.line, solid: [], gaps: [] }; this.lines.set(l.line.key, e); }
    return { e, span: [Math.min(l.ta, l.tb), Math.max(l.ta, l.tb)] as Span };
  }

  wall(a: Pt, b: Pt) { const r = this.entry(a, b); if (r) r.e.solid.push(r.span); }
  gap(a: Pt, b: Pt) { const r = this.entry(a, b); if (r) r.e.gaps.push(r.span); }

  /** Spans covered by walls on a line key (for removing overlaps between sets). */
  covered(key: string): Span[] { return union(this.lines.get(key)?.solid ?? []); }

  segments(minus?: LineSet): Seg[] {
    const out: Seg[] = [];
    for (const [key, { line, solid, gaps }] of this.lines) {
      const holes = minus ? [...gaps, ...minus.covered(key)] : gaps;
      for (const [t0, t1] of subtract(solid, holes)) out.push({ a: pointOn(line, t0), b: pointOn(line, t1) });
    }
    return out;
  }
}

function pointOn(l: Line, t: number): Pt {
  return [round(l.n[0] * l.c + l.d[0] * t), round(l.n[1] * l.c + l.d[1] * t)];
}

const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

function edges(poly: readonly Pt[]): [Pt, Pt][] {
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Pt, Pt]);
}

/** Nearest point on segment a–b to p, with its distance and position along the segment (0..len). */
function project(a: Pt, b: Pt, p: Pt): { q: Pt; dist: number; t: number; len: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const t = len > EPS ? Math.min(len, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  const q: Pt = len > EPS ? [a[0] + (dx / len) * t, a[1] + (dy / len) * t] : a;
  return { q, dist: Math.hypot(p[0] - q[0], p[1] - q[1]), t, len };
}

function distToPolygon(p: Pt, poly: readonly Pt[]): number {
  if (inside(p, poly)) return 0;
  let best = Infinity;
  for (const [a, b] of edges(poly)) best = Math.min(best, project(a, b, p).dist);
  return best;
}

function inside([x, y]: Pt, poly: readonly Pt[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

/** Gap of `width` centred at distance t along edge a–b (clamped to the edge, at most 70 % of it). */
function gapOn(a: Pt, b: Pt, t: number, len: number, width: number): Seg {
  const w = Math.min(width, len * 0.7);
  const t0 = Math.min(Math.max(0, t - w / 2), len - w);
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  return { a: [a[0] + ux * t0, a[1] + uy * t0], b: [a[0] + ux * (t0 + w), a[1] + uy * (t0 + w)] };
}

/**
 * Door gaps of one zone: one per door point (on the nearest edge), or, with no
 * doors, one in the middle of the edge nearest a corridor (or the floor centre).
 */
export function doorGaps(zone: Zone, corridors: readonly Zone[], centre: Pt, doorWidth: number): Seg[] {
  const poly = zone.polygon;
  if (!Array.isArray(poly) || poly.length < 3) return [];
  const es = edges(poly);
  const doors = (zone.doors ?? []).filter((d) => Array.isArray(d) && Number.isFinite(d[0]) && Number.isFinite(d[1]));
  if (doors.length) {
    return doors.map((d) => {
      let best = { a: es[0][0], b: es[0][1], pr: project(es[0][0], es[0][1], d) };
      for (const [a, b] of es.slice(1)) {
        const pr = project(a, b, d);
        if (pr.dist < best.pr.dist) best = { a, b, pr };
      }
      return gapOn(best.a, best.b, best.pr.t, best.pr.len, doorWidth);
    });
  }
  const targets = corridors.filter((c) => Array.isArray(c.polygon) && c.polygon.length >= 3);
  let pick: { a: Pt; b: Pt; score: number } | null = null;
  for (const [a, b] of es) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < doorWidth * 0.5) continue;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const score = targets.length
      ? Math.min(...targets.map((c) => distToPolygon(mid, c.polygon)))
      : Math.hypot(mid[0] - centre[0], mid[1] - centre[1]);
    if (!pick || score < pick.score - 1e-6) pick = { a, b, score };
  }
  if (!pick) return [];
  const len = Math.hypot(pick.b[0] - pick.a[0], pick.b[1] - pick.a[1]);
  return [gapOn(pick.a, pick.b, len / 2, len, doorWidth)];
}

/** Openings in the outer walls: one per entrance, on the nearest bounds edge. */
function entranceGaps(width: number, depth: number, entrances: readonly Entrance[]): Seg[] {
  const box: Pt[] = [[0, 0], [width, 0], [width, depth], [0, depth]];
  const es = edges(box);
  return entrances
    .filter((e) => Array.isArray(e.point) && Number.isFinite(e.point[0]) && Number.isFinite(e.point[1]))
    .map((e) => {
      const w = e.kind === "ambulance" ? 4.5 : 3;
      let best = { a: es[0][0], b: es[0][1], pr: project(es[0][0], es[0][1], e.point) };
      for (const [a, b] of es.slice(1)) {
        const pr = project(a, b, e.point);
        if (pr.dist < best.pr.dist) best = { a, b, pr };
      }
      return gapOn(best.a, best.b, best.pr.t, best.pr.len, w);
    });
}

/** All walls of one floor. */
export function planWalls(opts: { width: number; depth: number; zones: readonly Zone[]; entrances: readonly Entrance[]; doorWidth: number }): WallPlan {
  const { width, depth, zones, entrances, doorWidth } = opts;
  const valid = zones.filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3);
  const corridors = valid.filter((z) => z.kind === "corridor");
  const centre: Pt = [width / 2, depth / 2];

  const outer = new LineSet();
  const box: Pt[] = [[0, 0], [width, 0], [width, depth], [0, depth]];
  for (const [a, b] of edges(box)) outer.wall(a, b);
  for (const g of entranceGaps(width, depth, entrances)) outer.gap(g.a, g.b);

  const inner = new LineSet();
  for (const z of valid.filter(isWalled)) {
    for (const [a, b] of edges(z.polygon)) inner.wall(a, b);
    for (const g of doorGaps(z, corridors, centre, doorWidth)) inner.gap(g.a, g.b);
  }
  return { inner: inner.segments(outer), outer: outer.segments() };
}
