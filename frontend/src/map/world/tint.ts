// Room tint (ADR 0007): a `room` zone's tile takes the state of the `kind: bed` asset in it.
// Pure: shared by the 3D tiles and the 2D fallback.
import type { Asset, Zone } from "../../api/types";
import { resolveZone } from "../placement";
import { stateKey, type StateKey } from "../stateColors";
import type { ScenePalette, TintStyle } from "./style";

/** When a room has more than one bed, the most urgent state wins. */
const URGENCY: Record<StateKey, number> = { alert: 4, cleaning: 3, free: 2, "in-use": 1, unknown: 0 };

export function isBed(a: Asset): boolean {
  return typeof a.kind === "string" && a.kind.trim().toLowerCase() === "bed";
}

export function isRoom(z: Zone): boolean {
  return z.kind === "room";
}

/**
 * State of each room zone, from the beds whose zone is that room. Rooms with no
 * bed are left out (they draw as a neutral tile).
 */
export function roomStates(zones: readonly Zone[], assets: Iterable<Asset>): Map<string, StateKey> {
  const out = new Map<string, StateKey>();
  if (!zones.some(isRoom)) return out;
  for (const a of assets) {
    if (!isBed(a)) continue;
    const z = resolveZone(zones, a.zone);
    if (!z || !isRoom(z)) continue;
    const k = stateKey(a.state);
    const prev = out.get(z.id);
    if (prev === undefined || URGENCY[k] > URGENCY[prev]) out.set(z.id, k);
  }
  return out;
}

/** Tile look for a room: its bed's state, or a neutral tile when it has no bed. */
export function tintFor(state: StateKey | undefined, palette: ScenePalette): TintStyle {
  return palette.tint[state ?? "unknown"];
}

/** Rooms that just became free (a cleaned room is ready again): they get a soft glow. */
export function newlyFree(prev: ReadonlyMap<string, StateKey>, next: ReadonlyMap<string, StateKey>): string[] {
  const out: string[] = [];
  for (const [id, k] of next) if (k === "free" && prev.has(id) && prev.get(id) !== "free") out.push(id);
  return out;
}

/** True when any room changed state. */
export function statesChanged(a: ReadonlyMap<string, StateKey>, b: ReadonlyMap<string, StateKey>): boolean {
  if (a.size !== b.size) return true;
  for (const [id, k] of a) if (b.get(id) !== k) return true;
  return false;
}

export const GLOW_MS = 2400;

/** Glow strength (0..1) `ms` after a room turned free: two soft pulses that fade out. */
export function glowAt(ms: number): number {
  if (ms < 0 || ms >= GLOW_MS) return 0;
  const p = ms / GLOW_MS;
  return Math.abs(Math.sin(p * Math.PI * 2)) * (1 - p);
}
