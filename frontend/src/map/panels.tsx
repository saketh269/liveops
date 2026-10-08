import type { Asset } from "../api/types";
import { STATE_EXAMPLES, STATE_KEYS, STATE_LABELS, stateKey, type StateKey } from "./stateColors";

export function Swatch({ k }: { k: StateKey }) {
  return <span className={`lm-swatch lm-s-${k}`} aria-hidden="true" />;
}

type Counts = Record<StateKey, number>;
const zero = (): Counts => ({ free: 0, "in-use": 0, cleaning: 0, alert: 0, unknown: 0 });

/** Compact legend popover with live counts per state (closed by default; content stays in the page). */
export function Legend({ assets }: { assets: ReadonlyMap<string, Asset> }) {
  const byState = zero();
  for (const a of assets.values()) byState[stateKey(a.state)]++;
  return (
    <details className="lm-hud-legend">
      <summary className="btn">Legend</summary>
      <div className="lm-glass lm-hud-legend-pop">
        <ul className="lm-legend">
          {STATE_KEYS.map((k) => (
            <li key={k}>
              <Swatch k={k} />
              <span><strong>{STATE_LABELS[k]}</strong> <span className="muted">{STATE_EXAMPLES[k].join(", ")}</span></span>
              <span className="lm-kpi-value mono" data-state={k}>{byState[k]}</span>
            </li>
          ))}
        </ul>
        <p className="muted lm-small">Shapes show the kind and role (bed, patient, nurse, doctor, cleaner, other staff, ambulance, equipment). A short pulse marks a state change. A figure walks only when its record's zone or position changes, or when it is added or removed. Pins mark alerts, patients boarding, and rooms cleaning for over 30 minutes.</p>
      </div>
    </details>
  );
}
