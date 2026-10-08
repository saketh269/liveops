// Journeys from real history (ADR 0007): the patient's care steps, a staff
// member's rooms today, a bed's turnaround. Only what the history and the
// sources' own timestamps say; nothing is estimated.
import type { AssetHistory, HistoryEntry } from "../../api/types";

export type StepState = "done" | "now" | "stuck" | "todo" | "skipped";
export type Step = {
  key: string;
  label: string;
  /** When the step was reached (epoch s), or null when it happened before Live Ops watched / never happened. */
  at: number | null;
  state: StepState;
  /** True when `at` is only when Live Ops first saw it (the step may have started earlier). */
  atLeast?: boolean;
  /** Seconds in this step so far (current step only). */
  elapsed?: number;
};
export type PatientJourney = { kind: "patient"; steps: Step[]; current: number; stuck: Step | null; left: boolean };
export type Visit = { place: string; floor: string | null; from: number; to: number | null; ongoing: boolean };
export type StaffJourney = { kind: "staff"; visits: Visit[] };
export type BedSpan = { status: string; raw: string; from: number; to: number | null };
export type BedJourney = {
  kind: "bed";
  spans: BedSpan[];
  /** Last dirty → clean turnaround (or the one still running). */
  turnaround: { dirtyAt: number; cleanAt: number | null; seconds: number } | null;
};
export type OtherJourney = { kind: "other"; entries: HistoryEntry[] };
export type Journey = PatientJourney | StaffJourney | BedJourney | OtherJourney;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const STAGES: Record<string, string[]> = {
  arrived: ["arrived", "registered", "check_in", "checked_in", "arrival"],
  waiting: ["waiting_room", "waiting", "waiting_for_provider", "triage", "in_triage", "triaged", "awaiting_triage"],
  treatment: ["in_treatment", "awaiting_results", "being_seen", "treatment", "under_evaluation", "in_progress"],
  boarding: ["boarding", "admit_ordered", "admit_decision", "admission_ordered", "awaiting_bed", "pending_admission", "bed_requested"],
  inpatient: ["admitted", "inpatient", "off_unit", "on_unit"],
  discharge: ["discharge_ordered", "pending_discharge", "ready_for_discharge", "discharged", "discharging"],
};
export function patientStage(status: unknown): keyof typeof STAGES | null {
  const s = norm(status);
  for (const [k, list] of Object.entries(STAGES)) if (list.includes(s)) return k as keyof typeof STAGES;
  return null;
}

export const PATIENT_STEPS = [
  { key: "arrived", label: "Arrived" },
  { key: "waiting", label: "Triage / waiting" },
  { key: "ed-bed", label: "ED bed" },
  { key: "treatment", label: "In treatment" },
  { key: "boarding", label: "Admit decision / boarding" },
  { key: "inpatient", label: "Inpatient bed" },
  { key: "discharge", label: "Discharge" },
] as const;

/** Minutes after which the current step is highlighted as stuck. */
export const STUCK_MINUTES: Partial<Record<(typeof PATIENT_STEPS)[number]["key"], number>> = {
  waiting: 60,
  treatment: 240,
  boarding: 120,
  discharge: 240,
};

const ARRIVAL_KEYS = ["arrival_time", "arrived_at", "admit_time", "registered_at", "check_in_time"];

/** The patient's steps from history (ordered oldest first) and source timestamps. */
export function patientJourney(h: AssetHistory, now: number): PatientJourney {
  const at: (number | null)[] = PATIENT_STEPS.map(() => null);
  const reach = (i: number, ts: number) => { if (at[i] === null) at[i] = ts; };
  const entries = h.entries.filter((e) => e.kind !== "task" && e.kind !== "update");
  const first = entries[0]?.ts ?? null;
  const arrival = h.milestones.filter((m) => ARRIVAL_KEYS.includes(m.key)).sort((a, b) => a.ts - b.ts)[0];
  if (arrival) reach(0, arrival.ts);
  else if (first !== null) reach(0, first);
  let edBed: string | null = null;
  let left = false;
  for (const e of entries) {
    if (e.kind === "left") { left = true; continue; }
    left = false;
    const stage = patientStage(e.status_raw);
    const furthest = at.reduce<number>((m, v, i) => (v !== null ? i : m), -1);
    if (stage === "waiting") reach(1, e.ts);
    if (stage === "treatment") reach(3, e.ts);
    if (stage === "boarding") reach(4, e.ts);
    if (stage === "discharge") reach(6, e.ts);
    if (e.bed) {
      const inpatient = stage === "inpatient" || stage === "discharge" || furthest >= 4;
      if (inpatient && e.bed !== edBed) reach(5, e.ts);
      else if (!inpatient) { reach(2, e.ts); edBed ??= e.bed; }
    } else if (stage === "inpatient") reach(5, e.ts);
  }
  const current = at.reduce<number>((m, v, i) => (v !== null ? i : m), -1);
  const firstSeenAt = first !== null && h.history_since !== null && first - h.history_since < 300 ? first : null;
  let stuck: Step | null = null;
  const steps: Step[] = PATIENT_STEPS.map((s, i) => {
    const step: Step = { key: s.key, label: s.label, at: at[i], state: "todo" };
    if (i > current) return step;
    if (at[i] === null) {
      // Not seen: it happened before Live Ops watched, unless an earlier step was seen (then it was skipped).
      // (Arrival does not count: it is known from the source or from the first sighting.)
      step.state = at.slice(1, i).some((v) => v !== null) ? "skipped" : "done";
      return step;
    }
    if (at[i] === firstSeenAt && !(i === 0 && arrival)) step.atLeast = true;
    if (i < current || left) { step.state = "done"; return step; }
    step.elapsed = Math.max(0, now - at[i]!);
    const limit = STUCK_MINUTES[s.key];
    step.state = limit !== undefined && step.elapsed > limit * 60 ? "stuck" : "now";
    if (step.state === "stuck") stuck = step;
    return step;
  });
  return { kind: "patient", steps, current, stuck, left };
}

/** Local midnight of the day containing `now` (epoch s). */
export function startOfDay(now: number): number {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** Rooms a staff member was in today, oldest first. */
export function staffJourney(h: AssetHistory, now: number): StaffJourney {
  const day = startOfDay(now);
  const places = h.entries.filter((e) => e.kind === "arrived" || e.kind === "move" || e.kind === "left");
  const visits: Visit[] = [];
  for (let i = 0; i < places.length; i++) {
    const e = places[i];
    if (e.kind === "left") continue;
    const next = places[i + 1];
    const to = next ? next.ts : null;
    if (to !== null && to < day) continue;
    visits.push({ place: e.zone ?? (e.bed ? `Bed ${e.bed}` : "Unknown place"), floor: e.floor, from: e.ts, to, ongoing: to === null && h.present });
  }
  return { kind: "staff", visits };
}

const DIRTY = ["dirty", "needs_cleaning", "cleaning_required", "vacated", "to_clean"];
const CLEAN = ["available", "free", "clean", "ready", "vacant"];

/** A bed's state history and its last dirty-to-clean time. */
export function bedJourney(h: AssetHistory, now: number): BedJourney {
  const changes = h.entries.filter((e) => (e.kind === "status" || e.kind === "arrived" || e.kind === "move") && e.status);
  const spans: BedSpan[] = [];
  for (const e of changes) {
    const raw = norm(e.status_raw);
    if (spans.length && spans[spans.length - 1].raw === raw) continue;
    if (spans.length) spans[spans.length - 1].to = e.ts;
    spans.push({ status: e.status ?? raw, raw, from: e.ts, to: null });
  }
  let turnaround: BedJourney["turnaround"] = null;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (!DIRTY.includes(spans[i].raw)) continue;
    // The first dirty span of this cycle (dirty → cleaning → … stays one cycle).
    let j = i;
    while (j > 0 && !CLEAN.includes(spans[j - 1].raw) && (DIRTY.includes(spans[j - 1].raw) || spans[j - 1].raw === "cleaning")) j--;
    const dirtyAt = spans[j].from;
    const clean = spans.slice(i + 1).find((s) => CLEAN.includes(s.raw));
    turnaround = { dirtyAt, cleanAt: clean ? clean.from : null, seconds: Math.max(0, (clean ? clean.from : now) - dirtyAt) };
    break;
  }
  return { kind: "bed", spans, turnaround };
}

export function journeyFor(model: "patient" | "staff" | "bed" | "other", h: AssetHistory, now: number): Journey {
  if (model === "patient") return patientJourney(h, now);
  if (model === "staff") return staffJourney(h, now);
  if (model === "bed") return bedJourney(h, now);
  return { kind: "other", entries: h.entries.slice(-6) };
}
