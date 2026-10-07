// "Import layout from a source": read floors and zones from an API source,
// preview them, then save (docs/adr/0007-hospital-view.md, "Layout import").
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Floor, LayoutImportFormat, LayoutImportResult, Site, SiteLayout, Source, Zone } from "../../api/types";
import { ErrorNotice, Loading } from "../ui";
import { useLoad } from "../useLoad";
import "./layoutImport.css";

export const DEFAULT_LAYOUT_PATH = "/api/floor-layout";

const FORMATS: { id: LayoutImportFormat; label: string }[] = [
  { id: "auto", label: "Detect automatically" },
  { id: "riverside", label: "Floors → units → rooms → beds" },
  { id: "geojson-lite", label: "GeoJSON polygons" },
];
const FORMAT_NAMES: Record<string, string> = { riverside: "Floors, units, rooms and beds", "geojson-lite": "GeoJSON polygons" };
const KIND_NAMES: Record<string, [string, string]> = {
  room: ["room", "rooms"], corridor: ["corridor", "corridors"], waiting: ["waiting area", "waiting areas"],
  bay: ["bay", "bays"], unit: ["unit", "units"], entrance: ["entrance zone", "entrance zones"], other: ["other zone", "other zones"],
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeKinds(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => plural(n, ...(KIND_NAMES[k] ?? [k, k])))
    .join(", ");
}

/** Small top-down picture of one floor, zones shaded by kind. Decorative: the counts are in the text. */
export function FloorThumb({ floor, zones }: { floor: Floor; zones: Zone[] }) {
  return (
    <figure className="li-thumb">
      <svg viewBox={`0 0 ${floor.width} ${floor.depth}`} role="img" aria-label={`${floor.name}: ${plural(zones.length, "zone")}`}>
        <rect className="li-thumb-floor" x={0} y={0} width={floor.width} height={floor.depth} />
        {zones.map((z) => (
          <polygon key={z.id} className={`li-thumb-zone li-thumb-zone--${z.kind ?? "other"}`} points={z.polygon.map((p) => p.join(",")).join(" ")} />
        ))}
      </svg>
      <figcaption><strong>{floor.name}</strong> <span className="muted">{plural(zones.length, "zone")}</span></figcaption>
    </figure>
  );
}

function floorsOfResult(layout: SiteLayout): { floor: Floor; zones: Zone[] }[] {
  const floors = layout.floors ?? [];
  const first = floors[0]?.id;
  return floors.map((floor) => ({ floor, zones: (layout.zones ?? []).filter((z) => (z.floor_id ?? first) === floor.id) }));
}

type Props = {
  site: Site;
  /** Called after the layout was saved, with the updated site. */
  onImported: (site: Site) => void;
  onClose?: () => void;
  /** Asked before saving, e.g. when the editor has unsaved changes. Return false to stop. */
  confirmImport?: () => boolean;
};

export function LayoutImport({ site, onImported, onClose, confirmImport }: Props) {
  const id = useId();
  const { data: sources, error: loadError, loading, reload } = useLoad(() => api.sources(), []);
  const apiSources = (sources ?? []).filter((s: Source) => s.type === "rest");
  const [sourceId, setSourceId] = useState("");
  const [path, setPath] = useState(DEFAULT_LAYOUT_PATH);
  const [format, setFormat] = useState<LayoutImportFormat>("auto");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [preview, setPreview] = useState<LayoutImportResult | null>(null);
  const [error, setError] = useState<{ err: unknown; saving: boolean } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId && apiSources.length) setSourceId(apiSources[0].id);
  }, [sourceId, apiSources]);

  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPreview(null);
    setError(null);
    setDone(null);
  };

  const run = async (dryRun: boolean) => {
    if (!sourceId) return;
    if (!dryRun && confirmImport && !confirmImport()) return;
    setBusy(dryRun ? "preview" : "import");
    setError(null);
    setDone(null);
    try {
      const res = await api.importLayout(site.id, {
        source_id: sourceId, path: path.trim() || undefined, format, mode, dry_run: dryRun,
        options: root.trim() ? { root: root.trim() } : undefined,
      });
      setPreview(res);
      if (!dryRun) {
        const s = res.summary;
        setDone(`Layout imported: ${plural(s.floors, "floor")}, ${plural(s.zones, "zone")}${s.kept_zones ? `, ${plural(s.kept_zones, "zone")} of yours kept` : ""}.`);
        onImported({ ...site, layout: res.layout, updated_ts: Date.now() / 1000 });
      }
    } catch (e) {
      setError({ err: e, saving: !dryRun });
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(true);
  };

  if (loading && !sources) return <Loading label="Loading sources…" />;
  if (loadError !== null) return <ErrorNotice error={loadError} title="Couldn't load your sources" onRetry={reload} />;

  const s = preview?.summary;
  const blocked = !!s && s.problems.length > 0;
  return (
    <section className="li stack-sm" aria-labelledby={`${id}-h`}>
      <div className="li-head">
        <h2 id={`${id}-h`}>Import layout from a source</h2>
        {onClose && <button type="button" className="btn" onClick={onClose}>Close</button>}
      </div>
      {apiSources.length === 0 ? (
        <div className="notice info">
          Layout import reads floors and rooms from an API source. Connect one first (type “REST API (JSON)”).
          <div className="row-actions"><Link className="btn" to="/sources/new">Connect a source</Link></div>
        </div>
      ) : (
        <form className="stack-sm" onSubmit={submit} noValidate>
          <p className="muted li-small">Live Ops signs in with the source's saved key and reads the layout from the address below. Nothing is saved until you choose Import.</p>
          <div className="li-grid">
            <div className="field">
              <label htmlFor={`${id}-src`}>Source</label>
              <select id={`${id}-src`} value={sourceId} onChange={(e) => change(setSourceId)(e.target.value)}>
                {apiSources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-path`}>Path</label>
              <input id={`${id}-path`} className="mono" value={path} onChange={(e) => change(setPath)(e.target.value)}
                aria-describedby={`${id}-path-help`} autoComplete="off" spellCheck={false} />
              <span className="help" id={`${id}-path-help`}>On the source's server, for example {DEFAULT_LAYOUT_PATH}.</span>
            </div>
            <div className="field">
              <label htmlFor={`${id}-fmt`}>Format</label>
              <select id={`${id}-fmt`} value={format} onChange={(e) => change(setFormat)(e.target.value as LayoutImportFormat)}>
                {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
          </div>
          <fieldset className="li-mode">
            <legend>Your current layout</legend>
            <label><input type="radio" name={`${id}-mode`} value="merge" checked={mode === "merge"} onChange={() => change(setMode)("merge")} />
              {" "}Merge: keep zones, entrances and floors you added yourself</label>
            <label><input type="radio" name={`${id}-mode`} value="replace" checked={mode === "replace"} onChange={() => change(setMode)("replace")} />
              {" "}Replace: use only the imported floors and zones</label>
          </fieldset>
          <details className="li-more">
            <summary>More options</summary>
            <div className="field">
              <label htmlFor={`${id}-root`}>Where the layout is in the response</label>
              <input id={`${id}-root`} className="mono" value={root} onChange={(e) => change(setRoot)(e.target.value)}
                placeholder="data.layout" aria-describedby={`${id}-root-help`} autoComplete="off" spellCheck={false} />
              <span className="help" id={`${id}-root-help`}>Dotted path, if the layout sits inside the response. Leave empty to use the whole response.</span>
            </div>
          </details>
          <div className="row-actions">
            <button type="submit" className="btn" disabled={!!busy || !sourceId}>{busy === "preview" ? "Reading…" : "Preview"}</button>
            <button type="button" className="btn primary" disabled={!!busy || !preview || blocked || preview.saved}
              onClick={() => void run(false)} title={!preview ? "Preview first" : undefined}>
              {busy === "import" ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      )}

      {error && <ErrorNotice error={error.err} title={error.saving ? "The layout was not imported" : "Couldn't read the layout"} />}
      {done && <div className="notice info" role="status">{done}</div>}

      {s && preview && !preview.saved && (
        <div className="li-preview stack-sm" role="region" aria-label="Import preview">
          <p className="li-summary">
            <strong>{FORMAT_NAMES[s.format] ?? s.format}</strong>: {plural(s.floors, "floor")}, {plural(s.zones, "zone")}
            {s.zones ? ` (${describeKinds(s.zones_by_kind)})` : ""}, {plural(s.beds, "bed")}.
            {mode === "merge" && s.kept_zones > 0 && ` Keeps ${plural(s.kept_zones, "zone")} you added.`}
            {s.removed_zones > 0 && ` Removes ${plural(s.removed_zones, "zone")} ${mode === "merge" ? "the source no longer has" : "from your current layout"}.`}
          </p>
          {s.problems.length > 0 && (
            <div className="notice bad" role="alert">
              This layout can't be saved yet. Fix these first:
              <ul className="problems">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {s.warnings.length > 0 && (
            <div className="notice warn">
              {plural(s.warnings.length, "thing", "things")} to check:
              <ul className="problems">{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          <div className="li-thumbs">
            {floorsOfResult(preview.layout).map(({ floor, zones }) => <FloorThumb key={floor.id} floor={floor} zones={zones} />)}
          </div>
        </div>
      )}
    </section>
  );
}
