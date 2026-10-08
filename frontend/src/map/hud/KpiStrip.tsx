import { useEffect, useRef, useState } from "react";
import type { KpiTile } from "./kpis";
import type { Focus } from "./model";

type Props = {
  tiles: KpiTile[];
  onFocus: (f: Focus | null) => void;
};

/**
 * Top strip of KPI tiles. Numbers update with the data; screen readers hear only
 * when a tile turns into (or out of) a warning, never every tick.
 */
export default function KpiStrip({ tiles, onFocus }: Props) {
  const said = useCalmAnnouncement(tiles);
  return (
    <div className="lm-hud-kpis" role="group" aria-label="Key figures">
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`lm-glass lm-hud-kpi ${t.tone ? `lm-hud-kpi--${t.tone}` : ""}`}
          data-kpi={t.id}
          onClick={() => onFocus(t.focus)}
          aria-label={`${t.label}: ${t.spoken}. ${t.focus ? "Show the worst one on the map" : "Show the whole floor"}`}
        >
          <span className="lm-hud-kpi-lbl">{t.label}</span>
          <span className="lm-hud-kpi-val">
            <span className="mono" data-value>{t.value}</span>
            {t.total !== undefined && <small className="mono">/ {t.total}</small>}
          </span>
          <span className="lm-hud-kpi-sub">{t.sub}</span>
        </button>
      ))}
      <div className="lm-sr" aria-live="polite">{said}</div>
    </div>
  );
}

/** A sentence naming tiles whose tone changed since the last render; empty otherwise. */
function useCalmAnnouncement(tiles: KpiTile[]): string {
  const prev = useRef<Map<string, string> | null>(null);
  const [said, setSaid] = useState("");
  const key = tiles.map((t) => `${t.id}:${t.tone}`).join("|");
  useEffect(() => {
    const now = new Map(tiles.map((t) => [t.id, t.tone]));
    const before = prev.current;
    prev.current = now;
    if (!before) return; // first data: nothing "changed"
    const changed = tiles.filter((t) => before.has(t.id) && before.get(t.id) !== t.tone);
    if (changed.length) setSaid(changed.map((t) => `${t.label}: ${t.spoken}.`).join(" "));
    // Only tone changes are announced; values alone change too often to read out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return said;
}
