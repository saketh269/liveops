import { useId } from "react";
import type { AssetHistory, HistoryEntry } from "../../api/types";
import { clock } from "../hud/time";
import type { HistoryState } from "./useAssetHistory";

export type HistoryFilter = "all" | "moves" | "status";
const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "moves", label: "Moves" },
  { key: "status", label: "Status" },
];

export function matchesFilter(e: HistoryEntry, f: HistoryFilter): boolean {
  if (f === "moves") return e.kind === "arrived" || e.kind === "move" || e.kind === "left";
  if (f === "status") return e.kind === "status" || e.kind === "task" || (e.kind === "move" && e.text.includes("· now"));
  return true;
}

/** "Oct 7, 19:05" */
export function dayClock(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "History since Oct 7, 19:05": Live Ops only knows what happened while it watched. */
export function sinceText(h: AssetHistory | null): string {
  if (!h || h.history_since === null) return "History starts when Live Ops sees the first change.";
  return `History since ${dayClock(h.history_since)}`;
}

const sameDay = (a: number, b: number) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();

type Props = {
  history: HistoryState;
  filter: HistoryFilter;
  onFilter: (f: HistoryFilter) => void;
  showRoute: boolean;
  onShowRoute: (on: boolean) => void;
  /** Name of the floor the route is drawn on. */
  floorName: string;
  /** False in the 2D view: the route is only drawn over the 3D map. */
  canRoute: boolean;
  now: number;
};

/** The selected record's history: a timeline with filters, and the route on the map. */
export default function HistoryPanel({ history, filter, onFilter, showRoute, onShowRoute, floorName, canRoute, now }: Props) {
  const h = history.data;
  const filterId = useId();
  const list = h ? h.entries.filter((e) => matchesFilter(e, filter)).reverse() : [];
  return (
    <div className="lm-track-history">
      <div className="lm-track-history-head">
        <p className="lm-track-since">
          <b>{sinceText(h)}</b>
          <span>Live Ops knows what happened while it was watching your sources{h ? `, and keeps ${h.retention_days} days` : ""}.</span>
        </p>
        <div className="lm-track-tools">
          <div className="lm-track-seg" role="group" aria-labelledby={filterId}>
            <span id={filterId} className="lm-sr">Show</span>
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)}>{f.label}</button>
            ))}
          </div>
          {canRoute && (
            <button type="button" className="btn" aria-pressed={showRoute} onClick={() => onShowRoute(!showRoute)}
              title={`Draw the places visited on ${floorName}, oldest faint, newest strong`}>
              {showRoute ? "Hide route" : "Show route"}
            </button>
          )}
        </div>
      </div>
      {h && h.milestones.length > 0 && (
        <div>
          <h3 className="lm-hud-sec">Times from the source</h3>
          <ul className="lm-track-milestones">
            {h.milestones.slice(-6).map((m) => (
              <li key={`${m.key}${m.ts}`}><span>{m.label}</span> <time className="mono">{sameDay(m.ts, now) ? clock(m.ts) : dayClock(m.ts)}</time></li>
            ))}
          </ul>
        </div>
      )}
      {history.loading && !h && <p className="lm-hud-empty">Loading history…</p>}
      {history.error && <p className="lm-hud-empty" role="status">{history.error}</p>}
      {h && list.length === 0 && (
        <p className="lm-hud-empty">
          {h.entries.length === 0
            ? "No changes recorded yet. They appear here as your sources report them."
            : "Nothing of this kind yet. Try All."}
        </p>
      )}
      {list.length > 0 && (
        <ol className="lm-track-timeline" aria-label="History, newest first">
          {list.map((e) => (
            <li key={`${e.ts}-${e.kind}`} className={`lm-track-step lm-track-step--${e.kind}${e.ongoing ? " lm-track-step--now" : ""}`}>
              <time className="mono" dateTime={new Date(e.ts * 1000).toISOString()}>{sameDay(e.ts, now) ? clock(e.ts) : dayClock(e.ts)}</time>
              <div>
                <p>{e.text}</p>
                <p className="lm-track-step-meta">
                  {[e.kind === "task" ? null : e.zone, e.floor, e.kind === "task" ? e.source : null].filter(Boolean).join(" · ")}
                  {e.duration_text && <span className="lm-track-dur">{e.duration_text}</span>}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {h?.truncated && <p className="lm-hud-empty">Showing the latest {h.entries.length} changes.</p>}
    </div>
  );
}
