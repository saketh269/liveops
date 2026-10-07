// Movement of figures between placements (LIVEOPS-98).
//
// Movement only ever presents a real change to a record: its zone, x/y, anchor
// or floor changed, or the record was added or removed after the first
// snapshot. Nothing moves on its own; when data stops, figures stop. Figures
// that only shift because their zone was re-packed jump to the new slot.
//
// Time-based: a figure's position is a pure function of its route, start time
// and speed, so frame rate does not change where it is. The clock is injected
// so tests are deterministic.
import type { Asset, SiteLayout } from "../api/types";
import { figureOf, isPerson, isVehicle, type FigureModel } from "./figures";
import { navGridFor, nearestEntrance, type NavGrid } from "./navigation";
import type { Placement, PlacementResult, Pt } from "./placement";

/** Walking speed in layout units per second (layouts are drawn in metres: 1.4 m/s). */
export const WALK_SPEED = 1.4;
/** Vehicles drive faster, on an approach road to the ambulance entrance. */
export const DRIVE_SPEED = 8;
/** Longer trips are sped up so the map never trails the data by more than this. */
export const MAX_TRAVEL_S = 12;
/** How far outside the floor an ambulance's approach road starts or ends. */
export const APPROACH_DISTANCE = 15;
/** Above this many simultaneous walkers, further changes jump instead of walking. */
export const MAX_WALKERS = 1000;
/** Path-finding time per frame; the rest waits for the next frame. */
export const PATH_BUDGET_MS = 4;

export type FigureState = {
  readonly id: string;
  x: number;
  y: number;
  /** Direction of travel in layout coordinates (radians, atan2(dy, dx)). */
  heading: number;
  /** Stack level at rest (0 while moving). */
  level: number;
  /** Footprint edge length for drawing. */
  size: number;
  model: FigureModel;
  /** Last data seen for the record (kept while a removed record walks out). */
  asset: Asset;
  /** True while walking out after the record was removed. */
  leaving: boolean;
};

type Walk = {
  plan: () => Pt[];
  route: Pt[] | null;
  cum: number[];
  total: number;
  speed: number;
  t0: number;
  seg: number;
};

type Fig = FigureState & { key: string; target: Placement | null; walk: Walk | null };

export type MotionOptions = {
  now?: () => number;
  maxWalkers?: number;
  budgetMs?: number;
  /** Override the navigation grid (tests). */
  nav?: (layout: SiteLayout) => NavGrid;
};

export type StepResult = { moved: string[]; finished: boolean };

const EPS = 1e-6;
const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Fields whose change is a real move. Anything else (state, label…) never moves a figure. */
export function motionKey(a: Asset): string {
  const s = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return `${s(a.zone)}\u0001${s(a.x)}\u0001${s(a.y)}\u0001${s(a.anchor)}\u0001${s(a.floor)}`;
}

export class Motion {
  private figs = new Map<string, Fig>();
  private walking = new Set<string>();
  private pending = new Set<string>();
  private layout: SiteLayout = {};
  private primed = false;
  private enabled = true;
  private now: () => number;
  private maxWalkers: number;
  private budgetMs: number;
  private navFor: (layout: SiteLayout) => NavGrid;
  private lastAssets: ReadonlyMap<string, Asset> | null = null;
  private lastPlacement: PlacementResult | null = null;
  /** Bumped whenever the set of leaving figures changes. */
  departingVersion = 0;
  /** Figures whose position or walking state changed outside step() (started walking, jumped, landed). */
  private touched = new Set<string>();

  constructor(opts: MotionOptions = {}) {
    this.now = opts.now ?? defaultNow;
    this.maxWalkers = opts.maxWalkers ?? MAX_WALKERS;
    this.budgetMs = opts.budgetMs ?? PATH_BUDGET_MS;
    this.navFor = opts.nav ?? navGridFor;
  }

  /** New layout (or a different floor/filter): the next update places everyone instantly. */
  setLayout(layout: SiteLayout) {
    if (layout === this.layout) return;
    this.layout = layout;
    this.reset();
  }

  /** Forget motion; the next update is treated as a fresh snapshot (no walk-in). */
  reset() {
    const hadLeaving = [...this.figs.values()].some((f) => f.leaving);
    this.figs.clear();
    this.walking.clear();
    this.pending.clear();
    this.primed = false;
    this.lastAssets = null;
    this.lastPlacement = null;
    this.touched.clear();
    if (hadLeaving) this.departingVersion++;
  }

  /** Off (reduced motion, ?motion=off): every change jumps. Turning it off lands current walkers. */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.landAll();
  }

  get isEnabled() { return this.enabled; }
  get walkerCount() { return this.walking.size; }

  get(id: string): FigureState | undefined {
    return this.figs.get(id);
  }

  /** Every drawn figure: current records plus removed ones still walking out. */
  all(): IterableIterator<FigureState> {
    return this.figs.values();
  }

  isMoving(id: string): boolean {
    return this.walking.has(id);
  }

  /** Ids touched since the last call (see `touched`); the caller redraws them. */
  drainTouched(): string[] {
    const out = [...this.touched];
    this.touched.clear();
    return out;
  }

  /** Records that were removed but are still walking out, with their final data. */
  departing(): Map<string, Asset> {
    const out = new Map<string, Asset>();
    for (const f of this.figs.values()) if (f.leaving) out.set(f.id, f.asset);
    return out;
  }

  /**
   * Apply the current records and their placement. `instant` (first snapshot)
   * places everything without movement.
   */
  update(assets: ReadonlyMap<string, Asset>, placement: PlacementResult, instant = false) {
    if (!instant && this.primed && assets === this.lastAssets && placement === this.lastPlacement) return;
    this.lastAssets = assets;
    this.lastPlacement = placement;
    const now = this.now();
    if (instant || !this.primed) {
      this.reset();
      this.lastAssets = assets;
      this.lastPlacement = placement;
      this.primed = true;
      for (const [id, p] of placement.positions) {
        const a = assets.get(id);
        if (a) this.figs.set(id, this.restingFig(id, a, p));
      }
      return;
    }
    let departuresChanged = false;
    for (const [id, p] of placement.positions) {
      const a = assets.get(id);
      if (!a) continue;
      const known = this.figs.get(id);
      if (known && known.asset === a && known.target === p && !known.leaving) continue; // unchanged record (the common case)
      const key = motionKey(a);
      const model = figureOf(a);
      const f = this.figs.get(id);
      if (!f) {
        this.arrive(id, a, p, key, model, now);
        continue;
      }
      this.sample(f, now);
      const wasLeaving = f.leaving;
      const moved = key !== f.key || wasLeaving;
      const retarget = !samePlace(f.target, p);
      f.asset = a; f.model = model; f.key = key; f.target = p; f.size = p.size; f.leaving = false;
      if (wasLeaving) departuresChanged = true;
      if (moved || (retarget && f.walk)) {
        // Real change (or a walker whose destination slot shifted): walk from where it is now.
        if (this.dist(f, p) > EPS) this.startWalk(f, () => this.nav().route([f.x, f.y], [p.x, p.y]).points, model, now);
        else this.land(f);
      } else if (retarget) {
        this.land(f); // re-packed zone: not a change to this record, so no movement
      }
    }
    for (const f of this.figs.values()) {
      if (placement.positions.has(f.id) && assets.has(f.id)) continue;
      if (f.leaving) continue;
      this.sample(f, now);
      f.leaving = true;
      f.target = null;
      departuresChanged = true;
      this.startWalk(f, () => this.exitRoute([f.x, f.y], f.model), f.model, now);
    }
    if (departuresChanged) this.departingVersion++;
  }

  /** Advance every walker to `now`. Returns the ids that moved and whether any figure finished leaving. */
  step(): StepResult {
    const moved: string[] = [];
    let finished = false;
    if (!this.walking.size) return { moved, finished };
    const t0 = this.now();
    let planned = 0;
    for (const id of this.pending) {
      if (planned > 0 && this.now() - t0 > this.budgetMs) break;
      const f = this.figs.get(id);
      this.pending.delete(id);
      if (!f?.walk) continue;
      this.plan(f.walk, [f.x, f.y], this.now());
      planned++;
    }
    const now = this.now();
    for (const id of this.walking) {
      const f = this.figs.get(id)!;
      if (!f.walk?.route) continue;
      this.sample(f, now);
      moved.push(id);
      if (!f.walk) {
        if (f.leaving) { this.drop(id); finished = true; }
      }
    }
    if (finished) this.departingVersion++;
    return { moved, finished };
  }

  // ---- internals ----

  private nav(): NavGrid {
    return this.navFor(this.layout);
  }

  private restingFig(id: string, a: Asset, p: Placement): Fig {
    return { id, x: p.x, y: p.y, heading: 0, level: p.level, size: p.size, model: figureOf(a), asset: a, leaving: false, key: motionKey(a), target: p, walk: null };
  }

  private arrive(id: string, a: Asset, p: Placement, key: string, model: FigureModel, now: number) {
    const f = this.restingFig(id, a, p);
    f.key = key;
    this.figs.set(id, f);
    if (!this.enabled || this.walking.size >= this.maxWalkers) return;
    const vehicle = isVehicle(model);
    const nav = this.nav();
    const entrance = nearestEntrance(nav.floor, [p.x, p.y], vehicle ? "ambulance" : "walk").point;
    const start: Pt = vehicle ? approachPoint(nav, entrance) : entrance;
    f.x = start[0]; f.y = start[1]; f.level = 0;
    this.startWalk(f, () => {
      const inner = this.nav().route(entrance, [p.x, p.y]).points;
      return vehicle ? [start, ...inner] : inner;
    }, model, now);
  }

  private exitRoute(from: Pt, model: FigureModel): Pt[] {
    const nav = this.nav();
    const vehicle = isVehicle(model);
    const exit = nearestEntrance(nav.floor, from, vehicle ? "ambulance" : "walk").point;
    const inner = nav.route(from, exit).points;
    return vehicle ? [...inner, approachPoint(nav, exit)] : inner;
  }

  private startWalk(f: Fig, plan: () => Pt[], model: FigureModel, now: number) {
    if (!this.enabled || (!this.walking.has(f.id) && this.walking.size >= this.maxWalkers)) {
      if (f.leaving) this.drop(f.id); else this.land(f);
      return;
    }
    f.walk = { plan, route: null, cum: [0], total: 0, speed: isVehicle(model) ? DRIVE_SPEED : WALK_SPEED, t0: now, seg: 0 };
    f.level = 0;
    this.touched.add(f.id);
    this.walking.add(f.id);
    // Re-queue at the back so a walker that changed again waits its turn fairly.
    this.pending.delete(f.id);
    this.pending.add(f.id);
  }

  private plan(w: Walk, from: Pt, now: number) {
    let route = w.plan();
    if (route.length < 2) route = [from, route[0] ?? from];
    // The figure starts exactly where it is drawn now.
    route = [from, ...route.slice(1)];
    const cum = [0];
    for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
    w.route = route;
    w.cum = cum;
    w.total = cum[cum.length - 1];
    w.speed = Math.max(w.speed, w.total / MAX_TRAVEL_S);
    w.t0 = now;
    w.seg = 0;
  }

  /** Move a walking figure to where it is at `now`; lands it when the route is done. */
  private sample(f: Fig, now: number) {
    const w = f.walk;
    if (!w || !w.route) return;
    const d = Math.max(0, ((now - w.t0) / 1000) * w.speed);
    if (d >= w.total - EPS) {
      const end = w.route[w.route.length - 1];
      const prev = w.route[w.route.length - 2] ?? end;
      if (Math.hypot(end[0] - prev[0], end[1] - prev[1]) > EPS) f.heading = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
      f.x = end[0]; f.y = end[1];
      if (f.leaving) { f.walk = null; this.walking.delete(f.id); return; }
      this.land(f);
      return;
    }
    while (w.seg < w.cum.length - 2 && w.cum[w.seg + 1] <= d) w.seg++;
    const a = w.route[w.seg], b = w.route[w.seg + 1];
    const len = w.cum[w.seg + 1] - w.cum[w.seg];
    const t = len > EPS ? (d - w.cum[w.seg]) / len : 1;
    f.x = a[0] + (b[0] - a[0]) * t;
    f.y = a[1] + (b[1] - a[1]) * t;
    if (len > EPS) f.heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  /** Put a figure at rest on its target. */
  private land(f: Fig) {
    if (f.target) {
      f.x = f.target.x; f.y = f.target.y; f.level = f.target.level; f.size = f.target.size;
    }
    if (!isPerson(f.model) && !isVehicle(f.model)) f.heading = 0; // beds and equipment rest square to the room
    f.walk = null;
    this.walking.delete(f.id);
    this.pending.delete(f.id);
    this.touched.add(f.id);
  }

  private landAll() {
    for (const id of [...this.walking]) {
      const f = this.figs.get(id)!;
      if (f.leaving) this.drop(id); else this.land(f);
    }
    this.departingVersion++;
  }

  private drop(id: string) {
    this.figs.delete(id);
    this.walking.delete(id);
    this.pending.delete(id);
  }

  private dist(f: Fig, p: Placement) {
    return Math.hypot(f.x - p.x, f.y - p.y);
  }
}

function samePlace(a: Placement | null, b: Placement): boolean {
  return !!a && Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && a.level === b.level && Math.abs(a.size - b.size) < EPS;
}

/** A point on the approach road outside the floor, straight out from the entrance's nearest edge. */
export function approachPoint(nav: NavGrid, e: Pt, distance = APPROACH_DISTANCE): Pt {
  const { width, depth } = nav.floor;
  const edges: [number, Pt][] = [[e[0], [-1, 0]], [width - e[0], [1, 0]], [e[1], [0, -1]], [depth - e[1], [0, 1]]];
  let nx = 0, ny = 0;
  const min = Math.min(...edges.map(([d]) => Math.abs(d)));
  for (const [d, n] of edges) if (Math.abs(Math.abs(d) - min) < 0.5) { nx += n[0]; ny += n[1]; }
  if (min > 0.5) { nx = e[0] - width / 2; ny = e[1] - depth / 2; }
  const len = Math.hypot(nx, ny) || 1;
  return [e[0] + (nx / len) * distance, e[1] + (ny / len) * distance];
}
