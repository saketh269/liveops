// Top-down SVG glyphs for the 2D map, matching the 3D figures. Drawn in a unit
// footprint centred on 0 and facing +x; the state color fills the shape (the
// parent sets `lm-s-*`), accents use the panel token so they read in light and dark.
import type { FigureModel } from "./figures";

const A = "lm-fig-accent";

export function FigureGlyph({ model }: { model: FigureModel }) {
  switch (model) {
    case "bed":
      return (
        <>
          <rect x={-0.5} y={-0.3} width={1} height={0.6} rx={0.08} />
          <rect className={A} x={-0.42} y={-0.2} width={0.2} height={0.4} rx={0.05} />
        </>
      );
    case "person":
      return <circle r={0.32} />;
    case "nurse":
      return (
        <>
          <circle r={0.34} />
          <path className={A} d="M-0.05 -0.2h0.1v0.15h0.15v0.1h-0.15v0.15h-0.1v-0.15h-0.15v-0.1h0.15z" />
        </>
      );
    case "doctor":
      return (
        <>
          <circle r={0.36} />
          <circle className={A} r={0.16} fill="none" strokeWidth={0.07} style={{ stroke: "var(--panel)" }} />
        </>
      );
    case "cleaner":
      return (
        <>
          <circle cx={-0.12} r={0.3} />
          <rect x={0.14} y={-0.2} width={0.34} height={0.4} rx={0.05} />
          <rect className={A} x={0.22} y={-0.1} width={0.18} height={0.2} />
        </>
      );
    case "patient":
      return (
        <>
          <circle r={0.34} />
          <circle className={A} r={0.11} />
          <circle cy={-0.42} r={0.08} />
        </>
      );
    case "ambulance":
    case "vehicle":
      return (
        <>
          <rect x={-0.5} y={-0.27} width={1} height={0.54} rx={0.06} />
          <rect className={A} x={0.3} y={-0.2} width={0.1} height={0.4} />
          {model === "ambulance" && <path className={A} d="M-0.18 -0.04h0.1v-0.1h0.08v0.1h0.1v0.08h-0.1v0.1h-0.08v-0.1h-0.1z" />}
        </>
      );
    case "equipment":
      return (
        <>
          <rect x={-0.28} y={-0.28} width={0.56} height={0.56} rx={0.06} />
          <rect className={A} x={-0.16} y={-0.12} width={0.32} height={0.2} />
        </>
      );
    default:
      return <rect x={-0.5} y={-0.5} width={1} height={1} rx={0.2} />;
  }
}
