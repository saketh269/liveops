// Side panels of the layout editor (LIVEOPS-97): floors, the floor plan image,
// the selected zone (kind and doors) and entrances. Pure UI: every change goes
// back through callbacks; the editor owns the model.
import { useId, useRef, useState } from "react";
import type { Entrance, Floor, FloorPlan, Zone, ZoneKind } from "../api/types";
import { MAX_FLOOR, MIN_FLOOR, clamp } from "./geometry";
import { DEFAULT_PLAN_OPACITY, ZONE_KINDS, ZONE_KIND_LABELS, planOpacity } from "./floors";
import { ENTRANCE_LABELS, edgeNames } from "./layoutModel";
import { polygonBounds, type Pt, type Rect } from "./placement";

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Number input that reports only finite values. */
function Num({ id, label, value, onChange, min, max, step = 0.5 }: {
  id: string; label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" min={min} max={max} step={step} value={r1(value)}
        onChange={(e) => { const n = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(n)) onChange(n); }} />
    </div>
  );
}

export function FloorsPanel({ floors, current, onPick, onAdd, onMove, onDelete, onPatch }: {
  floors: readonly Floor[];
  current: Floor;
  onPick: (id: string) => void;
  onAdd: () => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onPatch: (p: Partial<Floor>) => void;
}) {
  const uid = useId();
  const top = floors[floors.length - 1]?.id;
  const bottom = floors[0]?.id;
  return (
    <section className="panel lm-panel" aria-labelledby={`${uid}-h`}>
      <div className="lm-details-head">
        <h2 id={`${uid}-h`}>Floors <span className="muted mono lm-total">{floors.length}</span></h2>
        <button type="button" className="btn" onClick={onAdd}>Add floor</button>
      </div>
      <ul className="lm-floor-list" aria-label="Floors, top floor first">
        {[...floors].reverse().map((f) => (
          <li key={f.id} className="lm-floor-item">
            <button type="button" className={`lm-link ${f.id === current.id ? "lm-link--active" : ""}`}
              aria-pressed={f.id === current.id} onClick={() => onPick(f.id)}>
              {f.name.trim() || <em>unnamed</em>}
            </button>
            {floors.length > 1 && (
              <span className="lm-floor-tools">
                <button type="button" className="btn lm-icon-btn" disabled={f.id === top} onClick={() => onMove(f.id, 1)}
                  aria-label={`Move ${f.name || "floor"} up`} title="Move up">↑</button>
                <button type="button" className="btn lm-icon-btn" disabled={f.id === bottom} onClick={() => onMove(f.id, -1)}
                  aria-label={`Move ${f.name || "floor"} down`} title="Move down">↓</button>
                <button type="button" className="btn lm-icon-btn lm-danger" onClick={() => onDelete(f.id)}
                  aria-label={`Delete ${f.name || "floor"}`} title="Delete floor">×</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="lm-zone-form">
        <div className="field">
          <label htmlFor={`${uid}-name`}>Floor name</label>
          <input id={`${uid}-name`} value={current.name} onChange={(e) => onPatch({ name: e.target.value })} />
          <span className="help">Assets can name their floor with this name or the id <span className="mono">{current.id}</span>.</span>
        </div>
        <div className="lm-row">
          <Num id={`${uid}-w`} label="Width" value={current.width} min={MIN_FLOOR} max={MAX_FLOOR} step={1}
            onChange={(n) => onPatch({ width: clamp(n, MIN_FLOOR, MAX_FLOOR) })} />
          <Num id={`${uid}-d`} label="Depth" value={current.depth} min={MIN_FLOOR} max={MAX_FLOOR} step={1}
            onChange={(n) => onPatch({ depth: clamp(n, MIN_FLOOR, MAX_FLOOR) })} />
        </div>
      </div>
    </section>
  );
}

export function PlanPanel({ floor, busy, error, onUpload, onPatch, onFit, onRemove }: {
  floor: Floor;
  busy: boolean;
  error: string | null;
  onUpload: (file: File) => void;
  onPatch: (p: Partial<FloorPlan>) => void;
  onFit: () => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const plan = floor.plan;
  const opacity = plan ? planOpacity(plan) : DEFAULT_PLAN_OPACITY;
  return (
    <section className="panel lm-panel" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Floor plan</h2>
      <p className="muted lm-small lm-tight">
        {plan
          ? "Draw zones over the plan. Move or scale it with the numbers below."
          : "Upload a drawing of this floor (PNG, JPEG, WebP or PDF, up to 20 MB) and draw zones over it. For a PDF, the first page is used."}
      </p>
      <input ref={fileRef} id={`${uid}-file`} className="lm-sr" type="file" tabIndex={-1} aria-label="Floor plan file" accept="image/png,image/jpeg,image/webp,application/pdf,.pdf"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onUpload(f); }} />
      <div className="lm-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Uploading…" : plan ? "Replace plan" : "Upload plan"}
        </button>
        {plan && <button type="button" className="btn" onClick={onFit}>Fit to floor</button>}
        {plan && <button type="button" className="btn lm-danger" onClick={onRemove}>Remove plan</button>}
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {plan && (
        <div className="lm-zone-form">
          <div className="lm-row">
            <Num id={`${uid}-x`} label="X" value={plan.x} onChange={(x) => onPatch({ x })} />
            <Num id={`${uid}-y`} label="Y" value={plan.y} onChange={(y) => onPatch({ y })} />
            <Num id={`${uid}-w`} label="Width" value={plan.w} min={0.5} onChange={(w) => onPatch({ w })} />
            <Num id={`${uid}-h2`} label="Depth" value={plan.h} min={0.5} onChange={(h) => onPatch({ h })} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-o`}>Opacity <span className="muted mono">{Math.round(opacity * 100)}%</span></label>
            <input id={`${uid}-o`} type="range" min={0.1} max={1} step={0.05} value={opacity}
              onChange={(e) => onPatch({ opacity: Number(e.target.value) })} />
          </div>
        </div>
      )}
    </section>
  );
}

export function ZoneForm({ zone, bounds, onPatch, onBounds, onAddDoor, onRemoveDoor, onDelete }: {
  zone: Zone;
  bounds: Rect;
  onPatch: (p: Partial<Zone>) => void;
  onBounds: (r: Rect) => void;
  onAddDoor: (edge: number) => void;
  onRemoveDoor: (i: number) => void;
  onDelete: () => void;
}) {
  const uid = useId();
  const edges = edgeNames(zone.polygon);
  const [edge, setEdge] = useState(Math.min(2, edges.length - 1)); // bottom edge of a rectangle
  const doors = zone.doors ?? [];
  const doorName = (p: Pt) => {
    const b = polygonBounds(zone.polygon);
    const eps = 0.05;
    if (Math.abs(p[1] - b.y) < eps) return "top";
    if (Math.abs(p[1] - (b.y + b.h)) < eps) return "bottom";
    if (Math.abs(p[0] - b.x) < eps) return "left";
    if (Math.abs(p[0] - (b.x + b.w)) < eps) return "right";
    return "edge";
  };
  return (
    <div className="lm-zone-form">
      <div className="field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} value={zone.name} onChange={(e) => onPatch({ name: e.target.value })} />
        <span className="help">Assets whose zone field equals this name (or the id <span className="mono">{zone.id}</span>) are placed here.</span>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-kind`}>Kind</label>
        <select id={`${uid}-kind`} value={zone.kind ?? ""}
          onChange={(e) => onPatch({ kind: (e.target.value || undefined) as ZoneKind | undefined })}>
          <option value="">Not set</option>
          {ZONE_KINDS.map((k) => <option key={k} value={k}>{ZONE_KIND_LABELS[k]}</option>)}
        </select>
        {zone.kind === "corridor" && <span className="help">People walk through corridors between rooms.</span>}
      </div>
      <div className="lm-row">
        {(["x", "y", "w", "h"] as const).map((key) => (
          <Num key={key} id={`${uid}-${key}`} label={{ x: "X", y: "Y", w: "Width", h: "Depth" }[key]} value={bounds[key]}
            onChange={(n) => onBounds({ ...bounds, [key]: n })} />
        ))}
      </div>
      <fieldset className="lm-fieldset">
        <legend>Doors <span className="muted mono lm-total">{doors.length}</span></legend>
        {doors.length === 0 && <p className="muted lm-small lm-tight">No doors: people enter at the edge nearest to where they come from.</p>}
        <ul className="lm-zone-list">
          {doors.map((d, i) => (
            <li key={`${d[0]},${d[1]}`} className="lm-floor-item">
              <span>Door on the {doorName(d)} edge <span className="muted mono">{r1(d[0])}, {r1(d[1])}</span></span>
              <button type="button" className="btn lm-icon-btn lm-danger" onClick={() => onRemoveDoor(i)}
                aria-label={`Remove door at ${r1(d[0])}, ${r1(d[1])}`} title="Remove door">×</button>
            </li>
          ))}
        </ul>
        <div className="lm-door-add">
          <label className="lm-sr" htmlFor={`${uid}-edge`}>Edge for the new door</label>
          <select id={`${uid}-edge`} value={edge} onChange={(e) => setEdge(Number(e.target.value))}>
            {edges.map((name, i) => <option key={i} value={i}>{name} edge</option>)}
          </select>
          <button type="button" className="btn" onClick={() => onAddDoor(Math.min(edge, edges.length - 1))}>Add door</button>
        </div>
      </fieldset>
      <button type="button" className="btn lm-danger" onClick={onDelete}>Delete zone</button>
    </div>
  );
}

export function EntrancesPanel({ floor, entrances, selected, onSelect, onAdd, onPatch, onDelete }: {
  floor: Floor;
  entrances: readonly Entrance[];
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: (kind: Entrance["kind"]) => void;
  onPatch: (id: string, p: Partial<Entrance>) => void;
  onDelete: (id: string) => void;
}) {
  const uid = useId();
  const sel = entrances.find((e) => e.id === selected) ?? null;
  return (
    <section className="panel lm-panel" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Entrances <span className="muted mono lm-total">{entrances.length}</span></h2>
      {entrances.length === 0 && (
        <p className="muted lm-small lm-tight">
          None on {floor.name.trim() || "this floor"}. People walk in at the middle of the bottom edge and ambulances arrive at the
          bottom-left corner until you add your own.
        </p>
      )}
      <ul className="lm-zone-list">
        {entrances.map((e) => (
          <li key={e.id}>
            <button type="button" className={`lm-link ${e.id === selected ? "lm-link--active" : ""}`} aria-pressed={e.id === selected}
              onClick={() => onSelect(e.id)}>
              {e.name.trim() || <em>unnamed</em>} <span className="muted">· {e.kind === "walk" ? "walk-in" : "ambulance"}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="lm-actions">
        <button type="button" className="btn" onClick={() => onAdd("walk")}>Add walk-in entrance</button>
        <button type="button" className="btn" onClick={() => onAdd("ambulance")}>Add ambulance bay</button>
      </div>
      {sel && (
        <div className="lm-zone-form">
          <div className="field">
            <label htmlFor={`${uid}-name`}>Entrance name</label>
            <input id={`${uid}-name`} value={sel.name} onChange={(e) => onPatch(sel.id, { name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-kind`}>Used by</label>
            <select id={`${uid}-kind`} value={sel.kind} onChange={(e) => onPatch(sel.id, { kind: e.target.value as Entrance["kind"] })}>
              <option value="walk">{ENTRANCE_LABELS.walk}: people on foot</option>
              <option value="ambulance">{ENTRANCE_LABELS.ambulance}: ambulances and vehicles</option>
            </select>
          </div>
          <div className="lm-row">
            <Num id={`${uid}-x`} label="X" value={sel.point[0]} onChange={(x) => onPatch(sel.id, { point: [x, sel.point[1]] })} />
            <Num id={`${uid}-y`} label="Y" value={sel.point[1]} onChange={(y) => onPatch(sel.id, { point: [sel.point[0], y] })} />
          </div>
          <button type="button" className="btn lm-danger" onClick={() => onDelete(sel.id)}>Delete entrance</button>
        </div>
      )}
    </section>
  );
}
