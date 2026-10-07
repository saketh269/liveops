import type { Floor } from "../api/types";

type Props = {
  floors: readonly Floor[];
  current: string;
  /** Assets per floor id, shown next to each name. */
  counts?: ReadonlyMap<string, number> | null;
  onChange: (floorId: string) => void;
};

/** Pick which floor the map shows. Floors are listed top floor first, like a building directory. */
export default function FloorSwitcher({ floors, current, counts, onChange }: Props) {
  return (
    <div className="lm-floors" role="group" aria-label="Floor">
      <span className="muted lm-small">Floor</span>
      {[...floors].reverse().map((f) => {
        const n = counts?.get(f.id);
        return (
          <button
            key={f.id}
            type="button"
            className={`btn lm-floor-btn ${f.id === current ? "lm-floor-btn--active" : ""}`}
            aria-pressed={f.id === current}
            onClick={() => onChange(f.id)}
          >
            {f.name}
            {n !== undefined && (
              <span className="mono lm-floor-count">
                {n}<span className="lm-sr"> asset{n === 1 ? "" : "s"}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
