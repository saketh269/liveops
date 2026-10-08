// Walking routes for moving figures (ADR 0006, LIVEOPS-98, LIVEOPS-107).
//
// Navigation walks on the floor's shared wall plan (world/wallPlan.ts): the same
// wall segments and door gaps the 3D world draws. A* on its fine grid of cells
// that keep a walker clear of every wall and desk, preferring corridors and the
// middle of the floor over squeezing along walls; then string-pulled to straight
// runs, keeping only runs that stay on walkable cells. A route never crosses a
// wall: when the goal cannot be reached, it ends at the nearest reachable point
// (`reached: false`) and the caller puts the figure in place from there.
import { floorIdOf, floorsOf, zonesOnFloor } from "./floors";
import type { Entrance, SiteLayout, Zone } from "../api/types";
import { pointInPolygon, polygonBounds, type Pt } from "./placement";
import { WORLD } from "./world/style";
import { WALKER_RADIUS, clearOfDesks, segmentClear, wallPlanFor, type FloorWallPlan } from "./world/wallPlan";

export const NAV_PATH_CACHE = 4096;
/** A straight run between two points is kept when it stays this far from every wall centre line (half a wall + a little). */
export const DIRECT_MARGIN = WORLD.wallThickness / 2 + 0.12;
/** Step cost outside corridors on floors that have corridors (corridors are preferred). */
const OPEN_COST = 1.4;
/** Step cost through a walled room that is neither the start's nor the goal's. */
const OTHER_ROOM_COST = 6;
/** Extra step cost next to a wall or desk. */
const NEAR_WALL_COST = 0.35;
/** How far (m) to look for a walkable spot next to a point that is not on one. */
const SNAP_RADIUS = 4;

export type NavFloor = {
  width: number;
  depth: number;
  zones: Zone[];
  /** The floor's own entrances (the building walls have openings at these). */
  entrances: Entrance[];
};

/** A walking route; `reached` is false when the goal can't be walked to and the route stops at the nearest reachable point. */
export type Route = { points: Pt[]; reached: boolean };

/**
 * The single floor a view draws: the first floor of the layout (views pass one
 * floor at a time, `floorLayout`), with its zones and own entrances.
 */
export function navFloorOf(layout: SiteLayout | null | undefined): NavFloor {
  const floor = floorsOf(layout)[0];
  const zones = zonesOnFloor(layout, floor.id).filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3);
  const entrances = (layout?.entrances ?? []).filter((e) => Array.isArray(e.point) && Number.isFinite(e.point[0]) && Number.isFinite(e.point[1]) && floorIdOf(layout, e) === floor.id);
  return { width: floor.width, depth: floor.depth, zones, entrances };
}

/**
 * Open ends of the corridors: the middle of each short side of a corridor's
 * bounds, unless another corridor continues past it. On a floor without
 * entrances of its own these stand for the lift and stair cores.
 */
export function corridorEnds(floor: Pick<NavFloor, "zones">): Pt[] {
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
      out.push([p[0] - dx, p[1] - dy]); // a metre in, so the core is inside the building
    }
  }
  return out;
}

export class NavGrid {
  readonly floor: NavFloor;
  /** The shared wall plan this grid walks on. */
  readonly plan: FloorWallPlan;
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  private paths = new Map<string, number[] | null>();
  private spawns = new Map<string, Pt[]>();
  private warned = new Set<string>();
  // A* scratch, reused across searches (generation stamps avoid clearing).
  private g: Float64Array;
  private parent: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap: Heap;

  constructor(floor: NavFloor) {
    this.floor = floor;
    this.plan = wallPlanFor(floor);
    const { cols, rows, cell } = this.plan.grid;
    this.cols = cols; this.rows = rows; this.cell = cell;
    const n = cols * rows;
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Heap(Math.min(n, 1 << 16));
  }

  cellOf(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return r * this.cols + c;
  }

  centre(i: number): Pt {
    return [((i % this.cols) + 0.5) * this.cell, (Math.floor(i / this.cols) + 0.5) * this.cell];
  }

  /** Can a walker stand here? */
  walkable(p: Pt): boolean {
    return this.onFloor(p) && this.plan.grid.free[this.cellOf(p[0], p[1])] === 1;
  }

  /**
   * Walking route from `from` to `to` (layout metres), both ends included when reached.
   * Every run between consecutive points stays clear of the plan's walls.
   */
  route(from: Pt, to: Pt): Route {
    if (!finite(from) || !finite(to) || !this.onFloor(from) || !this.onFloor(to)) {
      // Off the floor (the Unassigned strip) there is nothing to walk on: put the figure in place.
      return this.unreachable(from, to, [from]);
    }
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1e-9) return { points: [from, to], reached: true };
    if (this.directOk(from, to)) return { points: [from, to], reached: true };
    const s = this.snap(from);
    if (s < 0) return this.unreachable(from, to, [from]);
    const gs = this.snap(to);
    const { comp } = this.plan.grid;
    let g = gs;
    let reached = true;
    if (g < 0 || comp[g] !== comp[s]) {
      g = this.nearestInComp(comp[s], to);
      reached = false;
    }
    const cells = this.search(s, g);
    if (!cells) return this.unreachable(from, to, [from]); // cannot happen: same connected area
    const pts: Pt[] = [from, ...cells.map((c) => this.centre(c))];
    if (reached) pts.push(to);
    const out = dedupe(pts);
    if (!reached) return this.unreachable(from, to, out);
    return { points: out.length >= 2 ? out : [from, to], reached: true };
  }

  /** Route through several waypoints in turn; stops at the first leg that can't be walked. */
  walk(waypoints: readonly Pt[]): Route {
    if (waypoints.length < 2) return { points: [...waypoints], reached: true };
    const pts: Pt[] = [waypoints[0]];
    for (let i = 1; i < waypoints.length; i++) {
      const r = this.route(pts[pts.length - 1], waypoints[i]);
      pts.push(...r.points.slice(1));
      if (!r.reached) return { points: pts, reached: false };
    }
    return { points: dedupe(pts), reached: true };
  }

  /**
   * Where a walker (or vehicle) of a kind comes onto and leaves the floor nearest to `p`:
   * a spot just inside one of the floor's own entrances of that kind; for walkers on a
   * floor without one, the lift and stair cores at the corridor ends (else the middle of
   * the floor). Always on a walkable spot inside the building. Null for vehicles on a floor
   * without an ambulance entrance (they appear in place).
   */
  exitNear(p: Pt, kind: Entrance["kind"]): Pt | null {
    const list = this.spawnPoints(kind);
    if (!list.length) return null;
    let best = list[0];
    for (const e of list) if (Math.hypot(e[0] - p[0], e[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1])) best = e;
    return best;
  }

  /** Raw entrance point of a kind nearest `p` (vehicles drive in through its opening), or null. */
  entranceNear(p: Pt, kind: Entrance["kind"]): Pt | null {
    const own = this.floor.entrances.filter((e) => e.kind === kind);
    if (!own.length) return null;
    let best = own[0].point;
    for (const e of own) if (Math.hypot(e.point[0] - p[0], e.point[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1])) best = e.point;
    return [best[0], best[1]];
  }

  private spawnPoints(kind: Entrance["kind"]): Pt[] {
    const hit = this.spawns.get(kind);
    if (hit) return hit;
    let raw: Pt[] = this.floor.entrances.filter((e) => e.kind === kind).map((e) => [e.point[0], e.point[1]] as Pt);
    if (!raw.length && kind === "walk") {
      raw = corridorEnds(this.floor);
      if (!raw.length) raw = [[this.floor.width / 2, this.floor.depth / 2]];
    }
    const out: Pt[] = [];
    for (const p of raw) {
      const c = kind === "walk" ? this.coreCell(p) : this.snap(p);
      if (c < 0) continue;
      // Vehicles keep their entrance point when it is walkable (the approach road meets it there).
      out.push(kind !== "walk" && this.walkable(p) ? p : this.centre(c));
    }
    this.spawns.set(kind, out);
    return out;
  }

  /** Nearest free cell to `p` in the floor's main walkable area, outside rooms when possible. */
  private coreCell(p: Pt): number {
    const { free, comp, room, mainComp } = this.plan.grid;
    let best = -1, bd = Infinity, bestAny = -1, bdAny = Infinity;
    for (let i = 0; i < free.length; i++) {
      if (!free[i] || comp[i] !== mainComp) continue;
      const c = this.centre(i);
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d < bdAny) { bdAny = d; bestAny = i; }
      if (room[i] === -1 && d < bd) { bd = d; best = i; }
    }
    return best >= 0 ? best : bestAny;
  }

  private onFloor(p: Pt) {
    return p[0] >= 0 && p[1] >= 0 && p[0] <= this.floor.width && p[1] <= this.floor.depth;
  }

  /** A straight run is fine when it keeps clear of walls and desks and stays inside the floor. */
  private directOk(a: Pt, b: Pt): boolean {
    if (!segmentClear(this.plan, a, b, DIRECT_MARGIN)) return false;
    return clearOfDesks(this.plan, a, b, WALKER_RADIUS);
  }

  private unreachable(from: Pt, to: Pt, points: Pt[]): Route {
    const key = `${from.map((v) => v.toFixed(1))}>${to.map((v) => v.toFixed(1))}`;
    if (!this.warned.has(key) && typeof console !== "undefined") {
      this.warned.add(key);
      if (this.warned.size > 256) this.warned.clear();
      console.debug(`[liveops] no walking route from (${key.replace(">", ") to (")}); the figure is put in place instead`);
    }
    return { points: points.length ? points : [from], reached: false };
  }

  /**
   * Cell to walk from or to for a point: its own cell when free, else the nearest free cell
   * that can be reached from the point in a straight line without crossing a wall; -1 if none.
   */
  private snap(p: Pt): number {
    const { free } = this.plan.grid;
    const i0 = this.cellOf(p[0], p[1]);
    if (free[i0]) return i0;
    const c0 = i0 % this.cols, r0 = Math.floor(i0 / this.cols);
    const maxR = Math.ceil(SNAP_RADIUS / this.cell);
    const tests: ((c: Pt) => boolean)[] = [
      (c) => segmentClear(this.plan, p, c, WORLD.wallThickness / 2),
      (c) => segmentClear(this.plan, p, c, 0),
      () => true, // a point right on a wall line: either side will do
    ];
    for (const ok of tests) {
      let best = -1, bd = Infinity;
      for (let rad = 1; rad <= maxR; rad++) {
        for (let dr = -rad; dr <= rad; dr++) {
          for (let dc = -rad; dc <= rad; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
            const r = r0 + dr, c = c0 + dc;
            if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
            const j = r * this.cols + c;
            if (!free[j]) continue;
            const q = this.centre(j);
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d < bd && ok(q)) { bd = d; best = j; }
          }
        }
        // Rings are squares: a later ring can still hold a nearer cell, up to √2 further out.
        if (best >= 0 && bd <= rad * this.cell) return best;
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Free cell of a connected area nearest to `p`. */
  private nearestInComp(id: number, p: Pt): number {
    const { comp } = this.plan.grid;
    let best = -1, bd = Infinity;
    for (let i = 0; i < comp.length; i++) {
      if (comp[i] !== id) continue;
      const q = this.centre(i);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Smoothed cell path s → g (cached), or null when not connected. */
  private search(s: number, g: number): number[] | null {
    const key = `${s}>${g}`;
    let hit = this.paths.get(key);
    if (hit !== undefined) {
      this.paths.delete(key);
      this.paths.set(key, hit);
      return hit;
    }
    const raw = this.astar(s, g);
    hit = raw ? this.smooth(raw) : null;
    if (this.paths.size >= NAV_PATH_CACHE) this.paths.delete(this.paths.keys().next().value!);
    this.paths.set(key, hit);
    return hit;
  }

  private stepCost(i: number, ra: number, rb: number): number {
    const { corridor, room, nearWall, hasCorridors } = this.plan.grid;
    const z = room[i];
    let c = z !== -1 ? (z === ra || z === rb ? 1 : OTHER_ROOM_COST) : corridor[i] || !hasCorridors ? 1 : OPEN_COST;
    if (nearWall[i]) c += NEAR_WALL_COST;
    return c;
  }

  private astar(s: number, goal: number): number[] | null {
    if (s === goal) return [s];
    if (++this.gen === 0xffffffff) { this.seen.fill(0); this.closed.fill(0); this.gen = 1; }
    const gen = this.gen;
    const { cols, rows, g, parent, seen, closed, heap } = this;
    const { free, room } = this.plan.grid;
    const ra = room[s], rb = room[goal];
    const gc = goal % cols, gr = Math.floor(goal / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc), dy = Math.abs(Math.floor(i / cols) - gr);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    heap.clear();
    g[s] = 0; parent[s] = -1; seen[s] = gen;
    heap.push(s, h(s));
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) {
        const out: number[] = [];
        for (let c = cur; c !== -1; c = parent[c]) out.push(c);
        return out.reverse();
      }
      const c = cur % cols, r = (cur - c) / cols;
      for (let k = 0; k < 8; k++) {
        const dc = DC[k], dr = DR[k];
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (!free[nb] || closed[nb] === gen) continue;
        // No corner cutting: a diagonal step needs both side cells free.
        if (dc && dr && (!free[r * cols + nc] || !free[nr * cols + c])) continue;
        const ng = g[cur] + (dc && dr ? Math.SQRT2 : 1) * this.stepCost(nb, ra, rb);
        if (seen[nb] !== gen || ng < g[nb]) {
          seen[nb] = gen; g[nb] = ng; parent[nb] = cur;
          heap.push(nb, ng + h(nb));
        }
      }
    }
    return null;
  }

  /**
   * True when the straight run between two points stays on free cells (sampled at a
   * quarter cell; a free cell's centre keeps a walker clear of walls, so the run does too).
   */
  losFree(a: Pt, b: Pt): boolean {
    const { free } = this.plan.grid;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / (this.cell / 4)));
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
      if (x < 0 || y < 0 || x > this.floor.width || y > this.floor.depth) return false;
      if (!free[this.cellOf(x, y)]) return false;
    }
    return true;
  }

  /** Corners of a cell path, then greedy string pulling between them along walkable runs. */
  private smooth(cells: number[]): number[] {
    if (cells.length <= 2) return cells;
    const corners = [cells[0]];
    for (let i = 1; i < cells.length - 1; i++) {
      const a = cells[i - 1], b = cells[i], c = cells[i + 1];
      if (b - a !== c - b) corners.push(b);
    }
    corners.push(cells[cells.length - 1]);
    const out = [corners[0]];
    let anchor = 0;
    while (anchor < corners.length - 1) {
      let far = anchor + 1;
      for (let j = corners.length - 1; j > anchor + 1; j--) {
        if (this.losFree(this.centre(corners[anchor]), this.centre(corners[j]))) { far = j; break; }
      }
      out.push(corners[far]);
      anchor = far;
    }
    return out;
  }
}

const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];
const finite = (p: Pt) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  return out;
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

/** Navigation grid for a layout, built once per layout object (the wall plan is shared across equal floors). */
export function navGridFor(layout: SiteLayout): NavGrid {
  let g = grids.get(layout);
  if (!g) { g = new NavGrid(navFloorOf(layout)); grids.set(layout, g); }
  return g;
}
