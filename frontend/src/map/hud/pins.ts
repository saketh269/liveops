// Which problem pins float over the 3D scene. Pure: the component projects them.
import type { Asset, SiteLayout } from "../../api/types";
import { assetName } from "../reducer";
import { byAgeDesc, plural, problemTone, rawStatus, zoneOf } from "./model";
import { ageOf, fmtDur } from "./time";

export type Pin = {
  key: string;
  /** The figure the pin stands on, and what a click selects. */
  assetId: string;
  tone: "bad" | "warn";
  /** Problems this pin stands for (alerts sharing one zone get one pin). */
  count: number;
  text: string;
};

/** More pins than this turn the map into confetti; the worst ones win. */
export const MAX_PINS = 12;

/**
 * Pins for the assets shown: alerts (grouped per zone, so a busy waiting room is one
 * pin) and rooms cleaning for longer than the threshold. Worst first, at most MAX_PINS.
 */
export function problemPins(layout: SiteLayout, assets: Iterable<Asset>, now: number, max = MAX_PINS): Pin[] {
  const alerts = new Map<string, { zone: string | null; list: Asset[] }>();
  const out: (Pin & { age: number | null })[] = [];
  for (const a of assets) {
    const tone = problemTone(a, now);
    if (tone === "warn") {
      const age = ageOf(a, now);
      out.push({ key: a.asset_id, assetId: a.asset_id, tone, count: 1, age, text: `${assetName(a)} ${rawStatus(a)}${age !== null ? ` ${fmtDur(age)}` : ""}` });
    } else if (tone === "bad") {
      const z = zoneOf(layout, a);
      const key = z ? `zone:${z.id}` : a.asset_id;
      const g = alerts.get(key) ?? { zone: z ? z.name || z.id : null, list: [] };
      g.list.push(a);
      alerts.set(key, g);
    }
  }
  for (const [key, g] of alerts) {
    const list = g.list.sort(byAgeDesc(now));
    const first = list[0];
    const age = ageOf(first, now);
    const text = list.length === 1
      ? `${assetName(first)} ${rawStatus(first)}${age !== null ? ` ${fmtDur(age)}` : ""}`
      : `${g.zone ?? "Unassigned"} · ${plural(list.length, "alert")}`;
    out.push({ key, assetId: first.asset_id, tone: "bad", count: list.length, age, text });
  }
  out.sort((a, b) =>
    (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1)
    || b.count - a.count
    || (b.age ?? -1) - (a.age ?? -1)
    || a.key.localeCompare(b.key, undefined, { numeric: true }));
  return out.slice(0, max).map((p) => ({ key: p.key, assetId: p.assetId, tone: p.tone, count: p.count, text: p.text }));
}

/** Number of problem records per floor id (for the floor rail's dot). */
export function problemsByFloor(assets: Iterable<Asset>, floorOf: (a: Asset) => string, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of assets) {
    if (!problemTone(a, now)) continue;
    const f = floorOf(a);
    out.set(f, (out.get(f) ?? 0) + 1);
  }
  return out;
}
