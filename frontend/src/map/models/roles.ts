// Free-text staff role → figure (ADR 0006 reserved field `role`). Real data says
// things like "Registered Nurse", "Emergency Physician", "EVS Technician" or
// "House Supervisor"; keyword rules are checked in order, case-insensitively,
// and the first match wins. No match → null (the caller falls back by kind).

export type RoleModel = "nurse" | "doctor" | "cleaner" | "transporter" | "paramedic" | "manager" | "patient";

const RULES: [RegExp, RoleModel][] = [
  // Before "nurse" and "patient": "Nurse Manager", "Patient Flow Coordinator" lead people, they do not treat.
  [/\b(bed manager|house supervisor|supervisor|manager|coordinator|administrator|director|patient flow|bed board|bed control)\b/, "manager"],
  // Before "patient" and "technician": "Patient Care Tech" is nursing staff, "EVS Technician" cleans.
  [/\b(evs|environmental|housekeep\w*|cleaner|cleaning|janitor\w*|custodian|custodial|sanitation)\b/, "cleaner"],
  [/\b(nurse|nursing|rn|lpn|lvn|cna|pct|patient care tech\w*|care tech\w*|care assistant|nurse aide|nursing assistant|midwife)\b/, "nurse"],
  [/\b(paramedic|emt|ems|medic|ambulance crew|first responder)\b/, "paramedic"],
  [/\b(transport\w*|porter|orderly)\b/, "transporter"],
  [/\b(doctor|dr|physician|md|surgeon|hospitalist|intensivist|resident|attending|consultant|registrar|anesthetist|anaesthetist|clinician)\b/, "doctor"],
  // Specialists: "Cardiologist", "Obstetrician", "Pediatrician" (not "Technologist" or "Technician").
  [/(?<!techn)olog(ist|y fellow)\b|(?<!techn|electr|beaut)ician\b/, "doctor"],
  [/\b(patient|inpatient|outpatient)\b/, "patient"],
];

/** Figure for a role, or null when no rule matches. */
export function roleModel(role: unknown): RoleModel | null {
  if (typeof role !== "string") return null;
  const r = role.trim().toLowerCase();
  if (!r) return null;
  for (const [re, model] of RULES) if (re.test(r)) return model;
  return null;
}
