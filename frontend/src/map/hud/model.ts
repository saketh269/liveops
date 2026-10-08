// Shared, pure helpers for the HUD cards: what an asset is, where it is, and
// which feed entries are worth a line in a small card.
import type { Asset, SiteLayout, Zone } from "../../api/types";
import { figureOf, type FigureModel } from "../figures";
import { resolveZone } from "../placement";
import { eventText, inSentence, ownStatus, whoName, type EventContext } from "../labels";
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

/**
 * The record's own status in words, lower case ("waiting for provider"): the value its
 * own source sent, never an attached source's (map/labels.ts ownStatus).
 */
export function rawStatus(a: Asset): string {
  const s = ownStatus(a);
  return s ? inSentence(s) : STATE_LABELS[stateKey(a.state)].toLowerCase();
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

/** "status a → b, latitude 1 → 2" → [["status","a","b"], …] (the old server describe() format). */
function legacyChanges(text: string): Record<string, [unknown, unknown]> | null {
  const out: Record<string, [unknown, unknown]> = {};
  for (const p of text.split(/, (?=[\w.]+ .*? → )/)) {
    const m = /^([\w.]+) (.*) → (.*)$/.exec(p);
    if (!m) return null;
    const v = (x: string) => (x === "—" || x === "∅" ? null : x);
    const key = m[1] === "status" ? "attributes.status" : m[1];
    out[key] = [v(m[2]), v(m[3])];
  }
  return Object.keys(out).length ? out : null;
}

export type HeadlineContext = EventContext & { assets?: ReadonlyMap<string, Asset> };

/**
 * A feed entry as one plain line for a small card: who, and what happened
 * ("moved from ED Waiting Room to ED-02 · now waiting for provider"). Null for churn
 * such as GPS or badge pings (those stay in the record's fields).
 */
export function headline(e: FeedEntry, ctx: HeadlineContext = {}): { name: string | null; what: string } | null {
  const asset = e.assetId ? ctx.assets?.get(e.assetId) : undefined;
  let changes = e.changes;
  let removed = e.removed ?? e.kind === "removed";
  let name: string | null = asset ? whoName(asset) : e.assetId;
  if (!changes && !removed) {
    // Lines without structured changes: "<id> <field> a → b, …", "<label>: <field> a → b", "<id> removed".
    let body = e.text;
    const i = e.text.indexOf(": ");
    if (e.kind === "added") return { name, what: "was added to the map" };
    if (e.kind === "change" && i > 0) { body = e.text.slice(i + 2); if (!asset) name = e.text.slice(0, i); }
    else if (e.assetId && e.text.startsWith(`${e.assetId} `)) body = e.text.slice(e.assetId.length + 1);
    else return { name: null, what: e.text };
    if (/^(removed|left the map)/.test(body)) removed = true;
    else {
      changes = legacyChanges(body) ?? undefined;
      if (!changes) return { name, what: body };
    }
  }
  if (!asset && changes) {
    const label = changes.label?.[1] ?? changes.label?.[0];
    if (typeof label === "string" && label) name = label;
  }
  const what = eventText({ changes, removed, source: e.source, assetId: e.assetId }, asset, ctx);
  return what ? { name, what } : null;
}

export const isHeadline = (e: FeedEntry, ctx: HeadlineContext = {}) => headline(e, ctx) !== null;

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
