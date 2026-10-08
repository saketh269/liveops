// Live tracking: follow one record, switch floors when it changes floor, say where it
// is when it is somewhere the floor plan does not show, and stop when it leaves the
// site. Pure, so the rules are testable.
import type { Asset, SiteLayout } from "../../api/types";
import { assetFloorId, floorIdOf, resolveFloor } from "../floors";
import { placeName } from "../labels";
import { explicitPosition, resolveZone } from "../placement";

/** A record missing this long (seconds) has left; shorter gaps are a source re-listing it. */
export const GONE_AFTER_S = 30;
/** Trail kept behind a tracked figure (seconds). */
export const TRAIL_S = 5 * 60;
export const TRAIL_MAX_POINTS = 600;
/** Trail points closer than this (metres) are merged. */
export const TRAIL_MIN_STEP = 0.3;

/** Where a tracked record is, as far as the floor plan can tell. */
export type Place = {
  /** Floor to show; null when nothing says which floor (the map stays where it is). */
  floorId: string | null;
  /** True when the record is drawn on that floor, false for a place the plan does not have. */
  onPlan: boolean;
  /** Plain words, after the record's name: "in 4E-401A", "on the way from 3W-305A to 4E-401A", "at Radiology – MRI". */
  where: string;
};

// "En route 3W-305A → 4E-401A", "In transit from ED-04 to 3W-305A", "3W-305A -> 4E-401A".
const TRANSIT_WORDS = /^(?:en[\s-]?route|in[\s-]?transit|transfer(?:ring)?|moving)\b[\s:–-]*(?:from\s+)?(.+?)\s*(?:→|->|=>|➔|⟶|\bto\b)\s*(.+)$/i;
const TRANSIT_ARROW = /^(?:from\s+)?(.+?)\s*(?:→|->|=>|➔|⟶)\s*(.+)$/;
const LEFT_SITE = /^(?:discharged|deceased|expired|left(?: the)? (?:site|hospital|building))$/i;

/** "En route X → Y" as {from, to}; null when the text is not a journey between two places. */
export function transitOf(text: string): { from: string; to: string } | null {
  const m = TRANSIT_WORDS.exec(text.trim()) ?? TRANSIT_ARROW.exec(text.trim());
  return m && m[1].trim() && m[2].trim() ? { from: m[1].trim(), to: m[2].trim() } : null;
}

/** A record whose location or status says it has left the hospital ("Discharged"). */
export function hasLeftSite(a: Asset): boolean {
  const status = a.attributes?.status;
  return [a.zone, a.state, status].some((v) => typeof v === "string" && LEFT_SITE.test(v.trim()));
}

/**
 * Where a record is for the tracker. A zone on the plan gives its floor. A journey
 * ("En route X → Y") shows the floor it is heading to (else the one it left). Any
 * other place the plan does not have keeps the map where it is and is named instead:
 * never the first floor's Unassigned strip, which on a hospital is the basement.
 */
export function placeOf(layout: SiteLayout | null | undefined, a: Asset): Place {
  const zones = layout?.zones ?? [];
  const raw = a.zone === undefined || a.zone === null ? "" : String(a.zone).trim();
  const explicit = resolveFloor(layout, a.floor);
  const zone = resolveZone(zones, raw);
  if (zone) {
    const drawnOn = assetFloorId(layout, a);
    return { floorId: drawnOn, onPlan: drawnOn === floorIdOf(layout, zone), where: `in ${placeName(layout, zone.id)}` };
  }
  if (explicit && explicitPosition(a)) return { floorId: explicit.id, onPlan: true, where: raw ? `at ${placeName(layout, raw)}` : `on ${explicit.name}` };
  const trip = raw ? transitOf(raw) : null;
  if (trip) {
    const to = resolveZone(zones, trip.to);
    const from = resolveZone(zones, trip.from);
    const floorId = explicit?.id ?? (to ? floorIdOf(layout, to) : from ? floorIdOf(layout, from) : null);
    return { floorId, onPlan: false, where: `on the way from ${placeName(layout, trip.from)} to ${placeName(layout, trip.to)}` };
  }
  return { floorId: explicit?.id ?? null, onPlan: false, where: raw ? `at ${placeName(layout, raw)}` : "somewhere your sources do not name" };
}

export type TrackState = {
  id: string;
  /** Floor the tracker shows the record on. */
  floorId: string | null;
  where: string;
  onPlan: boolean;
  /** When it went missing (epoch s), null while present. */
  missingSince: number | null;
};

export type TrackUpdate = {
  next: TrackState;
  /** Floor the map should switch to. */
  switchTo?: string;
  notice?: string;
  /** Tracking is over (discharged, or no longer reported). */
  stop?: boolean;
};

export function startTracking(id: string, place: Place | null): TrackState {
  return { id, floorId: place?.floorId ?? null, where: place?.where ?? "", onPlan: place?.onPlan ?? true, missingSince: null };
}

/**
 * One step of the tracker for the record's current data (undefined = not on the map now).
 * `place` says where a record is (placeOf); `floorName` names a floor.
 */
export function trackStep(
  prev: TrackState,
  asset: Asset | undefined,
  now: number,
  place: (a: Asset) => Place,
  floorName: (id: string) => string,
  name: string,
): TrackUpdate {
  if (!asset) {
    const missingSince = prev.missingSince ?? now;
    if (now - missingSince >= GONE_AFTER_S) {
      return {
        next: { ...prev, missingSince },
        stop: true,
        notice: `${name} is no longer reported by your sources: discharged or left the site. Tracking stopped; their history stays open.`,
      };
    }
    return { next: prev.missingSince === missingSince ? prev : { ...prev, missingSince } };
  }
  if (hasLeftSite(asset)) {
    return { next: prev, stop: true, notice: `${name} was discharged or left the site. Tracking stopped; their history stays open.` };
  }
  const p = place(asset);
  const floorId = p.floorId ?? prev.floorId;
  if (floorId === prev.floorId && p.where === prev.where && p.onPlan === prev.onPlan && prev.missingSince === null) return { next: prev };
  const next: TrackState = { ...prev, floorId, where: p.where, onPlan: p.onPlan, missingSince: null };
  if (floorId !== null && floorId !== prev.floorId) {
    const f = floorName(floorId);
    return { next, switchTo: floorId, notice: p.onPlan ? `${name} moved to ${f}, following` : `${name} is ${p.where}. Showing ${f}.` };
  }
  if (!p.onPlan && (prev.onPlan || p.where !== prev.where)) return { next, notice: `${name} is ${p.where}, not on the floor plan. Still tracking.` };
  if (p.onPlan && !prev.onPlan) return { next, notice: `${name} arrived ${p.where}, following` };
  return { next };
}

export type TrailPoint = { x: number; y: number; t: number };

/** Add a sampled figure position to a trail, dropping old and too-close points. Returns the same array when nothing changed. */
export function pushTrail(trail: readonly TrailPoint[], p: TrailPoint, keepS = TRAIL_S): TrailPoint[] {
  const last = trail[trail.length - 1];
  const fresh = trail.length && trail[0].t < p.t - keepS ? trail.filter((q) => q.t >= p.t - keepS) : trail;
  if (last && Math.hypot(last.x - p.x, last.y - p.y) < TRAIL_MIN_STEP) return fresh === trail ? (trail as TrailPoint[]) : [...fresh];
  const out = [...fresh, p];
  return out.length > TRAIL_MAX_POINTS ? out.slice(out.length - TRAIL_MAX_POINTS) : out;
}
