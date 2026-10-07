import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import type { ConnectorSpec, Dataset, Mapping, MappingConfig, Site, Source, SourceRecord } from "../../api/types";
import { cellText, humanize } from "../format";
import { ErrorNotice, Loading } from "../ui";
import { useLoad } from "../useLoad";

/** States the live map colors (see --state-* tokens). Anything else shows as "unknown". */
export const MAP_STATES = ["free", "in_use", "cleaning", "alert"];
/** Mirrors MIN_POLL_INTERVAL_S in backend/app/connectors/base.py. */
export const MIN_POLL_S = 0.5;
const MAIN_FIELDS = ["zone", "state", "label"] as const;
type ExtraField = { name: string; column: string };

type Props = {
  sites: Site[];
  sources: Source[];
  connectors: ConnectorSpec[];
  existing?: Mapping;
  initialSiteId?: string;
  initialSourceId?: string;
  onSaved: (m: Mapping) => void;
  onCancel: () => void;
};

const GUESS: Record<"zone" | "state" | "label", RegExp> = {
  zone: /^(zone|unit|ward|area|location|dock|aisle|field)$/i,
  state: /^(state|status)$/i,
  label: /^(label|name|title|display_name)$|_label$|_name$/i,
};

function Step({ title, locked, lockedText, children }: { title: string; locked?: boolean; lockedText?: string; children?: ReactNode }) {
  return (
    <li className={`step${locked ? " locked" : ""}`}>
      <section className="panel" aria-label={title}>
        <h2>{title}</h2>
        {locked ? <p className="muted" style={{ margin: 0 }}>{lockedText}</p> : children}
      </section>
    </li>
  );
}

function ColumnSelect({ id, value, onChange, columns, noneLabel, invalid, describedBy }: {
  id: string; value: string; onChange: (v: string) => void; columns: Dataset["columns"];
  noneLabel?: string; invalid?: boolean; describedBy?: string;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy}>
      <option value="">{noneLabel ?? "Choose a column"}</option>
      {value && !columns.some((c) => c.name === value) && <option value={value}>{value} (not in this table)</option>}
      {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)}
    </select>
  );
}

export function MappingWizard({ sites, sources, connectors, existing, initialSiteId, initialSourceId, onSaved, onCancel }: Props) {
  const cfg = existing?.config;
  const [siteId, setSiteId] = useState(existing?.site_id ?? initialSiteId ?? (sites.length === 1 ? sites[0].id : ""));
  const [sourceId, setSourceId] = useState(existing?.source_id ?? initialSourceId ?? (sources.length === 1 ? sources[0].id : ""));
  const [dataset, setDataset] = useState(existing?.dataset ?? "");
  const [idField, setIdField] = useState(cfg?.id_field ?? "");
  const [fields, setFields] = useState<Record<"zone" | "state" | "label", string>>({
    zone: cfg?.fields.zone ?? "", state: cfg?.fields.state ?? "", label: cfg?.fields.label ?? "",
  });
  // Any other asset field the config maps (e.g. x, y, cleaning) is kept and editable (LIVEOPS-32).
  const [extraFields, setExtraFields] = useState<ExtraField[]>(() =>
    Object.entries(cfg?.fields ?? {})
      .filter(([k]) => !(MAIN_FIELDS as readonly string[]).includes(k))
      .map(([name, column]) => ({ name, column })));
  const [kind, setKind] = useState(cfg?.kind ?? "");
  const [attributes, setAttributes] = useState<string[]>(cfg?.attributes ?? []);
  const [stateMap, setStateMap] = useState<Record<string, string>>(cfg?.state_map ?? {});
  const [matchMode, setMatchMode] = useState<"id" | "other">(cfg?.match_key && cfg.match_key !== cfg.id_field ? "other" : "id");
  const [matchKey, setMatchKey] = useState(cfg?.match_key ?? "");
  const [poll, setPoll] = useState(String(existing?.options?.poll_interval_s ?? 3));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const source = sources.find((s) => s.id === sourceId);
  const spec = connectors.find((c) => c.type === source?.type);

  const ds = useLoad<Dataset[]>(() => (sourceId ? api.datasets(sourceId) : Promise.resolve([])), [sourceId]);
  const current = ds.data?.find((d) => d.name === dataset);
  const pv = useLoad<SourceRecord[]>(
    () => (sourceId && dataset ? api.preview(sourceId, dataset, 20) : Promise.resolve([])), [sourceId, dataset]);
  const columns = useMemo(() => current?.columns ?? [], [current]);

  const distinctStates = useMemo(() => {
    const seen = new Set<string>();
    if (fields.state) {
      for (const r of pv.data ?? []) {
        const v = r[fields.state];
        if (v !== null && v !== undefined && v !== "") seen.add(String(v));
      }
    }
    const fromPreview = [...seen].slice(0, 40);
    // Saved translations are always shown, even beyond the preview cap, so none are lost on save.
    return [...new Set([...fromPreview, ...Object.keys(stateMap)])];
  }, [pv.data, fields.state, stateMap]);

  const pickDataset = (name: string) => {
    setDataset(name);
    const d = ds.data?.find((x) => x.name === name);
    const cols = d?.columns.map((c) => c.name) ?? [];
    setIdField(d?.primary_key[0] ?? "");
    const guess = (re: RegExp) => cols.find((c) => re.test(c)) ?? "";
    setFields({ zone: guess(GUESS.zone), state: guess(GUESS.state), label: guess(GUESS.label) });
    setExtraFields([]);
    setAttributes([]);
    setStateMap({});
    setMatchMode("id");
    setMatchKey("");
  };

  const pickSource = (id: string) => {
    setSourceId(id);
    setDataset("");
    setIdField("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!siteId) errs.site = "Choose the site these assets belong to.";
    if (!sourceId) errs.source = "Choose the source to read from.";
    if (!dataset) errs.dataset = "Choose a table or dataset.";
    if (!idField) errs.id = "Choose the column that identifies each asset, such as bed_id.";
    if (matchMode === "other" && !matchKey) errs.match = "Choose the shared key column, or use the ID column.";
    const pollN = Number(poll.trim().replace(",", "."));
    if (poll.trim() === "" || !(pollN >= MIN_POLL_S && pollN <= 3600)) errs.poll = `Enter a number of seconds between ${MIN_POLL_S} and 3600.`;
    const names = extraFields.filter((f) => f.name.trim() || f.column).map((f) => f.name.trim());
    if (extraFields.some((f) => (f.name.trim() === "") !== (f.column === ""))) errs.extra = "Each extra field needs both a name and a column.";
    else if (names.some((n) => (MAIN_FIELDS as readonly string[]).includes(n))) errs.extra = "Zone, state and label are set above; use another name.";
    // "kind" may come from a column (an extra field) or be one fixed value above, not both (LIVEOPS-32).
    else if (names.includes("kind") && kind.trim()) errs.extra = "Kind is set to a fixed value above; clear it there to read kind from a column.";
    else if (new Set(names).size !== names.length) errs.extra = "Each extra field name can be used only once.";
    setErrors(errs);
    setServerError(null);
    if (Object.keys(errs).length) return;

    const config: MappingConfig = {
      // Keep any config keys this screen doesn't know about.
      ...(cfg ?? {}),
      id_field: idField,
      // "Use the ID column": keep an explicit match_key equal to the ID column as it was saved.
      match_key: matchMode === "other" ? matchKey : cfg?.match_key && cfg.match_key === idField ? cfg.match_key : null,
      fields: {
        ...Object.fromEntries(Object.entries(fields).filter(([, c]) => c)),
        ...Object.fromEntries(extraFields.filter((f) => f.name.trim() && f.column).map((f) => [f.name.trim(), f.column])),
      },
      state_map: Object.fromEntries(
        Object.entries(stateMap)
          // Drop blank and no-op entries, but keep identity entries that were already saved (LIVEOPS-32).
          .filter(([raw, to]) => to.trim() && (to.trim() !== raw || cfg?.state_map?.[raw] === raw))
          .map(([r, t]) => [r, t.trim()])),
      attributes,
      kind: kind.trim() || null,
    };
    const options = { ...(existing?.options ?? {}), poll_interval_s: pollN };
    setBusy(true);
    try {
      const saved = existing
        ? await api.updateMapping(existing.id, { dataset, config, options })
        : await api.createMapping({ site_id: siteId, source_id: sourceId, dataset, config, options, active: true });
      onSaved(saved);
    } catch (err) {
      setServerError(err);
      setBusy(false);
    }
  };

  const errorCount = Object.keys(errors).length;
  const hasDataset = !!current;
  const lockedText = "Choose a site, source and dataset first.";

  return (
    <form onSubmit={submit} noValidate className="stack" aria-label={existing ? "Edit mapping" : "New mapping"}>
      <ol className="steps">
        <Step title="Site">
          <div className="field">
            <label htmlFor="m-site">Show the assets on</label>
            <select id="m-site" value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!!existing} aria-invalid={!!errors.site}>
              <option value="">Choose a site</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {existing && <span className="help">A mapping stays on its site. To move it, create a new mapping and delete this one.</span>}
            {errors.site && <span className="err">{errors.site}</span>}
          </div>
        </Step>

        <Step title="Source">
          <div className="field">
            <label htmlFor="m-source">Read from</label>
            <select id="m-source" value={sourceId} onChange={(e) => pickSource(e.target.value)} disabled={!!existing} aria-invalid={!!errors.source}>
              <option value="">Choose a source</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {errors.source && <span className="err">{errors.source}</span>}
          </div>
        </Step>

        <Step title="Dataset" locked={!sourceId} lockedText="Choose a source first.">
          {ds.loading && <Loading label="Listing the tables this source can read…" />}
          {ds.error !== null && <ErrorNotice error={ds.error} title="Couldn't list the tables" onRetry={ds.reload} />}
          {ds.data && ds.data.length === 0 && !ds.loading && (
            <div className="notice">
              This source shows no readable tables. Grant the read-only user SELECT on the tables you want, then reload.
              <div className="row-actions"><button type="button" className="btn" onClick={ds.reload}>Reload</button></div>
            </div>
          )}
          {ds.data && ds.data.length > 0 && (
            <div className="field">
              <label htmlFor="m-dataset">Table or dataset</label>
              <select id="m-dataset" value={dataset} onChange={(e) => pickDataset(e.target.value)} aria-invalid={!!errors.dataset}>
                <option value="">Choose a dataset</option>
                {ds.data.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.columns.length} columns)</option>)}
              </select>
              {errors.dataset && <span className="err">{errors.dataset}</span>}
              {dataset && ds.data && !current && !ds.loading && (
                <span className="err">“{dataset}” is no longer readable from this source. Choose another dataset.</span>
              )}
            </div>
          )}
        </Step>

        <Step title="Preview" locked={!hasDataset} lockedText="Choose a dataset to see a sample of its records.">
          {pv.loading && <Loading label="Reading a sample of records…" />}
          {pv.error !== null && <ErrorNotice error={pv.error} title="Couldn't read a preview" onRetry={pv.reload} />}
          {pv.data && !pv.loading && pv.data.length === 0 && (
            <div className="notice info">This dataset is empty right now. You can still map it; assets appear when records arrive.</div>
          )}
          {pv.data && pv.data.length > 0 && (
            <>
              <p className="muted" style={{ margin: 0 }}>First {pv.data.length} records.</p>
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Preview of records">
                <table className="data">
                  <thead>
                    <tr>{columns.map((c) => <th key={c.name} scope="col">{c.name}<span className="type">{c.type}</span></th>)}</tr>
                  </thead>
                  <tbody>
                    {pv.data.map((r, i) => (
                      <tr key={i}>{columns.map((c) => <td key={c.name} title={cellText(r[c.name])}>{cellText(r[c.name])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Step>

        <Step title="Map fields" locked={!hasDataset} lockedText={lockedText}>
          <p className="muted" style={{ margin: 0 }}>Tell Live Ops which columns describe each asset on the map.</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="m-id">ID column<span className="req" aria-hidden="true">*</span></label>
              <ColumnSelect id="m-id" value={idField} onChange={setIdField} columns={columns} invalid={!!errors.id} describedBy="m-id-help" />
              <span className="help" id="m-id-help">One value per asset, such as a bed number. Usually the primary key.</span>
              {errors.id && <span className="err">{errors.id}</span>}
            </div>
            <div className="field">
              <label htmlFor="m-zone">Zone</label>
              <ColumnSelect id="m-zone" value={fields.zone} onChange={(v) => setFields({ ...fields, zone: v })} columns={columns} noneLabel="Not mapped" describedBy="m-zone-help" />
              <span className="help" id="m-zone-help">Which area of the site the asset is in, such as a unit or ward. The live map creates a zone for each value it finds.</span>
            </div>
            <div className="field">
              <label htmlFor="m-state">State</label>
              <ColumnSelect id="m-state" value={fields.state} onChange={(v) => setFields({ ...fields, state: v })} columns={columns} noneLabel="Not mapped" describedBy="m-state-help" />
              <span className="help" id="m-state-help">Drives the asset's color on the map.</span>
            </div>
            <div className="field">
              <label htmlFor="m-label">Label</label>
              <ColumnSelect id="m-label" value={fields.label} onChange={(v) => setFields({ ...fields, label: v })} columns={columns} noneLabel="Not mapped" describedBy="m-label-help" />
              <span className="help" id="m-label-help">The name shown next to the asset.</span>
            </div>
            <div className="field">
              <label htmlFor="m-kind">Kind</label>
              <input id="m-kind" value={kind} onChange={(e) => setKind(e.target.value)} placeholder="e.g. bed" aria-describedby="m-kind-help" autoComplete="off" />
              <span className="help" id="m-kind-help">The same for every record in this dataset, such as bed, truck or tractor.</span>
            </div>
          </div>
          <fieldset>
            <legend>More fields</legend>
            <p className="help muted" style={{ marginTop: 0 }}>
              Other asset fields, such as x and y for a fixed position, or a field another source also sets.
            </p>
            {extraFields.map((f, i) => (
              <div className="kv-row" key={i} style={{ marginBottom: 6 }}>
                <input aria-label={`Field name ${i + 1}`} placeholder="field name, e.g. x" value={f.name} autoComplete="off"
                  aria-invalid={!!errors.extra}
                  onChange={(e) => setExtraFields(extraFields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <select aria-label={`Column for field ${i + 1}`} value={f.column}
                  onChange={(e) => setExtraFields(extraFields.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
                  <option value="">Choose a column</option>
                  {f.column && !columns.some((c) => c.name === f.column) && <option value={f.column}>{f.column} (not in this table)</option>}
                  {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <button type="button" className="btn link" onClick={() => setExtraFields(extraFields.filter((_, j) => j !== i))}
                  aria-label={`Remove field ${f.name || i + 1}`}>Remove</button>
              </div>
            ))}
            {errors.extra && <p className="err" role="alert" style={{ margin: "0 0 6px" }}>{errors.extra}</p>}
            <button type="button" className="btn" onClick={() => setExtraFields([...extraFields, { name: "", column: "" }])}>Add a field</button>
          </fieldset>
          <fieldset>
            <legend>Extra attributes</legend>
            <p className="help muted" style={{ marginTop: 0 }}>Shown in the asset's details panel on the map.</p>
            <div className="checks">
              {[...columns.map((c) => c.name), ...attributes.filter((a) => !columns.some((c) => c.name === a))].map((name) => (
                <label key={name} className="check">
                  <input
                    type="checkbox"
                    checked={attributes.includes(name)}
                    onChange={(e) => setAttributes(e.target.checked ? [...attributes, name] : attributes.filter((a) => a !== name))}
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        </Step>

        <Step title="State values" locked={!hasDataset || !fields.state} lockedText={hasDataset ? "Map a State column to translate its values." : lockedText}>
          <p className="muted" style={{ margin: 0 }}>
            The map colors these states: {MAP_STATES.map(humanize).join(", ")}. Translate your source's values to them;
            leave a value blank to keep it as it is (it shows as unknown).
          </p>
          {distinctStates.length === 0 && (
            <div className="notice info">No values seen in the preview for “{fields.state}”. Translations can be added later when data arrives.</div>
          )}
          <datalist id="map-states">{MAP_STATES.map((s) => <option key={s} value={s} />)}</datalist>
          <div className="stack-sm" role="group" aria-label="State value translation">
            {distinctStates.map((raw) => (
              <div className="translate-row" key={raw}>
                <label htmlFor={`sm-${raw}`}><code>{raw}</code></label>
                <span className="arrow" aria-hidden="true">→</span>
                <div className="field">
                  <input id={`sm-${raw}`} list="map-states" value={stateMap[raw] ?? ""} placeholder={MAP_STATES.includes(raw) ? "already a map state" : "e.g. in_use"}
                    onChange={(e) => setStateMap({ ...stateMap, [raw]: e.target.value })} aria-label={`Show “${raw}” as`} autoComplete="off" />
                </div>
              </div>
            ))}
          </div>
        </Step>

        <Step title="Match key" locked={!hasDataset} lockedText={lockedText}>
          <p style={{ margin: 0 }}>
            <strong>Use the same key on two sources to combine them into one asset.</strong>{" "}
            <span className="muted">
              For example, the EHR gives a bed its state and housekeeping gives it cleaning status; if both mappings use bed_id
              as the match key, the map shows one bed with both.
            </span>
          </p>
          <div className="stack-sm" role="radiogroup" aria-label="Match key">
            <label className="check">
              <input type="radio" name="match" checked={matchMode === "id"} onChange={() => setMatchMode("id")} />
              Use the ID column{idField ? ` (${idField})` : ""}
            </label>
            <label className="check">
              <input type="radio" name="match" checked={matchMode === "other"} onChange={() => setMatchMode("other")} />
              Use another column shared with another source
            </label>
          </div>
          {matchMode === "other" && (
            <div className="field">
              <label htmlFor="m-match">Shared key column</label>
              <ColumnSelect id="m-match" value={matchKey} onChange={setMatchKey} columns={columns} invalid={!!errors.match} describedBy="m-match-help" />
              <span className="help" id="m-match-help">Its values become the asset IDs on the map, so they must be the same in both sources.</span>
              {errors.match && <span className="err">{errors.match}</span>}
            </div>
          )}
        </Step>

        <Step title={existing ? "Save" : "Save and start"} locked={!hasDataset} lockedText={lockedText}>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="m-poll">Check for changes every (seconds)</label>
            <input id="m-poll" inputMode="decimal" value={poll} onChange={(e) => setPoll(e.target.value)} aria-invalid={!!errors.poll} aria-describedby="m-poll-help" />
            <span className="help" id="m-poll-help">
              {spec && !spec.modes.includes("poll")
                ? "This source sends changes as they happen, so this is only used as a fallback."
                : `At least ${MIN_POLL_S} seconds. Lower is more live but puts more load on the source; 3 seconds suits most databases.`}
            </span>
            {errors.poll && <span className="err">{errors.poll}</span>}
          </div>
          {errorCount > 0 && <div className="notice bad" role="alert">Fix the {errorCount === 1 ? "highlighted field" : `${errorCount} highlighted fields`} above, then save again.</div>}
          {serverError !== null && <ErrorNotice error={serverError} title="Couldn't save the mapping" />}
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy || !hasDataset}>
              {busy ? "Saving…" : existing ? "Save changes" : "Save and start"}
            </button>
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </Step>
      </ol>
    </form>
  );
}
