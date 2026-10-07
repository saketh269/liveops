// Row filter editor: conditions that must all hold, with a plain-language summary.
import type { Column, RowFilter, SourceRecord } from "../../api/types";
import {
  FILTER_OPS, NO_VALUE_OPS, LIST_OPS, columnKind, describeFilter, draftProblem, fromDraft, rowMatches,
  type FilterDraft, type FilterOp,
} from "./filters";

type Props = {
  idPrefix: string;
  columns: Column[];
  drafts: FilterDraft[];
  onChange: (d: FilterDraft[]) => void;
  /** Sample rows to estimate how many the filter keeps. */
  sample?: SourceRecord[];
  /** Show problems (after a save attempt). */
  showErrors?: boolean;
};

/** Saved filters from drafts; drafts with problems are left out. */
export function draftsToFilter(drafts: FilterDraft[], columns: Column[]): RowFilter[] {
  return drafts.filter((d) => !draftProblem(d, columns)).map((d) => fromDraft(d, columns));
}

export function FilterEditor({ idPrefix, columns, drafts, onChange, sample, showErrors }: Props) {
  const set = (i: number, patch: Partial<FilterDraft>) => onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const valid = draftsToFilter(drafts, columns);
  const summary = describeFilter(valid);
  const kept = sample && sample.length > 0 && valid.length > 0 ? sample.filter((r) => rowMatches(r, valid)).length : null;

  return (
    <div className="stack-sm">
      {drafts.length === 0 && <p className="muted" style={{ margin: 0 }}>Every row is shown. Add a condition to show only some rows, such as current ones.</p>}
      {drafts.map((d, i) => {
        const kind = columnKind(columns.find((c) => c.name === d.column)?.type);
        const problem = showErrors ? draftProblem(d, columns) : undefined;
        const errId = `${idPrefix}-f${i}-err`;
        return (
          <div className="filter-row" key={i} role="group" aria-label={`Condition ${i + 1}`}>
            <select aria-label={`Column for condition ${i + 1}`} value={d.column} onChange={(e) => set(i, { column: e.target.value })}
              aria-invalid={!!problem && !d.column} aria-describedby={problem ? errId : undefined}>
              <option value="">Choose a column</option>
              {d.column && !columns.some((c) => c.name === d.column) && <option value={d.column}>{d.column} (not in this table)</option>}
              {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <select aria-label={`Comparison for condition ${i + 1}`} value={d.op} onChange={(e) => set(i, { op: e.target.value as FilterOp })}>
              {FILTER_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            {NO_VALUE_OPS.includes(d.op) ? (
              <span aria-hidden="true" />
            ) : kind === "bool" && !LIST_OPS.includes(d.op) ? (
              <select aria-label={`Value for condition ${i + 1}`} value={d.text} onChange={(e) => set(i, { text: e.target.value })}
                aria-invalid={!!problem} aria-describedby={problem ? errId : undefined}>
                <option value="">Choose</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input aria-label={`Value for condition ${i + 1}`} value={d.text} autoComplete="off"
                inputMode={kind === "number" ? "decimal" : undefined}
                placeholder={LIST_OPS.includes(d.op) ? "values, separated by commas" : kind === "time" ? "e.g. 2026-10-07" : "value"}
                onChange={(e) => set(i, { text: e.target.value })} aria-invalid={!!problem} aria-describedby={problem ? errId : undefined} />
            )}
            <button type="button" className="btn link" onClick={() => onChange(drafts.filter((_, j) => j !== i))}
              aria-label={`Remove condition ${i + 1}`}>Remove</button>
            {problem && <span className="err filter-err" id={errId}>{problem}</span>}
          </div>
        );
      })}
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => onChange([...drafts, { column: "", op: "eq", text: "" }])}>Add a condition</button>
      </div>
      <p className="filter-summary" aria-live="polite" style={{ margin: 0 }}>
        <strong>{summary}.</strong>
        {kept !== null && <span className="muted"> {kept} of the {sample!.length} sample rows match.</span>}
        {drafts.length > 1 && <span className="muted"> Every condition must hold.</span>}
      </p>
    </div>
  );
}
