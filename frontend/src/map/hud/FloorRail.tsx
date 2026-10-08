import type { Floor } from "../../api/types";
import { floorNumber } from "../floors";
import { plural } from "./model";

type Props = {
  floors: readonly Floor[];
  current: string;
  /** Assets per floor id. */
  counts: ReadonlyMap<string, number>;
  /** Problem records (alerts, overdue cleaning) per floor id. */
  problems: ReadonlyMap<string, number>;
  onChange: (floorId: string) => void;
};

/** "Floor 2" → "2", "Basement B1" → "B1", "Ground" → "G", "Mezzanine" → "Mez". */
export function floorShort(f: Pick<Floor, "id" | "name">): string {
  if (/^ground\b/i.test(f.name.trim())) return "G";
  for (const t of [f.id, f.name, f.name.split(/\s+/).pop() ?? ""]) {
    const n = floorNumber(t);
    if (n !== null) return n < 0 ? `B${-n}` : String(n);
  }
  return f.name.slice(0, 3);
}

/** Vertical floor rail (horizontal on phones), top floor first like a lift panel. */
export default function FloorRail({ floors, current, counts, problems, onChange }: Props) {
  return (
    <nav className="lm-glass lm-hud-floors" aria-label="Floors">
      {[...floors].reverse().map((f) => {
        const n = counts.get(f.id) ?? 0;
        const p = problems.get(f.id) ?? 0;
        return (
          <button
            key={f.id}
            type="button"
            aria-pressed={f.id === current}
            title={f.name}
            aria-label={`${f.name}: ${plural(n, "asset")}${p ? `, ${plural(p, "problem")}` : ""}`}
            onClick={() => onChange(f.id)}
          >
            <span className="lm-hud-floor-n">{floorShort(f)}</span>
            <span className="lm-hud-floor-c mono">{n}</span>
            {p > 0 && <span className="lm-hud-floor-dot" aria-hidden="true" />}
          </button>
        );
      })}
      <div className="lm-hud-floors-cap" aria-hidden="true">FLOOR</div>
    </nav>
  );
}
