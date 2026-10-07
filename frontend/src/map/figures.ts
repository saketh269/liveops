// Which figure draws an asset (ADR 0006 "Kinds and figures", ADR 0007 models).
// Pure, shared by the 3D scene, the 2D fallback and the motion engine.
import type { Asset } from "../api/types";
import { roleModel } from "./models/roles";

export type FigureModel =
  | "bed" | "patient" | "person" | "nurse" | "doctor" | "cleaner" | "transporter" | "paramedic" | "manager"
  | "ambulance" | "vehicle" | "equipment" | "other";

/** How a figure's body is posed. Only patients lie down (in a bed, decided by placement); everyone else stands. */
export type BodyPose = "standing" | "lying";

export const FIGURE_LABELS: Record<FigureModel, string> = {
  bed: "Bed",
  patient: "Patient",
  person: "Staff",
  nurse: "Nurse",
  doctor: "Doctor",
  cleaner: "Environmental services",
  transporter: "Transporter",
  paramedic: "Paramedic",
  manager: "Bed manager / supervisor",
  ambulance: "Ambulance",
  vehicle: "Vehicle",
  equipment: "Equipment",
  other: "Other",
};

/** Kinds that are people; the role (if any) then picks the figure. */
const PERSON_KINDS = new Set(["person", "staff", "people", "employee", "clinician", "worker"]);
/** Kinds that name a figure directly (used when the role says nothing more specific). */
const KIND_MODEL: Record<string, FigureModel> = {
  nurse: "nurse", doctor: "doctor", physician: "doctor", cleaner: "cleaner", evs: "cleaner", housekeeping: "cleaner",
  transporter: "transporter", porter: "transporter", paramedic: "paramedic", medic: "paramedic", ems: "paramedic",
  manager: "manager", supervisor: "manager",
};

const low = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Figure for a kind and role (both case-insensitive). Unknown kinds give "other". */
export function figureModel(kind: unknown, role?: unknown): FigureModel {
  const k = low(kind);
  if (k === "ambulance") return "ambulance";
  if (k === "vehicle") return low(role).includes("ambulance") ? "ambulance" : "vehicle";
  if (k === "bed") return "bed";
  if (k === "equipment") return "equipment";
  if (k === "patient") return "patient";
  const byKind = KIND_MODEL[k];
  if (PERSON_KINDS.has(k) || byKind || k === "") {
    const byRole = roleModel(role);
    if (byRole) return byRole;
    if (byKind) return byKind;
    if (k) return "person";
  }
  return "other";
}

export function figureOf(a: Asset): FigureModel {
  return figureModel(a.kind, a.role);
}

const PEOPLE = new Set<FigureModel>(["patient", "person", "nurse", "doctor", "cleaner", "transporter", "paramedic", "manager"]);

/** People walk; vehicles drive (faster, through the ambulance entrance). */
export const isVehicle = (m: FigureModel) => m === "ambulance" || m === "vehicle";
export const isPerson = (m: FigureModel) => PEOPLE.has(m);
/** Models that have a lying pose (drawn in a bed). */
export const canLie = (m: FigureModel) => m === "patient";
