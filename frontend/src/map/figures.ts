// Which figure draws an asset (ADR 0006 "Kinds and figures"). Pure, shared by
// the 3D scene, the 2D fallback and the motion engine.
import type { Asset } from "../api/types";

export type FigureModel =
  | "bed" | "patient" | "person" | "nurse" | "doctor" | "cleaner"
  | "ambulance" | "vehicle" | "equipment" | "other";

export const FIGURE_LABELS: Record<FigureModel, string> = {
  bed: "Bed",
  patient: "Patient",
  person: "Staff",
  nurse: "Nurse",
  doctor: "Doctor",
  cleaner: "Cleaner",
  ambulance: "Ambulance",
  vehicle: "Vehicle",
  equipment: "Equipment",
  other: "Other",
};

const ROLE: Record<string, FigureModel> = {
  nurse: "nurse", rn: "nurse", "registered nurse": "nurse", "charge nurse": "nurse",
  doctor: "doctor", physician: "doctor", md: "doctor", surgeon: "doctor", consultant: "doctor", resident: "doctor",
  cleaner: "cleaner", housekeeping: "cleaner", housekeeper: "cleaner", evs: "cleaner", janitor: "cleaner", custodian: "cleaner",
  patient: "patient",
};

const PERSON_KINDS = new Set(["person", "staff", "nurse", "doctor", "cleaner", "people", "employee"]);

const low = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Figure for a kind and role (both case-insensitive). Unknown kinds give "other". */
export function figureModel(kind: unknown, role?: unknown): FigureModel {
  const k = low(kind);
  const r = low(role);
  if (k === "ambulance") return "ambulance";
  if (k === "vehicle") return r === "ambulance" ? "ambulance" : "vehicle";
  if (k === "bed") return "bed";
  if (k === "equipment") return "equipment";
  if (k === "patient") return "patient";
  if (PERSON_KINDS.has(k) || k === "") {
    const byRole = ROLE[r];
    if (byRole) return byRole;
    if (k === "nurse" || k === "doctor" || k === "cleaner") return k;
    if (k) return "person";
  }
  return "other";
}

export function figureOf(a: Asset): FigureModel {
  return figureModel(a.kind, a.role);
}

/** People walk; vehicles drive (faster, through the ambulance entrance). */
export const isVehicle = (m: FigureModel) => m === "ambulance" || m === "vehicle";
export const isPerson = (m: FigureModel) => m === "patient" || m === "person" || m === "nurse" || m === "doctor" || m === "cleaner";

/** Mesh group key for the 3D scene: one merged mesh per model. */
export function figureKey(a: Asset): FigureModel {
  return figureOf(a);
}
