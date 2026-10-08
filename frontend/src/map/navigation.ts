// Walkable-space navigation for moving figures (ADR 0006, LIVEOPS-98).
//
// One grid per floor layout: corridor zones are walkable; a floor without
// corridors is walkable everywhere outside zones. A zone's interior can only be
// used by a path that starts or ends in it, and is entered or left through its
// doors (or anywhere on its edge when it has none, which picks the edge point
// nearest the path). A* over the grid, then string-pulled to straight runs.
// Every search is capped; when it fails the caller gets a straight line.
import { entrancesOf, floorsOf, zonesOnFloor } from "./floors";
import type { Entrance, SiteLayout, Zone } from "../api/types";
import { pointInPolygon, polygonBounds, type Pt } from "./placement";

/** Grid cells across the longest floor side (upper bound); keeps searches small. */
export const NAV_MAX_CELLS = 200;
export const NAV_MIN_CELL = 0.25;
/** Hard time cap for one search (a cold JIT can take a few ms). Typical searches on a 120 × 72 floor take 0.2–0.4 ms. */
export const NAV_MAX_MS = 15;
export const NAV_PATH_CACHE = 4096;

export type NavFloor = {
  width: number;
  depth: number;
  zones: Zone[];
  /** Entrances with the ADR 0006 defaults applied when the layout has none. */
  entrances: Entrance[];
};

/**
 * The single floor a view draws, read from the layout per ADR 0006.
 *
 * Kept in one function so it can be swapped for `floors.ts` (agent-floorplan)
 * when that lands: there, views receive `floorLayout(layout, floorId)` and this
 * reads its first (only) floor. With several floors and no filtering, the first
 * floor is used, like the ADR's "no floor_id = first floor" rule.
 */
export function navFloorOf(layout: SiteLayout | null | undefined): NavFloor {
  // The views pass one floor at a time (floorLayout); its first floor is the one we walk on.
  const floor = floorsOf(layout)[0];
  const zones = zonesOnFloor(layout, floor.id).filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3);
  const entrances = entrancesOf(layout, floor.id);
  return { width: floor.width, depth: floor.depth, zones, entrances };
}

/** Nearest entrance of a kind to a point (falls back to any entrance). */
export function nearestEntrance(floor: NavFloor, p: Pt, kind: Entrance["kind"]): Entrance {
  const pool = floor.entrances.filter((e) => e.kind === kind);
  const list = pool.length ? pool : floor.entrances;
  let best = list[0];
  let bd = Infinity;
  for (const e of list) {
    const d = Math.hypot(e.point[0] - p[0], e.point[1] - p[1]);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Entrances the ADR 0006 defaults made up (the floor's layout has none of its own). */
const isDefaultEntrance = (e: Entrance) => e.id.startsWith("default-");

/**
 * Open ends of the corridors: the middle of each short side of a corridor's
 * bounds, unless another corridor continues past it. On a floor without
 * entrances of its own these are where people come and go (lifts and stairs).
 */
export function corridorEnds(floor: NavFloor): Pt[] {
  const corridors = floor.zones.filter((z) => z.kind === "corridor");
  const out: Pt[] = [];
  for (const z of corridors) {
    const b = polygonBounds(z.polygon);
    const ends: [Pt, Pt][] = b.w >= b.h
      ? [[[b.x, b.y + b.h / 2], [-1, 0]], [[b.x + b.w, b.y + b.h / 2], [1, 0]]]
      : [[[b.x + b.w / 2, b.y], [0, -1]], [[b.x + b.w / 2, b.y + b.h], [0, 1]]];
    for (const [p, [dx, dy]] of ends) {
      const beyond: Pt = [p[0] + dx * 0.5, p[1] + dy * 0.5];
      if (corridors.some((o) => o !== z && pointInPolygon(beyond[0], beyond[1], o.polygon))) continue;
      out.push([p[0] - dx * 0.3, p[1] - dy * 0.3]); // just inside, so the route stays on the corridor
    }
  }
  return out;
}

/**
 * Where a walker of a kind enters or leaves the floor nearest to `p`: the
 * floor's own entrances, else its nearest corridor end, else the default entrance.
 */
export function nearestExit(floor: NavFloor, p: Pt, kind: Entrance["kind"]): Pt {
  const own = floor.entrances.filter((e) => !isDefaultEntrance(e) && e.kind === kind);
  if (own.length || kind !== "walk") return nearestEntrance(floor, p, kind).point;
  const ends = corridorEnds(floor);
  if (!ends.length) return nearestEntrance(floor, p, kind).point;
  let best = ends[0];
  for (const e of ends) if (Math.hypot(e[0] - p[0], e[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1])) best = e;
  return best;
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly floor: NavFloor;
  /** Room zone index per cell, -1 outside rooms (corridors count as outside). */
  readonly zoneAt: Int16Array;
  /** 1 where open (non-room) space is walkable. */
  readonly open: Uint8Array;
  /** Room zone index + 1 for cells near one of that room's doors, else 0. */
  readonly doorOf: Int16Array;
  /** Per room zone: true when it has doors (then it is entered only through them). */
  readonly hasDoors: boolean[];
  private paths = new Map<string, Pt[] | null>();
  // A* scratch, reused across searches (generation stamps avoid clearing).
  private g: Float64Array;
  private parent: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap: Heap;

  constructor(floor: NavFloor) {
    this.floor = floor;
    const longest = Math.max(floor.width, floor.depth);
    this.cell = Math.max(NAV_MIN_CELL, longest / NAV_MAX_CELLS);
    this.cols = Math.max(1, Math.ceil(floor.width / this.cell));
    this.rows = Math.max(1, Math.ceil(floor.depth / this.cell));
    const n = this.cols * this.rows;
    this.zoneAt = new Int16Array(n).fill(-1);
    this.open = new Uint8Array(n);
    this.doorOf = new Int16Array(n);
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Heap(n);

    const corridors = floor.zones.filter((z) => z.kind === "corridor");
    const rooms = floor.zones.map((z, i) => ({ z, i })).filter(({ z }) => z.kind !== "corridor");
    if (corridors.length) {
      for (const z of corridors) this.raster(z.polygon, (c) => { this.open[c] = 1; });
    } else {
      this.open.fill(1);
    }
    this.hasDoors = floor.zones.map(() => false);
    // Smaller rooms win where rooms overlap, so a room drawn inside a unit stays reachable.
    rooms.sort((a, b) => area(b.z.polygon) - area(a.z.polygon));
    for (const { z, i } of rooms) this.raster(z.polygon, (c) => { this.zoneAt[c] = i; });
    const r = Math.max(this.cell * 1.5, 0.75);
    for (const { z, i } of rooms) {
      const doors = (z.doors ?? []).filter((d) => Array.isArray(d) && Number.isFinite(d[0]) && Number.isFinite(d[1]));
      if (!doors.length) continue;
      this.hasDoors[i] = true;
      for (const [dx, dy] of doors) {
        this.forCellsNear(dx, dy, r, (c) => {
          this.doorOf[c] = i + 1;
          if (this.zoneAt[c] === -1) this.open[c] = 1; // a door always opens onto something walkable
        });
      }
    }
  }

  private raster(poly: readonly Pt[], fn: (c: number) => void) {
    const b = polygonBounds(poly);
    const c0 = Math.max(0, Math.floor(b.x / this.cell)), c1 = Math.min(this.cols - 1, Math.ceil((b.x + b.w) / this.cell));
    const r0 = Math.max(0, Math.floor(b.y / this.cell)), r1 = Math.min(this.rows - 1, Math.ceil((b.y + b.h) / this.cell));
    for (let r = r0; r <= r1; r++) {
      const y = (r + 0.5) * this.cell;
      for (let c = c0; c <= c1; c++) if (pointInPolygon((c + 0.5) * this.cell, y, poly)) fn(r * this.cols + c);
    }
  }

  private forCellsNear(x: number, y: number, rad: number, fn: (c: number) => void) {
    const c0 = Math.max(0, Math.floor((x - rad) / this.cell)), c1 = Math.min(this.cols - 1, Math.floor((x + rad) / this.cell));
    const r0 = Math.max(0, Math.floor((y - rad) / this.cell)), r1 = Math.min(this.rows - 1, Math.floor((y + rad) / this.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (Math.hypot((c + 0.5) * this.cell - x, (r + 0.5) * this.cell - y) <= rad) fn(r * this.cols + c);
      }
    }
  }

  cellOf(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return r * this.cols + c;
  }

  centre(i: number): Pt {
    return [((i % this.cols) + 0.5) * this.cell, (Math.floor(i / this.cols) + 0.5) * this.cell];
  }

  /** Can a figure stand in cell `i` when the path may use rooms `za` and `zb`? */
  private passable(i: number, za: number, zb: number): boolean {
    const z = this.zoneAt[i];
    return z === -1 ? this.open[i] === 1 : z === za || z === zb;
  }

  /** Can a figure step from cell a to the neighbouring cell b (rooms za/zb allowed)? */
  canStep(a: number, b: number, za: number, zb: number): boolean {
    if (!this.passable(b, za, zb)) return false;
    const zA = this.zoneAt[a], zB = this.zoneAt[b];
    if (zA === zB) return true;
    // Crossing a room's wall: allowed anywhere for rooms without doors, else only at a door.
    if (zA !== -1 && this.hasDoors[zA] && this.doorOf[a] !== zA + 1 && this.doorOf[b] !== zA + 1) return false;
    if (zB !== -1 && this.hasDoors[zB] && this.doorOf[a] !== zB + 1 && this.doorOf[b] !== zB + 1) return false;
    return true;
  }

  /** Nearest cell a figure can stand in (rooms za/zb allowed), searching outwards; -1 if none nearby. */
  private nearestPassable(i: number, za: number, zb: number): number {
    if (this.passable(i, za, zb)) return i;
    const c0 = i % this.cols, r0 = Math.floor(i / this.cols);
    const maxR = Math.max(this.cols, this.rows);
    for (let rad = 1; rad < maxR; rad++) {
      let best = -1, bd = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const r = r0 + dr, c = c0 + dc;
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const j = r * this.cols + c;
          const d = dr * dr + dc * dc;
          if (d < bd && this.passable(j, za, zb)) { bd = d; best = j; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Walking route from `from` to `to` in layout units, both ends included.
   * `fallback` is true when no route was found in budget and the result is a straight line.
   */
  route(from: Pt, to: Pt, opts: { maxMs?: number; now?: () => number } = {}): { points: Pt[]; fallback: boolean } {
    const straight = { points: [from, to] as Pt[], fallback: true };
    if (!finite(from) || !finite(to)) return straight;
    const inFrom = this.inside(from), inTo = this.inside(to);
    const fromC = this.clampPt(from), toC = this.clampPt(to);
    const s0 = this.cellOf(fromC[0], fromC[1]);
    const g0 = this.cellOf(toC[0], toC[1]);
    const za = this.zoneAt[s0], zb = this.zoneAt[g0];
    const s = this.nearestPassable(s0, za, zb);
    const g = this.nearestPassable(g0, za, zb);
    if (s < 0 || g < 0) return straight;
    const key = `${s}>${g}`;
    let mid: Pt[] | null | undefined = this.paths.get(key);
    if (mid === undefined) {
      const cells = this.astar(s, g, za, zb, opts.maxMs ?? NAV_MAX_MS, opts.now ?? defaultNow);
      if (cells === TIMED_OUT) return straight; // not cached: a later search may have more time
      mid = cells ? this.smooth(cells, za, zb).map((c) => this.centre(c)) : null;
      if (this.paths.size >= NAV_PATH_CACHE) this.paths.delete(this.paths.keys().next().value!);
      this.paths.set(key, mid);
    } else {
      // LRU: refresh recency.
      this.paths.delete(key);
      this.paths.set(key, mid);
    }
    if (!mid) return straight;
    // Real end points replace the first/last cell centres; points off the floor join with a straight run.
    const pts: Pt[] = [];
    if (!inFrom) pts.push(from);
    pts.push(fromC);
    for (let i = 1; i < mid.length - 1; i++) pts.push(mid[i]);
    pts.push(toC);
    if (!inTo) pts.push(to);
    return { points: dedupe(pts), fallback: false };
  }

  private inside(p: Pt) {
    return p[0] >= 0 && p[1] >= 0 && p[0] <= this.floor.width && p[1] <= this.floor.depth;
  }

  private clampPt(p: Pt): Pt {
    return [Math.min(this.floor.width, Math.max(0, p[0])), Math.min(this.floor.depth, Math.max(0, p[1]))];
  }

  /** Cell path, null when unreachable, or TIMED_OUT when over the time cap. */
  private astar(s: number, goal: number, za: number, zb: number, maxMs: number, now: () => number): number[] | null | typeof TIMED_OUT {
    if (s === goal) return [s];
    const gen = ++this.gen;
    if (gen === 0xffffffff) { this.seen.fill(0); this.closed.fill(0); this.gen = 1; }
    const { cols, g, parent, seen, closed, heap } = this;
    const gc = goal % cols, gr = Math.floor(goal / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc), dy = Math.abs(Math.floor(i / cols) - gr);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    heap.clear();
    g[s] = 0; parent[s] = -1; seen[s] = this.gen;
    heap.push(s, h(s));
    const t0 = now();
    let n = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === this.gen) continue;
      closed[cur] = this.gen;
      if (cur === goal) {
        const out: number[] = [];
        for (let c = cur; c !== -1; c = parent[c]) out.push(c);
        return out.reverse();
      }
      if ((++n & 255) === 0 && now() - t0 > maxMs) return TIMED_OUT;
      const c = cur % cols, r = Math.floor(cur / cols);
      for (let k = 0; k < 8; k++) {
        const dc = DC[k], dr = DR[k];
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= this.rows) continue;
        const nb = nr * cols + nc;
        if (closed[nb] === this.gen || !this.canStep(cur, nb, za, zb)) continue;
        if (dc && dr) {
          // No corner cutting: both orthogonal neighbours must be steppable too.
          const a1 = r * cols + nc, a2 = nr * cols + c;
          if (!this.canStep(cur, a1, za, zb) || !this.canStep(a1, nb, za, zb) || !this.canStep(cur, a2, za, zb) || !this.canStep(a2, nb, za, zb)) continue;
        }
        const ng = g[cur] + (dc && dr ? Math.SQRT2 : 1);
        if (seen[nb] !== this.gen || ng < g[nb]) {
          seen[nb] = this.gen; g[nb] = ng; parent[nb] = cur;
          heap.push(nb, ng + h(nb));
        }
      }
    }
    return null;
  }

  /** Line of sight between two cells: every cell the segment between their centres crosses must be a legal step. */
  lineOfSight(a: number, b: number, za: number, zb: number): boolean {
    const cols = this.cols;
    let x = a % cols, y = Math.floor(a / cols);
    const nx = Math.abs(b % cols - x), ny = Math.abs(Math.floor(b / cols) - y);
    const sx = b % cols > x ? 1 : -1, sy = Math.floor(b / cols) > y ? 1 : -1;
    let cur = a;
    for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision <= 0 && ix < nx) {
        x += sx; ix++;
        const next = y * cols + x;
        if (!this.canStep(cur, next, za, zb)) return false;
        cur = next;
        if (decision < 0) continue;
      }
      if (iy < ny) {
        y += sy; iy++;
        const next = y * cols + x;
        if (!this.canStep(cur, next, za, zb)) return false;
        cur = next;
      }
    }
    return true;
  }

  /** Greedy string pulling: keep only the cells where the straight line of sight breaks. */
  private smooth(cells: number[], za: number, zb: number): number[] {
    if (cells.length <= 2) return cells;
    const out = [cells[0]];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let far = anchor + 1;
      for (let j = anchor + 2; j < cells.length; j++) {
        if (this.lineOfSight(cells[anchor], cells[j], za, zb)) far = j; else break;
      }
      out.push(cells[far]);
      anchor = far;
    }
    return out;
  }
}

const TIMED_OUT = Symbol("timed out");
const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];
const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const finite = (p: Pt) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

function area(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  return out.length >= 2 ? out : [pts[0], pts[pts.length - 1]];
}

/** Binary min-heap of cell indices keyed by f. */
class Heap {
  private idx: Int32Array;
  private key: Float64Array;
  size = 0;
  constructor(cap: number) { this.idx = new Int32Array(Math.max(16, cap)); this.key = new Float64Array(Math.max(16, cap)); }
  clear() { this.size = 0; }
  push(i: number, k: number) {
    if (this.size === this.idx.length) {
      const ni = new Int32Array(this.idx.length * 2); ni.set(this.idx); this.idx = ni;
      const nk = new Float64Array(this.key.length * 2); nk.set(this.key); this.key = nk;
    }
    let p = this.size++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q]; this.key[p] = this.key[q]; p = q;
    }
    this.idx[p] = i; this.key[p] = k;
  }
  pop(): number {
    const top = this.idx[0];
    const li = this.idx[--this.size], lk = this.key[this.size];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c]; p = c;
    }
    this.idx[p] = li; this.key[p] = lk;
    return top;
  }
}

const grids = new WeakMap<object, NavGrid>();

/** Navigation grid for a layout, built once per layout object. */
export function navGridFor(layout: SiteLayout): NavGrid {
  let g = grids.get(layout);
  if (!g) { g = new NavGrid(navFloorOf(layout)); grids.set(layout, g); }
  return g;
}
