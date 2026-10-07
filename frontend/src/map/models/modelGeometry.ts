// The figure models (ADR 0007 "recognisable models", after the approved
// prototype). Each model sits on y = 0 in a unit footprint and faces +x (the
// direction of travel; a bed's head is at -x). Parts are painted from the
// models palette or with the record's state color, and legs/arms carry a swing
// weight so walkers can stride on the GPU.
import * as THREE from "three";
import type { FigureModel } from "../figures";
import type { PaletteKey } from "./palette";
import { cuboid, disc, frustum, gem, plate, wheel } from "./primitives";

/** Paint for a part: a palette key, or the record's state color. */
export type Paint = PaletteKey | "state";

/** Every paint a template may use, in a fixed order (index stored per vertex). */
export const PAINTS: readonly Paint[] = [
  "state", "skin", "hair",
  "scrubs", "scrubsPants", "nurseCap", "coat", "doctorPants", "stethoscope",
  "evs", "evsPants", "evsCart", "evsBucket", "transporter", "transporterPants", "wheelchair", "wheelchairSeat",
  "medic", "medicPants", "reflective", "blazer", "blazerPants", "shirt", "staff", "staffPants", "gown", "gownPants",
  "bedFrame", "mattress", "sheet", "pillow", "blanket", "monitor", "monitorScreen",
  "vanBody", "vanStripe", "glass", "tire", "lightRed", "lightBlue", "vehicleBody",
  "equipment", "equipmentScreen", "other",
];
const PAINT_INDEX = new Map(PAINTS.map((p, i) => [p, i]));

/** Light bar lamps: +1 flashes on the first half of the cycle, -1 on the second. */
type Flash = 1 | -1;
/** Swing: legs/arms rotate about `pivot` height; `sign` picks the side (left +1, right -1), `amount` scales it. */
type Swing = { sign: number; pivot: number; len: number; amount?: number };

type Part = { geo: THREE.BufferGeometry; paint: Paint; at: [number, number, number]; shade?: number; swing?: Swing; flash?: Flash };

/** CPU-side template of one model: per-vertex arrays ready to be baked into a batch. */
export type ModelTemplate = {
  pos: Float32Array;
  nrm: Float32Array;
  /** Paint index per vertex (into PAINTS). */
  paint: Uint8Array;
  /** Brightness multiplier per vertex. */
  shade: Float32Array;
  /** Signed stride weight per vertex (0 = rigid). */
  swing: Float32Array;
  /** Light-bar lamp per vertex (0 = none, ±1 = phase). */
  flash: Float32Array;
  index: Uint16Array;
  verts: number;
  /** Height in footprint units (selection box, picking, stacking). */
  height: number;
  /** Has legs that stride while walking. */
  walks: boolean;
};

const part = (geo: THREE.BufferGeometry, paint: Paint, at: [number, number, number], extra: Partial<Part> = {}): Part => ({ geo, paint, at, ...extra });

function build(parts: Part[], height: number): ModelTemplate {
  let verts = 0, tris = 0;
  for (const p of parts) { verts += p.geo.getAttribute("position").count; tris += p.geo.index!.count; }
  const t: ModelTemplate = {
    pos: new Float32Array(verts * 3), nrm: new Float32Array(verts * 3), paint: new Uint8Array(verts), shade: new Float32Array(verts),
    swing: new Float32Array(verts), flash: new Float32Array(verts), index: new Uint16Array(tris), verts, height, walks: false,
  };
  let v0 = 0, i0 = 0;
  for (const p of parts) {
    p.geo.translate(p.at[0], p.at[1], p.at[2]);
    const pos = p.geo.getAttribute("position").array as ArrayLike<number>;
    const nrm = p.geo.getAttribute("normal").array as ArrayLike<number>;
    const n = pos.length / 3;
    t.pos.set(pos, v0 * 3);
    t.nrm.set(nrm, v0 * 3);
    const paint = PAINT_INDEX.get(p.paint);
    if (paint === undefined) throw new Error(`unknown paint ${p.paint}`);
    for (let v = 0; v < n; v++) {
      t.paint[v0 + v] = paint;
      t.shade[v0 + v] = p.shade ?? 1;
      t.flash[v0 + v] = p.flash ?? 0;
      if (p.swing) {
        const { sign, pivot, len, amount = 1 } = p.swing;
        t.swing[v0 + v] = sign * amount * Math.min(1, Math.max(0, (pivot - pos[v * 3 + 1]) / len));
        t.walks = true;
      }
    }
    const idx = p.geo.index!.array;
    for (let k = 0; k < idx.length; k++) t.index[i0 + k] = idx[k] + v0;
    v0 += n; i0 += idx.length;
    p.geo.dispose();
  }
  return t;
}

// ---------- people ----------

type Outfit = {
  top: Paint; pants: Paint; arms?: Paint;
  /** Torso bottom radius and bottom height (a coat or gown flares lower). */
  hem?: { r: number; y: number };
  /** Shift the person back to make room for something pushed ahead (cart, wheelchair). */
  back?: number;
};

const HIP = 0.42, SHOULDER = 0.76;

function person(o: Outfit, extra: (dx: number) => Part[] = () => []): Part[] {
  const dx = -(o.back ?? 0);
  const hem = o.hem ?? { r: 0.15, y: 0.4 };
  const leg = (z: number, sign: number) => part(frustum(0.05, 0.06, HIP, 4), o.pants, [dx, 0, z], { swing: { sign, pivot: HIP, len: HIP } });
  const arm = (z: number, sign: number) => part(frustum(0.04, 0.045, 0.32, 4), o.arms ?? o.top, [dx, 0.41, z], { swing: { sign, pivot: SHOULDER, len: 0.34, amount: 0.55 } });
  return [
    part(disc(0.21), "state", [dx, 0.004, 0]),
    leg(0.065, 1), leg(-0.065, -1),
    part(frustum(hem.r, 0.11, SHOULDER - hem.y, 6, { top: true }), o.top, [dx, hem.y, 0]),
    arm(0.15, -1), arm(-0.15, 1),
    part(gem(0.11, 6, 1.05), "skin", [dx, 0.875, 0]),
    ...extra(dx),
  ];
}

const PERSON_H = 0.98;

function people(model: FigureModel): ModelTemplate | null {
  switch (model) {
    case "nurse":
      return build(person({ top: "scrubs", pants: "scrubsPants" }, (dx) => [
        part(frustum(0.09, 0.08, 0.05, 6, { top: true }), "nurseCap", [dx, 0.93, 0]),
      ]), PERSON_H + 0.01);
    case "doctor":
      return build(person({ top: "coat", pants: "doctorPants", hem: { r: 0.17, y: 0.27 } }, (dx) => [
        part(cuboid(0.02, 0.14, 0.12), "stethoscope", [dx + 0.125, 0.56, 0]),
        part(gem(0.028), "stethoscope", [dx + 0.14, 0.55, 0.04]),
      ]), PERSON_H);
    case "cleaner":
      return build(person({ top: "evs", pants: "evsPants", back: 0.12 }, () => [
        part(cuboid(0.26, 0.28, 0.3), "evsCart", [0.3, 0.03, 0], { shade: 0.95 }),
        part(frustum(0.07, 0.08, 0.1, 6, { top: true }), "evsBucket", [0.3, 0.31, 0.05]),
        part(frustum(0.012, 0.012, 0.6, 3), "evsPants", [0.38, 0.28, -0.1]), // mop handle
      ]), PERSON_H);
    case "transporter":
      return build(person({ top: "transporter", pants: "transporterPants", back: 0.14 }, () => [
        part(plate(0.24, 0.26), "wheelchairSeat", [0.3, 0.28, 0]),
        part(cuboid(0.04, 0.24, 0.26), "wheelchairSeat", [0.19, 0.29, 0]),
        part(wheel(0.13, 0.03, 1), "wheelchair", [0.25, 0.13, 0.15]),
        part(wheel(0.13, 0.03, -1), "wheelchair", [0.25, 0.13, -0.15]),
      ]), PERSON_H);
    case "paramedic":
      return build(person({ top: "medic", pants: "medicPants" }, (dx) => [
        part(frustum(0.155, 0.148, 0.045, 6), "reflective", [dx, 0.5, 0]),
      ]), PERSON_H);
    case "manager":
      return build(person({ top: "blazer", pants: "blazerPants" }, (dx) => [
        part(cuboid(0.02, 0.11, 0.07), "shirt", [dx + 0.11, 0.63, 0]),
      ]), PERSON_H);
    case "person":
      return build(person({ top: "staff", pants: "staffPants" }), PERSON_H);
    case "patient":
      return build(person({ top: "gown", pants: "gownPants", hem: { r: 0.16, y: 0.3 } }), PERSON_H);
    default:
      return null;
  }
}

// ---------- bed, lying patient ----------

/** Mattress top in bed units: a lying patient rests here. */
export const MATTRESS_TOP = 0.32;

function bed(): ModelTemplate {
  return build([
    part(cuboid(1, 0.22, 0.56), "bedFrame", [0, 0.02, 0], { shade: 0.95 }),
    part(cuboid(0.92, 0.08, 0.5), "mattress", [0.01, 0.24, 0]),
    part(cuboid(0.48, 0.025, 0.52), "sheet", [0.22, 0.305, 0]),
    part(cuboid(0.15, 0.06, 0.34), "pillow", [-0.35, MATTRESS_TOP, 0]),
    part(cuboid(0.05, 0.44, 0.56), "bedFrame", [-0.475, 0.02, 0]), // headboard
    part(cuboid(0.04, 0.14, 0.56), "state", [0.48, 0.22, 0]), // footboard shows the bed's state
    part(gem(0.05), "state", [-0.475, 0.52, 0.18], { shade: 1.15 }), // status light
    part(frustum(0.012, 0.012, 0.44, 3), "monitor", [-0.41, 0, -0.37]),
    part(cuboid(0.04, 0.15, 0.2), "monitor", [-0.41, 0.42, -0.37]),
    part(cuboid(0.006, 0.11, 0.16), "monitorScreen", [-0.388, 0.44, -0.37], { shade: 1.2 }),
  ], 0.58);
}

function lyingPatient(): ModelTemplate {
  const y = MATTRESS_TOP;
  return build([
    part(cuboid(0.66, 0.07, 0.46), "blanket", [0.12, y, 0]),
    part(cuboid(0.34, 0.05, 0.28), "blanket", [0.0, y + 0.07, 0], { shade: 1.05 }), // body under the blanket
    part(cuboid(0.1, 0.05, 0.3), "gown", [-0.24, y + 0.02, 0]), // shoulders
    part(cuboid(0.04, 0.012, 0.47), "state", [0.3, y + 0.07, 0]), // state band
    part(gem(0.1, 6, 1), "skin", [-0.33, y + 0.11, 0]),
  ], 0.6); // a little taller than the bed so picking over the bed finds the patient
}

// ---------- vehicles, equipment ----------

function van(ambulance: boolean): ModelTemplate {
  const body: Paint = ambulance ? "vanBody" : "vehicleBody";
  const parts = [
    part(cuboid(0.66, 0.4, 0.46), body, [-0.16, 0.1, 0]),
    part(cuboid(0.3, 0.3, 0.44), body, [0.33, 0.1, 0]),
    part(cuboid(0.02, 0.12, 0.38), "glass", [0.48, 0.26, 0]),
    ...([[-0.3, 0.21], [-0.3, -0.21], [0.3, 0.21], [0.3, -0.21]] as const).map(([x, z]) => part(wheel(0.09, 0.06, z > 0 ? 1 : -1), "tire", [x, 0.09, z])),
    part(plate(0.5, 0.3), "state", [-0.18, 0.505, 0]), // roof panel shows the record's state
  ];
  if (ambulance) parts.push(
    part(cuboid(0.665, 0.06, 0.465), "vanStripe", [-0.16, 0.3, 0]),
    part(plate(0.2, 0.06), "vanStripe", [-0.18, 0.51, 0]),
    part(plate(0.06, 0.2), "vanStripe", [-0.18, 0.511, 0]),
    part(cuboid(0.06, 0.05, 0.12), "lightRed", [0.36, 0.4, -0.07], { flash: 1 }),
    part(cuboid(0.06, 0.05, 0.12), "lightBlue", [0.36, 0.4, 0.07], { flash: -1 }),
  );
  return build(parts, ambulance ? 0.52 : 0.5);
}

function equipment(): ModelTemplate {
  return build([
    part(cuboid(0.36, 0.04, 0.36), "equipment", [0, 0, 0], { shade: 0.85 }),
    part(frustum(0.025, 0.025, 0.56, 3), "equipment", [0, 0.04, 0]),
    part(cuboid(0.18, 0.26, 0.34), "state", [0, 0.58, 0]), // the device carries the record's state
    part(cuboid(0.006, 0.16, 0.24), "equipmentScreen", [0.093, 0.63, 0]),
  ], 0.84);
}

/** Unknown kinds (and records without a kind) keep the plain box (ADR 0006), in the state color. */
function other(): ModelTemplate {
  return build([part(cuboid(1, 0.45, 1), "state", [0, 0, 0])], 0.45);
}

/** Template for a model in a pose. Only models that can lie (patients) have a lying template. */
export function modelTemplate(model: FigureModel, lying = false): ModelTemplate {
  if (lying && model === "patient") return lyingPatient();
  if (model === "bed") return bed();
  if (model === "ambulance" || model === "vehicle") return van(model === "ambulance");
  if (model === "equipment") return equipment();
  return people(model) ?? other();
}
