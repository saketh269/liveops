// Builds zones from the data itself, so a new site works without drawing a floor plan first.
import type { Asset, SiteLayout, Zone } from "../api/types";
import { rectToPolygon } from "./geometry";
import { compareIds, explicitPosition, floorSize, resolveZone } from "./placement";
import { stateKey } from "./stateColors";

export type ZoneCoverage = {
  /** Zone values seen on assets that match no zone in the layout, with asset counts. */
  missing: Map<string, number>;
  /** Assets with no zone value at all (and no x/y). */
  noZone: number;
  /** Ids of layout zones that hold at least one asset. */
  used: Set<string>;
};

export function zoneCoverage(layout: SiteLayout | null | undefined, assets: Iterable<Asset>): ZoneCoverage {
  const zones = layout?.zones ?? [];
  const missing = new Map<string, number>();
  const used = new Set<string>();
  let noZone = 0;
  for (const a of assets) {
    const z = resolveZone(zones, a.zone);
    if (z) { used.add(z.id); continue; }
    if (explicitPosition(a)) continue;
    const v = a.zone === undefined || a.zone === null ? "" : String(a.zone).trim();
    if (!v) noZone++;
    else missing.set(v, (missing.get(v) ?? 0) + 1);
  }
  return { missing, noZone, used };
}

export type StateCoverage = { total: number; colored: number; noState: number; unrecognised: Map<string, number> };

/** How many assets get a real color; lists raw state values that fall back to grey. */
export function stateCoverage(assets: Iterable<Asset>): StateCoverage {
  const unrecognised = new Map<string, number>();
  let total = 0, colored = 0, noState = 0;
  for (const a of assets) {
    total++;
    if (a.state === undefined || a.state === null || a.state === "") { noState++; continue; }
    if (stateKey(a.state) !== "unknown") { colored++; continue; }
    const v = String(a.state);
    unrecognised.set(v, (unrecognised.get(v) ?? 0) + 1);
  }
  return { total, colored, noState, unrecognised };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "zone";
}

/**
 * New layout with one zone per zone value in the data. Zones that already hold
 * assets keep their id, name and color; empty placeholder zones are dropped.
 * Zones are laid out as an even grid on the current floor.
 */
export function buildAutoLayout(layout: SiteLayout | null | undefined, cov: ZoneCoverage): SiteLayout {
  const { width, depth } = floorSize(layout);
  const kept = (layout?.zones ?? []).filter((z) => cov.used.has(z.id));
  const names = [...cov.missing.keys()].sort(compareIds);
  const ids = new Set(kept.map((z) => z.id));
  const fresh: Zone[] = names.map((name) => {
    let id = `zone-${slug(name)}`;
    for (let i = 2; ids.has(id); i++) id = `zone-${slug(name)}-${i}`;
    ids.add(id);
    return { id, name, polygon: [] };
  });
  const all = [...kept, ...fresh];
  const n = all.length;
  if (!n) return { ...(layout ?? {}), width, depth, zones: [] };

  // Choose columns so cells come out close to square on this floor.
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * width) / depth)) || 1));
  const rows = Math.ceil(n / cols);
  const gap = Math.max(1, Math.min(width, depth) * 0.03);
  const cw = (width - gap * (cols + 1)) / cols;
  const ch = (depth - gap * (rows + 1)) / rows;
  const r1 = (v: number) => Math.round(v * 10) / 10;

  const zones = all.map((z, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const polygon = rectToPolygon({ x: r1(gap + c * (cw + gap)), y: r1(gap + r * (ch + gap)), w: r1(cw), h: r1(ch) });
    return { ...z, polygon };
  });
  return { ...(layout ?? {}), width, depth, zones };
}

/**
 * Keep every existing zone where it is and add one zone per missing value in a
 * new band below the current floor (the floor grows to fit). Used when the
 * layout is already in use, so hand-drawn zones are never moved.
 */
export function appendMissingZones(layout: SiteLayout | null | undefined, cov: ZoneCoverage): SiteLayout {
  const { width, depth } = floorSize(layout);
  const existing = layout?.zones ?? [];
  const names = [...cov.missing.keys()].sort(compareIds);
  if (!names.length) return { ...(layout ?? {}), width, depth, zones: existing };
  const ids = new Set(existing.map((z) => z.id));
  const gap = Math.max(1, width * 0.02);
  const cols = Math.min(names.length, Math.max(1, Math.floor(width / 18)));
  const rows = Math.ceil(names.length / cols);
  const cw = (width - gap * (cols + 1)) / cols;
  const ch = Math.max(8, Math.min(20, cw * 0.6));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const added: Zone[] = names.map((name, i) => {
    let id = `zone-${slug(name)}`;
    for (let k = 2; ids.has(id); k++) id = `zone-${slug(name)}-${k}`;
    ids.add(id);
    const c = i % cols;
    const r = Math.floor(i / cols);
    return { id, name, polygon: rectToPolygon({ x: r1(gap + c * (cw + gap)), y: r1(depth + gap + r * (ch + gap)), w: r1(cw), h: r1(ch) }) };
  });
  return { ...(layout ?? {}), width, depth: r1(depth + gap + rows * (ch + gap)), zones: [...existing, ...added] };
}
