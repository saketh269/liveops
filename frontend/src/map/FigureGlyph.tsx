// Top-down SVG glyphs for the 2D map, matching the 3D models. Drawn in a unit
// footprint centred on 0 and facing +x (a bed's head at -x). Parts painted
// "state" inherit the state fill the parent sets (`lm-s-*`); the rest use the
// models palette for the current theme, so roles read the same as in 3D.
import type { BodyPose, FigureModel } from "./figures";
import { currentModelTheme, getModelPalette, idHash, type ModelPalette } from "./models/palette";
import { stateKey } from "./stateColors";

type Outfit = { top: keyof ModelPalette; coat?: boolean };

const OUTFIT: Partial<Record<FigureModel, Outfit>> = {
  nurse: { top: "scrubs" }, doctor: { top: "coat", coat: true }, cleaner: { top: "evs" }, transporter: { top: "transporter" },
  paramedic: { top: "medic" }, manager: { top: "blazer" }, person: { top: "staff" }, patient: { top: "gown", coat: true },
};

/** Role/material fill; details carry no outline (the parent outlines the state shapes). */
const col = (p: ModelPalette, k: keyof ModelPalette) => ({ fill: p[k] as string, stroke: "none" });

function Person({ model, p, skin, dx = 0 }: { model: FigureModel; p: ModelPalette; skin: string; dx?: number }) {
  const o = OUTFIT[model] ?? OUTFIT.person!;
  return (
    <g transform={dx ? `translate(${dx} 0)` : undefined}>
      <circle className="lm-fig-state" r={0.4} />
      <ellipse rx={o.coat ? 0.22 : 0.19} ry={o.coat ? 0.34 : 0.31} style={col(p, o.top)} />
      {model === "paramedic" && <rect x={-0.03} y={-0.3} width={0.06} height={0.6} style={col(p, "reflective")} />}
      {model === "manager" && <path d="M0.08 -0.07 L0.19 0 L0.08 0.07z" style={col(p, "shirt")} />}
      {model === "doctor" && <path d="M0.1 -0.13 Q0.22 0 0.1 0.13" fill="none" style={{ stroke: p.stethoscope, strokeWidth: 0.035 }} />}
      <circle cx={0.02} r={0.14} style={{ fill: skin, stroke: "none" }} />
      {model === "nurse" && <circle cx={0.02} r={0.09} style={col(p, "nurseCap")} />}
    </g>
  );
}

/** `pose` (optional, from placement) draws a patient lying; `state` tints a dirty bed's sheet; `id` picks the skin tone. */
export function FigureGlyph({ model, pose, id = "", state }: { model: FigureModel; pose?: BodyPose; id?: string; state?: unknown }) {
  const p = getModelPalette(currentModelTheme());
  const skin = p.skin[idHash(id) % Math.max(1, p.skin.length)] ?? "#d9a57f";
  switch (model) {
    case "bed":
      return (
        <>
          <rect x={-0.5} y={-0.28} width={1} height={0.56} rx={0.05} style={col(p, "bedFrame")} />
          <rect x={-0.45} y={-0.25} width={0.92} height={0.5} rx={0.05} style={col(p, "mattress")} />
          <rect x={-0.02} y={-0.26} width={0.48} height={0.52} rx={0.04} style={col(p, stateKey(state) === "cleaning" ? "sheetDirty" : "sheet")} />
          <rect x={-0.43} y={-0.17} width={0.15} height={0.34} rx={0.05} style={col(p, "pillow")} />
          <rect className="lm-fig-state" x={0.46} y={-0.28} width={0.05} height={0.56} />
          <circle className="lm-fig-state" cx={-0.47} cy={0.18} r={0.06} />
          <rect x={-0.45} y={-0.47} width={0.08} height={0.2} style={col(p, "monitor")} />
        </>
      );
    case "patient":
      if (pose === "lying") {
        return (
          <>
            <rect x={-0.2} y={-0.23} width={0.66} height={0.46} rx={0.06} style={col(p, "blanket")} />
            <rect className="lm-fig-state" x={0.28} y={-0.23} width={0.04} height={0.46} />
            <circle cx={-0.33} r={0.1} style={{ fill: skin, stroke: "none" }} />
          </>
        );
      }
      return <Person model={model} p={p} skin={skin} />;
    case "nurse":
    case "doctor":
    case "paramedic":
    case "manager":
    case "person":
      return <Person model={model} p={p} skin={skin} />;
    case "cleaner":
      return (
        <>
          <Person model={model} p={p} skin={skin} dx={-0.12} />
          <rect x={0.2} y={-0.15} width={0.26} height={0.3} rx={0.03} style={col(p, "evsCart")} />
          <circle cx={0.33} cy={0.05} r={0.07} style={col(p, "evsBucket")} />
        </>
      );
    case "transporter":
      return (
        <>
          <Person model={model} p={p} skin={skin} dx={-0.14} />
          <rect x={0.2} y={-0.13} width={0.26} height={0.26} rx={0.03} style={col(p, "wheelchairSeat")} />
          <rect x={0.17} y={-0.18} width={0.26} height={0.04} style={col(p, "wheelchair")} />
          <rect x={0.17} y={0.14} width={0.26} height={0.04} style={col(p, "wheelchair")} />
        </>
      );
    case "ambulance":
    case "vehicle": {
      const amb = model === "ambulance";
      return (
        <>
          <rect x={-0.49} y={-0.23} width={0.98} height={0.46} rx={0.05} style={col(p, amb ? "vanBody" : "vehicleBody")} />
          <rect x={0.42} y={-0.19} width={0.06} height={0.38} style={col(p, "glass")} />
          <rect className="lm-fig-state" x={-0.43} y={-0.15} width={0.5} height={0.3} rx={0.03} />
          {amb && (
            <>
              <rect x={-0.49} y={-0.23} width={0.98} height={0.04} style={col(p, "vanStripe")} />
              <rect x={-0.49} y={0.19} width={0.98} height={0.04} style={col(p, "vanStripe")} />
              <path d="M-0.21 -0.1h0.06v0.07h0.07v0.06h-0.07v0.07h-0.06v-0.07h-0.07v-0.06h0.07z" style={col(p, "vanStripe")} />
              <rect x={0.33} y={-0.13} width={0.06} height={0.12} style={col(p, "lightRed")} />
              <rect x={0.33} y={0.01} width={0.06} height={0.12} style={col(p, "lightBlue")} />
            </>
          )}
        </>
      );
    }
    case "equipment":
      return (
        <>
          <rect x={-0.18} y={-0.18} width={0.36} height={0.36} rx={0.04} style={col(p, "equipment")} />
          <rect className="lm-fig-state" x={-0.09} y={-0.17} width={0.18} height={0.34} rx={0.03} />
          <rect x={0.06} y={-0.12} width={0.03} height={0.24} style={col(p, "equipmentScreen")} />
        </>
      );
    default:
      return <rect className="lm-fig-state" x={-0.5} y={-0.5} width={1} height={1} rx={0.2} />;
  }
}
