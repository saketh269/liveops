// Pure state for the live map: applies StreamMessages (design.md §4) to the
// current set of assets and keeps a capped, newest-first event feed.
import type { Asset, StreamMessage } from "../api/types";

export const FEED_CAP = 200;

export type FeedEntry = {
  id: number;
  ts: number;
  kind: "added" | "change" | "removed" | "event";
  text: string;
  /** Source id that produced the change, when known. */
  source: string | null;
  assetId: string | null;
  // --- polish fix ---
  /** Field changes (field → [old, new]) when known, for plain-language lines (map/labels.ts eventText). */
  changes?: Record<string, [unknown, unknown]>;
  /** The whole record left the map. */
  removed?: boolean;
  // --- end polish fix ---
};

export type MapState = {
  assets: ReadonlyMap<string, Asset>;
  feed: FeedEntry[];
  /** True once the server sent at least one `event` message; then upserts are no longer turned into feed entries. */
  serverEvents: boolean;
  snapshotReceived: boolean;
  /** Server timestamp (seconds) of the latest message. */
  lastTs: number | null;
  seq: number;
};

export function initialMapState(): MapState {
  return { assets: new Map(), feed: [], serverEvents: false, snapshotReceived: false, lastTs: null, seq: 0 };
}

const META = new Set(["site_id", "asset_id", "updated_ts", "_sources", "attributes", "_attached"]); // --- state: _attached (LIVEOPS-116) ---

export function assetName(a: Pick<Asset, "asset_id" | "label">): string {
  return typeof a.label === "string" && a.label ? a.label : a.asset_id;
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

type Change = { field: string; from: unknown; to: unknown; source: string | null };

/** Field-level differences between two versions of an asset (attributes are compared per key). */
export function diffAsset(prev: Asset, next: Asset): Change[] {
  const out: Change[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const src = next._sources ?? {};
  for (const k of [...keys].sort()) {
    if (META.has(k)) continue;
    if (!same(prev[k], next[k])) out.push({ field: k, from: prev[k], to: next[k], source: src[k] ?? prev._sources?.[k] ?? null });
  }
  const pa = prev.attributes ?? {};
  const na = next.attributes ?? {};
  for (const k of [...new Set([...Object.keys(pa), ...Object.keys(na)])].sort()) {
    if (!same(pa[k], na[k])) {
      out.push({ field: `attributes.${k}`, from: pa[k], to: na[k], source: src.attributes ?? src[k] ?? null });
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Apply a batch of messages. Copies the asset map at most once per batch. */
export function reduceAll(state: MapState, msgs: readonly StreamMessage[]): MapState {
  if (msgs.length === 0) return state;
  let assets: Map<string, Asset> | null = null;
  const draft = () => (assets ??= new Map(state.assets));
  const added: FeedEntry[] = [];
  let { serverEvents, snapshotReceived, lastTs, seq } = state;
  const push = (e: Omit<FeedEntry, "id">) => added.push({ ...e, id: ++seq });
  let dropFromFeed: ((f: FeedEntry) => boolean) | null = null;

  for (const msg of msgs) {
    // Keepalives say the link is up, not that data changed: they must not move "Last update" (LIVEOPS-38).
    if (msg.type !== "snapshot" && msg.type !== "upsert" && msg.type !== "remove" && msg.type !== "event") continue;
    const ts = typeof msg.ts === "number" ? msg.ts : (lastTs ?? 0);
    lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
    switch (msg.type) {
      case "snapshot": {
        const m = draft();
        m.clear();
        for (const a of msg.assets ?? []) if (a && a.asset_id) m.set(a.asset_id, a);
        snapshotReceived = true;
        break;
      }
      case "upsert": {
        const m = draft();
        for (const a of msg.assets ?? []) {
          if (!a || !a.asset_id) continue;
          const prev = m.get(a.asset_id);
          m.set(a.asset_id, a);
          if (serverEvents) continue;
          if (!prev) {
            push({ ts, kind: "added", text: `${assetName(a)} added${a.state ? ` (${fmt(a.state)})` : ""}`,
              source: Object.values(a._sources ?? {})[0] ?? null, assetId: a.asset_id });
          } else {
            for (const c of diffAsset(prev, a)) {
              push({ ts, kind: "change", text: `${assetName(a)}: ${c.field} ${fmt(c.from)} → ${fmt(c.to)}`,
                source: c.source, assetId: a.asset_id, changes: { [c.field]: [c.from, c.to] } }); // --- polish fix: changes ---
            }
          }
        }
        break;
      }
      case "remove": {
        const m = draft();
        for (const a of msg.assets ?? []) {
          if (!a || !a.asset_id) continue;
          const prev = m.get(a.asset_id);
          if (!m.delete(a.asset_id)) continue;
          if (!serverEvents) {
            push({ ts, kind: "removed", text: `${assetName(prev ?? a)} removed`, source: null, assetId: a.asset_id, removed: true }); // --- polish fix: removed ---
          }
        }
        break;
      }
      case "event": {
        const e = msg.event;
        if (!e) break;
        if (!serverEvents) {
          // The first server event can follow an upsert we already turned into a
          // feed entry; drop that derived duplicate.
          const evTs = typeof e.ts === "number" ? e.ts : ts;
          const dup = (f: { kind: string; assetId: string | null; ts: number }) =>
            f.kind !== "event" && f.assetId === str(e.asset_id) && Math.abs(f.ts - evTs) <= 3;
          for (let i = added.length - 1; i >= 0; i--) if (dup(added[i])) added.splice(i, 1);
          dropFromFeed = dup;
        }
        serverEvents = true;
        const text = str(e.message) ?? str(e.text) ?? str(e.summary) ?? JSON.stringify(e);
        push({ ts: typeof e.ts === "number" ? e.ts : ts, kind: "event", text,
          source: str(e.source) ?? str(e.source_id), assetId: str(e.asset_id),
          // --- polish fix ---
          ...(e.changes && typeof e.changes === "object" ? { changes: e.changes as Record<string, [unknown, unknown]> } : {}),
          ...(e.removed === true ? { removed: true } : {}) });
          // --- end polish fix ---
        break;
      }
      default:
        break; // unknown message types are ignored so newer servers don't break older clients
    }
  }

  let feed = dropFromFeed ? state.feed.filter((f) => !dropFromFeed!(f)) : state.feed;
  if (added.length) {
    added.reverse();
    feed = (added.length >= FEED_CAP ? added.slice(0, FEED_CAP) : [...added, ...feed.slice(0, FEED_CAP - added.length)]);
  }
  return { assets: assets ?? state.assets, feed, serverEvents, snapshotReceived, lastTs, seq };
}

export function reduce(state: MapState, msg: StreamMessage): MapState {
  return reduceAll(state, [msg]);
}
