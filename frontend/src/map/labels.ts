// Plain-language text for the live map: field names, values, statuses, zone names,
// event lines and transient locations. Pure functions (plus one small memo for a
// record's own status, see ownStatus); everything shown comes from a real record.
import type { Asset, SiteLayout } from "../api/types";
import { FIGURE_LABELS, figureOf } from "./figures";
import { resolveZone } from "./placement";
import { assetName } from "./reducer";
import { parseTs } from "./hud/time";

// ---------------------------------------------------------------- tokens

/** Words written in capitals wherever they appear in a humanized token. */
const ACRONYMS = new Set(["ed", "er", "icu", "nicu", "picu", "pacu", "cvu", "mri", "ct", "esi", "eta", "evs", "ems", "iv", "id", "mph", "or"]);
/** Acronyms that are also plain words in lower case ("or"): capitals only when the source wrote them so. */
const AMBIGUOUS = new Set(["or"]);
const PLACE_WORDS = new Set(["at", "on", "in"]);

/**
 * True for machine-style tokens: snake_case ("at_hospital_offloading"), UPPER_SNAKE
 * ("AT_HOSPITAL_OFFLOADING") or one lower-case word ("returning"). Real names such
 * as "ED-02", "3W-305A" or "Radiology – MRI" are not tokens.
 */
export function isRawToken(s: string): boolean {
  const t = s.trim();
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(t) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t);
}

/**
 * A machine token in words, sentence case: "waiting_for_provider" → "Waiting for provider",
 * "AT_HOSPITAL_OFFLOADING" → "At hospital · offloading", "esi" → "ESI". Anything that is
 * not a token (a real name) comes back unchanged.
 */
export function humanizeToken(s: string): string {
  const t = s.trim();
  if (!isRawToken(t)) return t;
  const upper = t === t.toUpperCase();
  const words = t.toLowerCase().split("_").filter(Boolean).map((w) => (ACRONYMS.has(w) && (upper || !AMBIGUOUS.has(w)) ? w.toUpperCase() : w));
  if (!words.length) return t;
  if (words[0] === words[0].toLowerCase()) words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  // "at hospital offloading" reads as a place and an activity: "At hospital · offloading".
  const last = words[words.length - 1];
  if (words.length >= 3 && PLACE_WORDS.has(words[0].toLowerCase()) && /ing$/.test(last)) {
    return `${words.slice(0, -1).join(" ")} · ${last}`;
  }
  return words.join(" ");
}

/** The same words for use inside a sentence: "waiting for provider", "ED boarding". */
export function inSentence(s: string): string {
  const h = humanizeToken(s);
  if (h === s.trim() && !isRawToken(s)) return h; // a real name keeps its case
  const first = h.split(/\s/)[0];
  return first.length > 1 && first === first.toUpperCase() ? h : h.charAt(0).toLowerCase() + h.slice(1);
}

/** A zone's name as shown on the map and in cards: tokens humanized, real names kept. */
export function zoneLabel(name: string): string {
  return humanizeToken(name);
}

/** A zone value from a record, as a place name ("ED Waiting Room", "At hospital · offloading"). */
export function placeName(layout: SiteLayout | null | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const z = resolveZone(layout?.zones ?? [], value);
  return zoneLabel(z ? z.name || z.id : String(value));
}

/** Two-bed rooms: "3W-305A" → "305A" when the full name does not fit; null when there is nothing shorter. */
export function shortRoomLabel(name: string): string | null {
  const m = /^.*?[-_ ./]([^-_ ./]*\d[^-_ ./]*)$/.exec(name.trim());
  return m && m[1] !== name.trim() ? m[1] : null;
}

// ---------------------------------------------------------------- durations and times

/** 30 → "under 1 min", 2820 → "47 min", 11100 → "3 h 5 min", 200000 → "2 d 7 h". */
export function durWords(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m < 1) return "under 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** "12 min ago", "in 3 h", "just now". */
export function relWords(ts: number, now: number): string {
  const d = now - ts;
  if (Math.abs(d) < 60) return "just now";
  return d > 0 ? `${durWords(d)} ago` : `in ${durWords(-d)}`;
}

/** Local clock time, with the day when it is not today: "14:05", "6 Oct, 14:05". */
export function localTime(ts: number, now: number): string {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = new Date(now * 1000).toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

// ---------------------------------------------------------------- field names and values

const FIELD_LABELS: Record<string, string> = {
  esi_acuity: "Acuity (ESI)",
  acuity: "Acuity",
  encounter_class: "Visit type",
  expected_discharge: "Expected discharge",
  admit_time: "Admitted",
  admitted_at: "Admitted",
  status_since: "Status since",
  isolation_capable: "Isolation room",
  blocked_reason: "Blocked because",
  badge_last_seen: "Badge last seen",
  eta_minutes: "ETA (min)",
  speed_mph: "Speed (mph)",
  target_minutes: "Target (min)",
  clean_type: "Cleaning type",
  created_at: "Requested",
  requested_at: "Requested",
  started_at: "Started",
  updated_at: "Updated",
  zone: "Location",
  current_location: "Location",
  anchor: "Bed",
  floor: "Floor",
  role: "Role",
  phone_ext: "Phone extension",
};

/** "esi_acuity" → "Acuity (ESI)", "bed_id" → "Bed", "unit_id" → "Unit", "created_at" → "Requested". */
export function fieldLabel(key: string): string {
  const k = key.replace(/^attributes\./, "");
  const lk = k.toLowerCase();
  if (FIELD_LABELS[lk]) return FIELD_LABELS[lk];
  const base = lk.replace(/_(id|at)$/, "");
  return humanizeToken(base || lk);
}

/** Fields whose values are codes from a list (shown in words). */
const ENUM_FIELDS = new Set(["status", "state", "encounter_class", "clean_type", "mode", "priority", "role", "bed_type", "type", "shift", "kind"]);
const TIME_FIELD = /(_at|_time|_since|_seen|^since|_discharge)$/;

export type ValueContext = { now: number; layout?: SiteLayout | null };

/** The unit's name when the layout knows it (a zone of kind "unit"), else the value. */
export function unitName(layout: SiteLayout | null | undefined, id: string): string {
  const z = (layout?.zones ?? []).find((x) => x.kind === "unit" && (x.id === id || x.name === id));
  return z?.name || id;
}

/** A field's value for people; null means "nothing to show" (hidden). */
export function valueText(key: string, v: unknown, ctx: ValueContext): string | null {
  const k = key.replace(/^attributes\./, "").toLowerCase();
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if ((typeof v === "string" || typeof v === "number") && (TIME_FIELD.test(k) || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)))) {
    const t = parseTs(v);
    if (t !== null && t > 1e8) return `${localTime(t, ctx.now)} · ${relWords(t, ctx.now)}`;
  }
  if (typeof v === "string") {
    if (k === "unit_id" || k === "unit" || k === "department") return unitName(ctx.layout, v);
    if (k === "zone" || k === "current_location") return placeName(ctx.layout, v);
    if (isRawToken(v) && (ENUM_FIELDS.has(k) || v.includes("_"))) return humanizeToken(v);
    return v;
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- whose field is it

/** Fields only a record's own mapping sets (attached mappings add attributes only). */
const OWN_FIELDS = new Set(["zone", "state", "label", "kind", "anchor", "floor", "role", "x", "y"]);

/** The source that drives the record's state (its own mapping), or null. */
export function primarySource(a: Asset): string | null {
  const s = a._sources ?? {};
  return s.state ?? s.zone ?? s.label ?? s.kind ?? null;
}

/** Sources that set any of the record's own fields (zone, state, label …). */
export function ownSources(a: Asset): Set<string> {
  const out = new Set<string>();
  for (const [k, sid] of Object.entries(a._sources ?? {})) if (OWN_FIELDS.has(k) && sid) out.add(sid);
  return out;
}

// --- state (LIVEOPS-116) ---
/** One attached mapping's own values, as the server sends them under `_attached`. */
export type AttachedRecord = { source_id: string; attributes?: Record<string, unknown>; [field: string]: unknown };

/**
 * Attached mappings' own values (a transport on a patient, a cleaning task on a bed), keyed by
 * mapping id. The server keeps them apart from the record's own fields, so the merged
 * `attributes.status` is always the record's own and these still say "Transport: in progress".
 */
export function attachedOf(a: Asset | undefined): AttachedRecord[] {
  const raw = a?._attached;
  if (!raw || typeof raw !== "object") return [];
  return Object.values(raw as Record<string, unknown>).filter(
    (g): g is AttachedRecord => !!g && typeof g === "object" && typeof (g as AttachedRecord).source_id === "string",
  );
}
// --- end state ---

/** Source of one attribute (per-key source, else the whole-attributes source). */
export function attributeSource(a: Asset, key: string): string | null {
  const s = a._sources ?? {};
  return s[`attributes.${key}`] ?? s.attributes ?? null;
}

// The merged record keeps one value per attribute: when an attached source (a transport
// request, a cleaning task) also sends "status", the latest write wins. Remember the
// record's own status while it was visible, for as long as its mapped state is unchanged.
const OWN_STATUS = new Map<string, { state: unknown; status: string }>();
/** Records where an attached source was seen writing "status": an old status value may then be theirs. */
const SHARED_STATUS = new Set<string>();
const OWN_STATUS_CAP = 20_000;

const CANONICAL = new Set(["free", "in_use", "cleaning", "alert"]);

/**
 * The record's own status value (as its source sent it): never an attached source's.
 * Falls back to the mapped state. Null when the record has neither.
 */
export function ownStatus(a: Asset): string | null {
  const key = `${a.site_id}\u0000${a.asset_id}`;
  const raw = a.attributes?.status;
  const primary = primarySource(a);
  const statusSrc = attributeSource(a, "status");
  if (statusSrc !== null && primary !== null && statusSrc !== primary) {
    if (SHARED_STATUS.size >= OWN_STATUS_CAP) SHARED_STATUS.clear();
    SHARED_STATUS.add(key);
  }
  if (typeof raw === "string" && raw && (primary === null || statusSrc === null || statusSrc === primary)) {
    if (primary !== null) {
      if (OWN_STATUS.size >= OWN_STATUS_CAP) OWN_STATUS.delete(OWN_STATUS.keys().next().value!);
      OWN_STATUS.set(key, { state: a.state, status: raw });
    }
    return raw;
  }
  const seen = OWN_STATUS.get(key);
  if (seen && seen.state === a.state) return seen.status;
  if (typeof a.state === "string" && a.state) return a.state;
  return null;
}

/** Forget remembered statuses (tests). */
export function resetOwnStatus(): void {
  OWN_STATUS.clear();
  SHARED_STATUS.clear();
}

/** The record's own status in words, sentence case: "Waiting for provider". */
export function statusText(a: Asset): string {
  const s = ownStatus(a);
  if (!s) return "No status";
  return CANONICAL.has(s) || isRawToken(s) ? humanizeToken(s) : s;
}

// ---------------------------------------------------------------- who

const ROLE_FIGURES = new Set(["nurse", "doctor", "transporter", "paramedic"]);

/** True when the record is a person on staff (has a role, or a staff-like kind). */
export function isStaffRecord(a: Asset): boolean {
  const m = figureOf(a);
  return m !== "patient" && (typeof a.role === "string" && a.role !== "" || ["person", "nurse", "doctor", "cleaner", "transporter", "paramedic", "manager"].includes(m));
}

/** "Nurse Daniel Wagner", "EVS technician Ana Ruiz", "P7401887", "Medic 1". */
export function whoName(a: Asset): string {
  const name = assetName(a);
  if (!isStaffRecord(a)) return name;
  const m = figureOf(a);
  const text = typeof a.role === "string" ? a.role.trim() : "";
  // "Registered Nurse" → "Nurse"; other roles keep their own words ("Hospitalist", "EVS technician").
  const label = ROLE_FIGURES.has(m) ? FIGURE_LABELS[m] : "";
  const role = label && (!text || text.toLowerCase().includes(label.toLowerCase())) ? label : text;
  if (!role) return name;
  // "EVS Technician" → "EVS technician": sentence case, acronyms kept.
  const r = role.split(/\s+/).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase())).join(" ");
  return name.toLowerCase().startsWith(r.toLowerCase()) ? name : `${r} ${name}`;
}

// ---------------------------------------------------------------- attached sources

/** "Riverside – Cleaning tasks" → "Cleaning", "Transport requests" → "Transport". */
export function shortSourceName(name: string): string {
  const tail = name.split(/\s[–—-]\s/).pop()!.trim() || name;
  const cut = tail.replace(/\s+(tasks?|requests?|orders?|jobs?|events?|records?|log|feed|\(live\))$/i, "").trim();
  return cut || tail;
}

const PERSON_KEYS = ["assigned_to", "assignee", "owner", "staff_name", "transporter", "cleaner"];
const STARTED_KEYS = ["started_at", "created_at", "requested_at", "opened_at"];

export type AttachedSection = { sourceId: string; title: string; summary: string; facts: { key: string; label: string; value: string }[] };

/**
 * Details added by other sources (a cleaning task on a bed, a transport request on a
 * patient) as small sections: "Cleaning: in progress · Marco · 12 min",
 * "Transport to Radiology – MRI: assigned · wheelchair".
 */
export function attachedSections(a: Asset, sourceNames: Record<string, string>, ctx: ValueContext): AttachedSection[] {
  const own = ownSources(a);
  const bySource = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(a.attributes ?? {})) {
    const sid = attributeSource(a, k);
    if (!sid || own.has(sid)) continue;
    const m = bySource.get(sid) ?? {};
    m[k] = v;
    bySource.set(sid, m);
  }
  // --- state (LIVEOPS-116): the attached source's own values, including a status the record's own status hides ---
  for (const g of attachedOf(a)) {
    if (own.has(g.source_id)) continue;
    bySource.set(g.source_id, { ...(bySource.get(g.source_id) ?? {}), ...(g.attributes ?? {}) });
  }
  // --- end state ---
  const out: AttachedSection[] = [];
  for (const [sid, attrs] of bySource) {
    const title = shortSourceName(sourceNames[sid] ?? "Details");
    const dest = attrs.to ?? attrs.destination;
    const head = typeof dest === "string" && dest ? `${title} to ${placeName(ctx.layout, dest)}` : title;
    const used = new Set(["to", "destination"]);
    const parts: string[] = [];
    if (typeof attrs.status === "string" && attrs.status) { parts.push(inSentence(attrs.status)); used.add("status"); }
    const who = PERSON_KEYS.find((k) => typeof attrs[k] === "string" && attrs[k]);
    if (who) { parts.push(String(attrs[who])); used.add(who); }
    if (typeof attrs.mode === "string" && attrs.mode) { parts.push(inSentence(attrs.mode)); used.add("mode"); }
    const startKey = STARTED_KEYS.find((k) => parseTs(attrs[k]) !== null);
    if (startKey) { parts.push(durWords(ctx.now - parseTs(attrs[startKey])!)); used.add(startKey); }
    const facts = Object.keys(attrs).sort().filter((k) => !used.has(k))
      .map((k) => ({ key: `attributes.${k}`, label: fieldLabel(k), value: valueText(k, attrs[k], ctx) }))
      .filter((f): f is { key: string; label: string; value: string } => f.value !== null);
    out.push({ sourceId: sid, title: head, summary: parts.join(" · "), facts });
  }
  return out;
}

// ---------------------------------------------------------------- events

export type Changes = Record<string, [unknown, unknown]>;
export type EventInput = { changes?: Changes | null; removed?: boolean; source?: string | null; assetId?: string | null };
export type EventContext = {
  layout?: SiteLayout | null;
  sourceNames?: Record<string, string>;
};

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : typeof v === "string" ? v : String(v));
const STATUS_KEYS = ["attributes.status", "status", "state"];

/** "transporting to hospital", "boarding", "at hospital · offloading" read as "is …"; "waiting room" is a place. */
const PROGRESSIVE = /^(\S+ing(\s+(to|for|at|on|in|from|with)\b.*)?|(at|on|en route)\b.*|in (?!use\b).*)$/i;

/** The verb phrase for a new status: "is dirty (was occupied)", "is transporting to hospital", "is now free". */
export function statusPhrase(to: string, from: string | null): string {
  const t = inSentence(to);
  if (PROGRESSIVE.test(t)) return `is ${t}`; // "is transporting to hospital"
  return from ? `is ${t} (was ${inSentence(from)})` : `is now ${t}`;
}

const DISCHARGE = /discharg/i;

/**
 * One short line for a feed entry, or null when it says nothing worth a line
 * (badge pings, GPS). `asset` is the record as it is now (or as it left).
 *   "moved from ED Waiting Room to ED-02 · now waiting for provider"
 *   "is dirty (was occupied)", "went to 3W-305A", "left the map (discharged)",
 *   "transport is now assigned"
 */
export function eventText(e: EventInput, asset: Asset | undefined, ctx: EventContext = {}): string | null {
  const ch: Changes = e.changes ?? {};
  const keys = Object.keys(ch);
  const place = (v: unknown) => placeName(ctx.layout, v);
  if (e.removed) {
    const discharged = keys.some((k) => (STATUS_KEYS.includes(k) || k === "zone") && [ch[k][0], ch[k][1]].some((v) => typeof v === "string" && DISCHARGE.test(v)));
    return discharged ? "left the map (discharged)" : "left the map";
  }
  if (!keys.length) return null;
  const primary = asset ? primarySource(asset) : null;
  const ownKeys = keys.filter((k) => OWN_FIELDS.has(k));
  const attached = !!(e.source && asset && primary && e.source !== primary && ownKeys.length === 0 && !ownSources(asset).has(e.source));
  if (attached) {
    const short = shortSourceName(ctx.sourceNames?.[e.source!] ?? "details");
    const what = /^[A-Z][a-z]/.test(short) ? short.charAt(0).toLowerCase() + short.slice(1) : short; // "transport", "EVS"
    // Once the attached source is gone the record's own status shows again: that is not the attached source's news.
    const holder = asset ? attributeSource(asset, "status") : null;
    // --- state (LIVEOPS-116): with `_attached` the server records the attached source's own status change ---
    const ownChange = attachedOf(asset).some((g) => g.source_id === e.source);
    const st = ch["attributes.status"] && (ownChange || holder === null || holder === e.source) ? ch["attributes.status"] : undefined;
    // --- end state ---
    if (keys.every((k) => k === "attributes.status" ? !st || st[1] === null : ch[k][1] === null || ch[k][1] === undefined)) return `${what} finished`;
    if (keys.every((k) => ch[k][0] === null || ch[k][0] === undefined) && !st) return `${what} added`;
    if (st && str(st[1])) return `${what} ${statusPhrase(str(st[1])!, null)}`;
    return null;
  }
  if (keys.every((k) => ch[k][1] === null || ch[k][1] === undefined)) {
    const name = e.source && ctx.sourceNames?.[e.source];
    return name ? `no longer in ${name}` : null;
  }
  // Status: the source's own value when it sent one, else the mapped state.
  const sKey = ["attributes.status", "state"].find((k) => k in ch && str(ch[k][1]) !== null);
  // The old status may have been an attached source's (they share the field): then say only the new one.
  const shared = sKey === "attributes.status" && asset !== undefined && SHARED_STATUS.has(`${asset.site_id}\u0000${asset.asset_id}`);
  const sFrom = sKey && !shared ? str(ch[sKey][0]) : null;
  const sTo = sKey ? str(ch[sKey][1]) : null;
  let zone = ch.zone;
  // Fleet bays are named by status: the zone change is the status change.
  if (zone && sKey && str(zone[1]) === sTo) zone = undefined as unknown as [unknown, unknown];
  const zFrom = zone ? str(zone[0]) : null;
  const zTo = zone ? str(zone[1]) : null;
  const staff = asset ? isStaffRecord(asset) : false;
  let move: string | null = null;
  if (zone && zTo) move = staff ? `went to ${place(zTo)}` : zFrom ? `moved from ${place(zFrom)} to ${place(zTo)}` : `arrived in ${place(zTo)}`;
  else if (zone && zFrom) move = `left ${place(zFrom)}`;
  // "arrived in ED Waiting Room · now waiting room" says the same thing twice.
  const sameAsPlace = sTo !== null && zTo !== null && place(zTo).toLowerCase().includes(inSentence(sTo).toLowerCase());
  if (move && sTo && !sameAsPlace) return `${move} · now ${inSentence(sTo)}`;
  if (move) return move;
  if (sTo) return statusPhrase(sTo, sFrom);
  const an = ch.anchor;
  if (an && str(an[1])) return `is now in bed ${str(an[1])}`;
  if (ch.label && str(ch.label[1])) return `is now called ${str(ch.label[1])}`;
  return null;
}

// ---------------------------------------------------------------- transient locations

/** Values that describe movement, not a place: "En route ED-07 → 4E-405A", "in transit", "Discharged". */
export function looksTransient(value: string): boolean {
  const v = value.trim();
  return /→|->|⇒|\bto\b.*\bfrom\b/i.test(v)
    || /^(en[\s_-]?route|in[\s_-]?transit|transit|on the way|moving|travel(l)?ing|transferring|discharged|departed|left)\b/i.test(v);
}

/** Minimum time a zone value must be seen (when only one record has it) before it is offered as a zone. */
export const SETTLE_SECONDS = 120;

/**
 * Split zone values that match no zone into places worth adding and transient ones.
 * Transient: movement-like values, or values held by a single record for less than
 * SETTLE_SECONDS (`firstSeen` holds when each value was first seen, epoch seconds).
 */
export function splitTransient(missing: ReadonlyMap<string, number>, firstSeen: ReadonlyMap<string, number>, now: number): { places: Map<string, number>; transient: Map<string, number> } {
  const places = new Map<string, number>();
  const transient = new Map<string, number>();
  for (const [v, n] of missing) {
    const since = firstSeen.get(v) ?? now;
    const fresh = n <= 1 && now - since < SETTLE_SECONDS;
    (looksTransient(v) || fresh ? transient : places).set(v, n);
  }
  return { places, transient };
}

/** True for records that only carry details for another one (no zone, state, label or kind of their own yet). */
export function detailOnly(a: Asset): boolean {
  const fromAttached = Object.keys(a._sources ?? {}).some((k) => k === "attributes" || k.startsWith("attributes."));
  return fromAttached && ownSources(a).size === 0 && [a.zone, a.state, a.label, a.kind].every((v) => v === undefined || v === null || v === "");
}

