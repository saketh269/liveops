// Live tracking: follow one record, switch floors when it changes floor, and
// notice when it leaves the site. Pure, so the rules are testable.
import type { Asset } from "../../api/types";

/** A record missing this long (seconds) has left; shorter gaps are a source re-listing it. */
export const GONE_AFTER_S = 30;
/** Trail kept behind a tracked figure (seconds). */
export const TRAIL_S = 5 * 60;
export const TRAIL_MAX_POINTS = 600;
/** Trail points closer than this (metres) are merged. */
export const TRAIL_MIN_STEP = 0.3;

export type TrackState = {
  id: string;
  /** Floor the record was last seen on. */
  floorId: string | null;
  /** When it went missing (epoch s), null while present. */
  missingSince: number | null;
  gone: boolean;
};

export type TrackUpdate = {
  next: TrackState;
  /** Floor the map should switch to. */
  switchTo?: string;
  notice?: string;
};

export function startTracking(id: string, floorId: string | null): TrackState {
  return { id, floorId, missingSince: null, gone: false };
}

/**
 * One step of the tracker for the record's current data (undefined = not on the map now).
 * `floorOf` names the floor a record is on; `floorName` its display name.
 */
export function trackStep(
  prev: TrackState,
  asset: Asset | undefined,
  now: number,
  floorOf: (a: Asset) => string,
  floorName: (id: string) => string,
  name: string,
): TrackUpdate {
  if (!asset) {
    const missingSince = prev.missingSince ?? now;
    if (!prev.gone && now - missingSince >= GONE_AFTER_S) {
      return {
        next: { ...prev, missingSince, gone: true },
        notice: `${name} is no longer reported by your sources: discharged or left the site. Their history stays open.`,
      };
    }
    return { next: prev.missingSince === missingSince ? prev : { ...prev, missingSince } };
  }
  const floorId = floorOf(asset);
  const next: TrackState = { ...prev, floorId, missingSince: null, gone: false };
  if (prev.floorId !== null && floorId !== prev.floorId) {
    return { next, switchTo: floorId, notice: `${name} moved to ${floorName(floorId)}, following` };
  }
  if (prev.gone) return { next, notice: `${name} is back on the map, following again` };
  if (prev.missingSince === null && prev.floorId === floorId) return { next: prev };
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
