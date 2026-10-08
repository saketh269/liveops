// Shared, pure helpers for the HUD cards: what an asset is, where it is, and
// which feed entries are worth a line in a small card.
import type { Asset, SiteLayout, Zone } from "../../api/types";
import { humanize } from "../../components/format";
import { figureOf, type FigureModel } from "../figures";
import { resolveZone } from "../placement";
import type { FeedEntry } from "../reducer";
import { assetName } from "../reducer";
import { STATE_LABELS, stateKey } from "../stateColors";
import { ageOf } from "./time";

/** A thing the map can be asked to show: an asset, or a zone (resolved to an asset in it). */
export type Focus = { assetId: string } | { zoneId: string };

/** Minutes a room may stay in a cleaning state before it gets a pin (Phase 2 makes this a rule). */
export const CLEANING_PIN_MINUTES = 30;

export const modelOf = (a: Asset): FigureModel => figureOf(a);
export const isBed = (a: Asset) => modelOf(a) === "bed";
export const isPatient = (a: Asset) => modelOf(a) === "patient";
export const isAmbulance = (a: Asset) => modelOf(a) === "ambulance";
export const isStaff = (a: Asset) => ["person", "nurse", "doctor", "cleaner"].includes(modelOf(a));

export function zoneOf(layout: SiteLayout, a: Asset): Zone | undefined {
  return resolveZone(layout.zones ?? [], a.zone);
}

/** The value the source sent for the state (e.g. "boarding"), falling back to the mapped state. */
export function rawStatus(a: Asset): string {
  const raw = a.attributes?.status;
  if (typeof raw === "string" && raw) return humanize(raw).toLowerCase();
  return typeof a.state === "string" && a.state ? humanize(a.state).toLowerCase() : STATE_LABELS[stateKey(a.state)].toLowerCase();
}

/** Admitted but still held where they are, waiting for a bed upstairs: the source's own status says "boarding". */
export function isBoarding(a: Asset): boolean {
  return /\bboard(ing|er)\b/.test(rawStatus(a));
}

/** Problem = alert state or a boarding-like status, or cleaning for longer than the pin threshold (only when the data says since when). */
export function problemTone(a: Asset, now: number): "bad" | "warn" | null {
  const k = stateKey(a.state);
  if (k === "alert" || isBoarding(a)) return "bad";
  if (k === "cleaning") {
    const age = ageOf(a, now);
    if (age !== null && age > CLEANING_PIN_MINUTES * 60) return "warn";
  }
  return null;
}

/** Sort key: oldest first (records with a timestamp before those without), then by name. */
export function byAgeDesc(now: number) {
  return (a: Asset, b: Asset) => {
    const x = ageOf(a, now);
    const y = ageOf(b, now);
    if (x !== null && y !== null && x !== y) return y - x;
    if (x !== null && y === null) return -1;
    if (x === null && y !== null) return 1;
    return assetName(a).localeCompare(assetName(b), undefined, { numeric: true });
  };
}

/** Fields whose change is worth a line in a small card. */
const KEY_FIELDS = new Set(["state", "zone", "status", "anchor", "floor", "attributes.status"]);

/** "status a → b, latitude 1 → 2" → ["status a → b", "latitude 1 → 2"] (the server's describe() format). */
function changeParts(text: string): string[] {
  return text.split(/, (?=[\w.]+ .*? → )/);
}

/**
 * The part of a feed line worth showing in a small card: additions, removals and
 * changes of state, zone, status or anchor. Null for churn such as GPS or badge pings
 * (those stay in the record's fields).
 */
export function headline(e: FeedEntry): { name: string | null; what: string } | null {
  if (e.kind === "added" || e.kind === "removed") return { name: null, what: e.text };
  let name: string | null = null;
  let body = e.text;
  if (e.kind === "change") {
    const i = e.text.indexOf(": ");
    if (i <= 0) return null;
    name = e.text.slice(0, i);
    body = e.text.slice(i + 2);
  } else if (e.assetId && e.text.startsWith(`${e.assetId} `)) {
    name = e.assetId;
    body = e.text.slice(e.assetId.length + 1);
    if (!body.includes(" → ")) return { name, what: body }; // "removed", "no longer in this source"
  } else {
    return { name: null, what: e.text };
  }
  const keep = changeParts(body).filter((p) => {
    const m = /^([\w.]+) (.*) → (.*)$/.exec(p);
    return m !== null && KEY_FIELDS.has(m[1]) && m[2] !== m[3]; // "anchor — → —" says nothing
  });
  return keep.length ? { name, what: keep.join(", ") } : null;
}

export const isHeadline = (e: FeedEntry) => headline(e) !== null;

/**
 * Short chip labels for a set of names: drops a prefix every name shares up to a
 * separator ("ED-01", "ED-02" → "01", "02"). Names stay whole when that would make two equal.
 */
export function shortLabels(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const cut = (s: string) => {
    const m = /^(.*[-_ ./])/.exec(s);
    return m ? m[1] : "";
  };
  const prefix = cut(names[0]);
  if (!prefix || !names.every((n) => n.startsWith(prefix) && n.length > prefix.length)) return [...names];
  const out = names.map((n) => n.slice(prefix.length));
  return new Set(out).size === out.length ? out : [...names];
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
