// Row filters (MappingConfig.filter, docs/adr/0006-hospital-map.md): labels,
// plain-language summaries and the editor's draft <-> saved conversions.
// The backend (app/core/rowfilter.py) is the authority on matching; the
// matcher here only estimates how many preview rows a filter keeps.
import type { Column, RowFilter } from "../../api/types";

export type FilterOp = RowFilter["op"];

export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "eq", label: "is" },
  { op: "ne", label: "is not" },
  { op: "in", label: "is one of" },
  { op: "not_in", label: "is none of" },
  { op: "is_null", label: "is empty" },
  { op: "not_null", label: "is not empty" },
  { op: "gt", label: "is greater than" },
  { op: "gte", label: "is at least" },
  { op: "lt", label: "is less than" },
  { op: "lte", label: "is at most" },
  { op: "contains", label: "contains" },
];

export const NO_VALUE_OPS: FilterOp[] = ["is_null", "not_null"];
export const LIST_OPS: FilterOp[] = ["in", "not_in"];

/** What the editor holds: the value is always the text the user typed. */
export type FilterDraft = { column: string; op: FilterOp; text: string };

export type ColumnKind = "number" | "time" | "bool" | "text";

/** Rough type family from a source's type name (mirrors rowfilter.type_family). */
export function columnKind(type: string | undefined): ColumnKind {
  const t = (type ?? "").toLowerCase();
  if (/^bool|^bit$/.test(t)) return "bool";
  if (/date|time/.test(t) && !/interval/.test(t)) return "time";
  if (/int|numeric|decimal|float|double|real|number|money|serial/.test(t) && !/point|interval/.test(t)) return "number";
  return "text";
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(valueText).join(", ");
  return String(v);
}

export function toDraft(f: RowFilter): FilterDraft {
  return { column: f.column, op: f.op, text: valueText(f.value) };
}

function typed(text: string, kind: ColumnKind): unknown {
  const s = text.trim();
  if (kind === "bool" && /^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
  if (kind === "number" && s !== "" && Number.isFinite(Number(s))) return Number(s);
  return s;
}

/** Draft -> saved filter, with numbers and true/false typed by the column's type. */
export function fromDraft(d: FilterDraft, columns: Column[]): RowFilter {
  const kind = columnKind(columns.find((c) => c.name === d.column)?.type);
  if (NO_VALUE_OPS.includes(d.op)) return { column: d.column, op: d.op };
  if (LIST_OPS.includes(d.op)) {
    return { column: d.column, op: d.op, value: d.text.split(",").map((p) => p.trim()).filter(Boolean).map((p) => typed(p, kind)) };
  }
  return { column: d.column, op: d.op, value: typed(d.text, kind) };
}

/** Problem with one draft, in plain words (undefined = fine). */
export function draftProblem(d: FilterDraft, columns: Column[]): string | undefined {
  if (!d.column) return "Choose a column.";
  if (columns.length > 0 && !columns.some((c) => c.name === d.column)) return `“${d.column}” isn't in this table.`;
  if (NO_VALUE_OPS.includes(d.op)) return undefined;
  const parts = LIST_OPS.includes(d.op) ? d.text.split(",").map((p) => p.trim()).filter(Boolean) : [d.text.trim()];
  if (parts.length === 0 || parts.some((p) => p === "")) {
    return LIST_OPS.includes(d.op) ? "Enter one or more values, separated by commas." : "Enter a value.";
  }
  const kind = columnKind(columns.find((c) => c.name === d.column)?.type);
  if (kind === "number" && parts.some((p) => !Number.isFinite(Number(p)))) return "Enter a number.";
  if (kind === "bool" && parts.some((p) => !/^(true|false|yes|no|1|0)$/i.test(p))) return "Choose true or false.";
  if (kind === "time" && d.op !== "contains" && parts.some((p) => !/^\d{4}-\d{2}-\d{2}/.test(p))) {
    return "Enter a date like 2026-10-07 or 2026-10-07T14:30:00Z.";
  }
  return undefined;
}

const show = (v: unknown) => (typeof v === "string" ? `“${v}”` : String(v));

export function describeOne(f: RowFilter): string {
  const c = f.column || "(column)";
  switch (f.op) {
    case "is_null": return `${c} is empty`;
    case "not_null": return `${c} is not empty`;
    case "in": return `${c} is one of ${(Array.isArray(f.value) ? f.value : []).map(show).join(", ")}`;
    case "not_in": return `${c} is none of ${(Array.isArray(f.value) ? f.value : []).map(show).join(", ")}`;
    default: return `${c} ${FILTER_OPS.find((o) => o.op === f.op)?.label ?? f.op} ${show(f.value)}`;
  }
}

/** "Only rows where discharged_at is empty", or "All rows". */
export function describeFilter(filters: RowFilter[] | undefined | null): string {
  if (!filters || filters.length === 0) return "All rows";
  return `Only rows where ${filters.map(describeOne).join(" and ")}`;
}

// -- estimate on preview rows -------------------------------------------------

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const asTime = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) || v.length <= 10 ? v : `${v}Z`) : NaN);

function compare(rec: unknown, want: unknown, ordering = false): number | null {
  if (typeof rec === "boolean") {
    const w = typeof want === "boolean" ? want : /^(true|yes|1)$/i.test(String(want)) ? true : /^(false|no|0)$/i.test(String(want)) ? false : null;
    return w === null ? null : Number(rec) - Number(w);
  }
  if (typeof rec === "number") {
    const w = Number(want);
    return typeof want === "boolean" || String(want).trim() === "" || !Number.isFinite(w) ? null : rec - w;
  }
  if (typeof rec === "string") {
    const a = asTime(rec), b = asTime(String(want));
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
    if (typeof want === "number") return Number.isFinite(Number(rec)) ? Number(rec) - want : null;
    const w = String(want);
    // Numbers stored as text order as numbers ("9" < "10"); codes like "007" stay text for equality.
    if (ordering && rec.trim() !== "" && w.trim() !== "" && Number.isFinite(Number(rec)) && Number.isFinite(Number(w))) {
      return Number(rec) - Number(w);
    }
    return rec === w ? 0 : rec < w ? -1 : 1;
  }
  return null;
}

function matchOne(row: Record<string, unknown>, f: RowFilter): boolean {
  const v = row[f.column];
  const eq = (x: unknown) => !isEmpty(v) && compare(v, x) === 0;
  const list = Array.isArray(f.value) ? f.value : [];
  switch (f.op) {
    case "is_null": return isEmpty(v);
    case "not_null": return !isEmpty(v);
    case "eq": return eq(f.value);
    case "ne": return !eq(f.value);
    case "in": return list.some(eq);
    case "not_in": return !list.some(eq);
    case "contains": return !isEmpty(v) && String(v).toLowerCase().includes(String(f.value).toLowerCase());
    default: {
      if (isEmpty(v)) return false;
      const d = compare(v, f.value, true);
      if (d === null) return false;
      return f.op === "gt" ? d > 0 : f.op === "gte" ? d >= 0 : f.op === "lt" ? d < 0 : d <= 0;
    }
  }
}

/** Estimate only: the backend decides. */
export function rowMatches(row: Record<string, unknown>, filters: RowFilter[]): boolean {
  return filters.every((f) => matchOne(row, f));
}
