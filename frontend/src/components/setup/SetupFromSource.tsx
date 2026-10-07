// "Set up from a source": suggested mappings for a site, as a checklist the user
// reviews, edits and creates in one go (docs/adr/0006-hospital-map.md).
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Column, Dataset, Mapping, MappingConfig, Site, Source, SourceRecord, Suggestion } from "../../api/types";
import { cellText, humanize } from "../format";
import { FilterEditor, draftsToFilter } from "../mapping/FilterEditor";
import { describeFilter, draftProblem, rowMatches, toDraft, type FilterDraft } from "../mapping/filters";
import { ErrorNotice, Loading } from "../ui";
import { useLoad } from "../useLoad";
import "./setup.css";

type Status = "idle" | "creating" | "created" | "failed";
type Item = {
  s: Suggestion;
  selected: boolean;
  config: MappingConfig;
  filters: FilterDraft[];
  status: Status;
  error?: unknown;
};

/** Suggestions at or above this confidence start ticked. */
export const PRESELECT = 0.6;

export function matchWord(confidence: number): string {
  if (confidence >= 0.8) return "Strong match";
  if (confidence >= PRESELECT) return "Likely match";
  return "Possible match";
}

function itemFrom(s: Suggestion): Item | null {
  if (!s.config) return null;
  return { s, selected: s.confidence >= PRESELECT, config: s.config, filters: (s.config.filter ?? []).map(toDraft), status: "idle" };
}

function ColumnPick({ id, label, value, columns, onChange, none }: {
  id: string; label: string; value: string; columns: Column[]; onChange: (v: string) => void; none?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{none ?? "Choose a column"}</option>
        {value && !columns.some((c) => c.name === value) && <option value={value}>{value} (not in this table)</option>}
        {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
    </div>
  );
}

function Summary({ config, attached }: { config: MappingConfig; attached: boolean }) {
  const f = config.fields;
  const states = Object.entries(config.state_map ?? {});
  const parts: [string, string][] = [["ID", config.id_field]];
  if (attached && config.match_key) parts.push(["Joins on", config.match_key]);
  if (f.zone) parts.push(["Zone", f.zone]);
  if (f.state) parts.push(["State", f.state + (states.length ? ` (${states.map(([a, b]) => `${a} → ${humanize(b)}`).join(", ")})` : "")]);
  if (f.label) parts.push(["Label", f.label]);
  if (f.role) parts.push(["Role", f.role]);
  if (config.kind) parts.push(["Kind", config.kind]);
  else if (f.kind) parts.push(["Kind", `from ${f.kind}`]);
  if (f.anchor) parts.push(["Drawn next to", f.anchor]);
  if ((config.attributes ?? []).length) parts.push(["Details", (config.attributes ?? []).join(", ")]);
  return (
    <dl className="meta">
      {parts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function Preview({ sourceId, dataset, columns, filter }: {
  sourceId: string; dataset: string; columns: Column[]; filter: MappingConfig["filter"];
}) {
  const pv = useLoad<SourceRecord[]>(() => api.preview(sourceId, dataset, 10), [sourceId, dataset]);
  const rows = pv.data ?? [];
  const f = filter ?? [];
  const cols = columns.length ? columns.map((c) => c.name) : Object.keys(rows[0] ?? {});
  const shown = rows.filter((r) => rowMatches(r, f)).length;
  if (pv.loading && !pv.data) return <Loading label="Reading a few rows…" />;
  if (pv.error !== null) return <ErrorNotice error={pv.error} title="Couldn't read a preview" onRetry={pv.reload} />;
  if (rows.length === 0) return <p className="muted" style={{ margin: 0 }}>This table is empty right now.</p>;
  return (
    <div className="stack-sm">
      <p className="muted" style={{ margin: 0 }}>
        First {rows.length} rows
        {f.length > 0 && (shown === rows.length ? "; the filter keeps all of them" : `; ${shown} would be shown, the crossed-out ones are left out by the filter`)}.
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label={`Preview of ${dataset}`}>
        <table className="data">
          <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const out = f.length > 0 && !rowMatches(r, f);
              return (
                <tr key={i} className={out ? "setup-row-out" : undefined}>
                  {cols.map((c, j) => (
                    <td key={c} title={cellText(r[c])}>
                      {j === 0 && out && <span className="sr-only">(left out) </span>}
                      {cellText(r[c])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SuggestionCard({ item, sourceId, columns, targetNote, onChange, showErrors, locked }: {
  item: Item; sourceId: string; columns: Column[]; targetNote?: string; showErrors: boolean; locked: boolean;
  onChange: (patch: Partial<Item>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const { s, config } = item;
  const attached = !!s.attach_to;
  const key = s.dataset.replace(/[^A-Za-z0-9_-]/g, "_");
  const filter = draftsToFilter(item.filters, columns);
  const idMissing = !config.id_field;
  const filterBad = item.filters.some((f) => draftProblem(f, columns));
  const invalid = showErrors && item.selected && (idMissing || filterBad);
  const setField = (name: string, column: string) => {
    const fields = { ...config.fields };
    if (column) fields[name] = column; else delete fields[name];
    onChange({ config: { ...config, fields } });
  };

  useEffect(() => {
    if (invalid) setEditing(true);
  }, [invalid]);

  return (
    <li className={`panel setup-item${item.selected ? " selected" : ""}`} aria-label={s.dataset}>
      <div className="setup-item-head">
        <label className="check setup-pick">
          <input type="checkbox" checked={item.selected} disabled={locked || item.status === "created"}
            onChange={(e) => onChange({ selected: e.target.checked })} />
          <span className="mono">{s.dataset}</span>
        </label>
        <div className="badges">
          {attached
            ? <span className="pill info">Adds details to {s.attach_to!.dataset}</span>
            : config.kind && <span className="pill">{humanize(config.kind)}</span>}
          <span className={`pill ${s.confidence >= 0.8 ? "ok" : s.confidence >= PRESELECT ? "info" : "warn"}`}>{matchWord(s.confidence)}</span>
          {item.status === "created" && <span className="pill ok">Created</span>}
          {item.status === "creating" && <span className="pill info">Creating…</span>}
          {item.status === "failed" && <span className="pill bad">Not created</span>}
        </div>
      </div>
      <p className="setup-reason">{s.reason}</p>
      <Summary config={config} attached={attached} />
      <p className="setup-filter"><strong>Rows:</strong> {describeFilter(filter)}.</p>
      {targetNote && item.selected && <div className="notice warn">{targetNote}</div>}
      {item.status === "failed" && item.error !== undefined && <ErrorNotice error={item.error} title={`Couldn't create the mapping for ${s.dataset}`} />}
      {invalid && <div className="err" role="alert">{idMissing ? "Choose an ID column." : "Finish or remove the highlighted conditions."}</div>}
      <div className="row-actions">
        <button type="button" className="btn" aria-expanded={previewing} aria-controls={`pv-${key}`} onClick={() => setPreviewing(!previewing)}>
          {previewing ? "Hide preview" : "Preview rows"}
        </button>
        {item.status !== "created" && (
          <button type="button" className="btn" aria-expanded={editing} aria-controls={`ed-${key}`} disabled={locked}
            onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit"}</button>
        )}
      </div>
      {previewing && (
        <div id={`pv-${key}`}><Preview sourceId={sourceId} dataset={s.dataset} columns={columns} filter={filter} /></div>
      )}
      {editing && item.status !== "created" && (
        <div id={`ed-${key}`} className="stack-sm setup-edit">
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`${key}-id`}>ID column<span className="req" aria-hidden="true">*</span></label>
              <select id={`${key}-id`} value={config.id_field} aria-invalid={showErrors && idMissing}
                onChange={(e) => onChange({ config: { ...config, id_field: e.target.value } })}>
                <option value="">Choose a column</option>
                {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            {attached ? (
              <ColumnPick id={`${key}-match`} label={`Column with the ${s.attach_to!.dataset} ID`} value={config.match_key ?? ""}
                columns={columns} onChange={(v) => onChange({ config: { ...config, match_key: v || null } })} />
            ) : (
              <>
                <ColumnPick id={`${key}-zone`} label="Zone" none="Not mapped" value={config.fields.zone ?? ""} columns={columns} onChange={(v) => setField("zone", v)} />
                <ColumnPick id={`${key}-state`} label="State" none="Not mapped" value={config.fields.state ?? ""} columns={columns} onChange={(v) => setField("state", v)} />
                <ColumnPick id={`${key}-label`} label="Label" none="Not mapped" value={config.fields.label ?? ""} columns={columns} onChange={(v) => setField("label", v)} />
                <div className="field">
                  <label htmlFor={`${key}-kind`}>Kind</label>
                  <input id={`${key}-kind`} value={config.kind ?? ""} autoComplete="off"
                    placeholder={config.fields.kind ? `from ${config.fields.kind}` : "e.g. bed"}
                    aria-describedby={config.fields.kind ? `${key}-kind-help` : undefined}
                    onChange={(e) => {
                      // A fixed kind replaces the kind read from a column (they can't both be set).
                      const fields = { ...config.fields };
                      if (e.target.value) delete fields.kind;
                      onChange({ config: { ...config, fields, kind: e.target.value || null } });
                    }} />
                  {config.fields.kind && <span className="help" id={`${key}-kind-help`}>Read from the {config.fields.kind} column. Type a kind to use one fixed kind instead.</span>}
                </div>
              </>
            )}
          </div>
          <fieldset>
            <legend>Which rows</legend>
            <FilterEditor idPrefix={key} columns={columns} drafts={item.filters} onChange={(filters) => onChange({ filters })}
              showErrors={showErrors} />
          </fieldset>
          <p className="help muted" style={{ margin: 0 }}>State colors and other details can be fine-tuned in the Mapping studio after you create it.</p>
        </div>
      )}
    </li>
  );
}

type Props = { site: Site; sources: Source[]; initialSourceId?: string; onSourceChange?: (id: string) => void };

export function SetupFromSource({ site, sources, initialSourceId, onSourceChange }: Props) {
  const [sourceId, setSourceId] = useState(initialSourceId && sources.some((s) => s.id === initialSourceId)
    ? initialSourceId : sources.length === 1 ? sources[0].id : "");
  const data = useLoad<[Suggestion[], Dataset[]] | null>(
    () => (sourceId ? Promise.all([api.suggestions(sourceId, site.id), api.datasets(sourceId)]) : Promise.resolve(null)),
    [sourceId, site.id]);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [showErrors, setShowErrors] = useState(false);
  const [mappings, setMappings] = useState<Mapping[]>([]);

  useEffect(() => {
    setItems((data.data?.[0] ?? []).map(itemFrom).filter((x): x is Item => x !== null));
    setShowErrors(false);
    setProgress("");
  }, [data.data]);
  useEffect(() => {
    api.mappings(site.id).then(setMappings, () => setMappings([]));
  }, [site.id]);

  const skipped = (data.data?.[0] ?? []).filter((s) => !s.config);
  const columnsOf = useMemo(() => new Map((data.data?.[1] ?? []).map((d) => [d.name, d.columns])), [data.data]);
  const chosen = items.filter((i) => i.selected && i.status !== "created");
  const created = items.filter((i) => i.status === "created").length;

  const update = (dataset: string, patch: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.s.dataset === dataset ? { ...i, ...patch } : i)));

  const targetNote = (item: Item): string | undefined => {
    const t = item.s.attach_to;
    if (!t || t.mapping_id) return undefined;
    const target = items.find((i) => i.s.dataset === t.dataset);
    if (target && (target.selected || target.status === "created")) return undefined;
    return `It adds details to ${t.dataset}, which isn't selected. Without it these rows have no place on the map.`;
  };

  const pick = (id: string) => {
    setSourceId(id);
    onSourceChange?.(id);
  };

  const createAll = async () => {
    const problems = chosen.filter((i) => !i.config.id_field || i.filters.some((f) => draftProblem(f, columnsOf.get(i.s.dataset) ?? [])));
    setShowErrors(true);
    if (problems.length) {
      setProgress(`Fix ${problems.length === 1 ? "1 suggestion" : `${problems.length} suggestions`} before creating.`);
      return;
    }
    // Things first, so the details that attach to them have something to attach to.
    const order = [...chosen].sort((a, b) => Number(!!a.s.attach_to) - Number(!!b.s.attach_to));
    setBusy(true);
    let ok = 0;
    for (const [n, item] of order.entries()) {
      setProgress(`Creating ${n + 1} of ${order.length}: ${item.s.dataset}…`);
      update(item.s.dataset, { status: "creating", error: undefined });
      const config: MappingConfig = { ...item.config, filter: draftsToFilter(item.filters, columnsOf.get(item.s.dataset) ?? []) };
      try {
        await api.createMapping({ site_id: site.id, source_id: sourceId, dataset: item.s.dataset, config, active: true });
        update(item.s.dataset, { status: "created" });
        ok += 1;
      } catch (e) {
        update(item.s.dataset, { status: "failed", error: e });
      }
    }
    const failed = order.length - ok;
    setProgress(failed === 0
      ? `Created ${ok === 1 ? "1 mapping" : `${ok} mappings`}.`
      : `Created ${ok} of ${order.length}. ${failed === 1 ? "1 mapping wasn't" : `${failed} mappings weren't`} created; see below, fix and try again.`);
    setBusy(false);
    api.mappings(site.id).then(setMappings, () => {});
  };

  return (
    <div className="stack">
      <section className="panel stack-sm" aria-label="Source">
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor="setup-source">Read from</label>
          <select id="setup-source" value={sourceId} onChange={(e) => pick(e.target.value)} disabled={busy}>
            <option value="">Choose a source</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span className="help">Live Ops looks at the tables and a few rows of each, and suggests what to show on {site.name}'s map.</span>
        </div>
        {mappings.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            This site already has {mappings.length === 1 ? "1 mapping" : `${mappings.length} mappings`}; tables already mapped are not suggested again.
          </p>
        )}
      </section>

      {sourceId && data.loading && !data.data && <Loading label="Looking at the tables in this source…" />}
      {sourceId && data.error !== null && <ErrorNotice error={data.error} title="Couldn't look at this source" onRetry={data.reload} />}

      {data.data && (
        <>
          {items.length === 0 ? (
            <div className="notice info">
              Nothing in this source looks like things with a place on the map. You can still map a table by hand in
              the <Link to={`/mapping/new?site=${site.id}&source=${sourceId}`}>Mapping studio</Link>.
            </div>
          ) : (
            <section className="stack-sm" aria-label="Suggestions">
              <h2>Suggestions</h2>
              <p className="muted" style={{ margin: 0 }}>Tick what you want on the map, check the preview, and edit anything that's not right.</p>
              <ul className="setup-list">
                {items.map((item) => (
                  <SuggestionCard key={item.s.dataset} item={item} sourceId={sourceId} columns={columnsOf.get(item.s.dataset) ?? []}
                    targetNote={targetNote(item)} showErrors={showErrors} locked={busy}
                    onChange={(patch) => update(item.s.dataset, patch)} />
                ))}
              </ul>
            </section>
          )}

          {skipped.length > 0 && (
            <details className="panel setup-skipped">
              <summary>Not suggested ({skipped.length})</summary>
              <ul>
                {skipped.map((s) => <li key={s.dataset}><span className="mono">{s.dataset}</span>: {s.reason}</li>)}
              </ul>
            </details>
          )}

          {items.length > 0 && (
            <section className="panel stack-sm setup-actions" aria-label="Create">
              <div className="row-actions">
                <button type="button" className="btn primary" disabled={busy || chosen.length === 0} onClick={() => void createAll()}>
                  {busy ? "Creating…" : chosen.length === 0 ? "Nothing selected" : `Create ${chosen.length === 1 ? "1 mapping" : `${chosen.length} mappings`}`}
                </button>
                {created > 0 && <Link className="btn" to={`/map/${site.id}`}>Open live map</Link>}
                <Link className="btn link" to={`/mapping?site=${site.id}`}>Mapping studio</Link>
              </div>
              <p role="status" aria-live="polite" style={{ margin: 0 }}>{progress}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
