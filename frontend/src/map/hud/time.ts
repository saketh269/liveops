// Time helpers for the HUD. "How long" is shown only when a record carries a
// real "since" timestamp; nothing is estimated from update times (ADR 0007).
import type { Asset } from "../../api/types";

/** Attribute names that mean "the current state started at". Checked in order. */
export const SINCE_FIELDS = ["status_since", "state_since", "status_changed_at", "state_changed_at", "waiting_since", "since"] as const;

/** Epoch seconds from an ISO string, epoch seconds or epoch milliseconds. Null when unparsable. */
export function parseTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e12 ? v / 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseTs(Number(t));
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return null;
}

/** When the asset's current state started (epoch seconds), from its own data, or null. */
export function sinceOf(a: Asset): number | null {
  const attrs = a.attributes ?? {};
  for (const f of SINCE_FIELDS) {
    const t = parseTs(attrs[f] ?? a[f]);
    if (t !== null) return t;
  }
  return null;
}

/** Seconds the asset has been in its current state, or null when the data has no timestamp. */
export function ageOf(a: Asset, now: number): number | null {
  const t = sinceOf(a);
  return t === null ? null : Math.max(0, now - t);
}

/** 42 s → "<1m", 2520 → "42m", 11100 → "3h 05m", 200000 → "2d 7h". */
export function fmtDur(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Spoken form of fmtDur for screen readers. */
export function sayDur(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ${m % 60} minutes`;
}

export const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
