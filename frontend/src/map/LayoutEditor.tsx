import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ApiError, api } from "../api/client";
import { LayoutImport } from "../components/setup/LayoutImport";
import type { Entrance, Floor, FloorPlan, Site, Zone } from "../api/types";
import { EntrancesPanel, FloorsPanel, PlanPanel, ZoneForm } from "./EditorPanels";
import { FloorPlanImage } from "./FloorPlanImage";
import {
  MIN_ZONE, clamp, nextZoneName, rectFromDrag, rectToPolygon, resizePolygon, setBounds, snap, translatePolygon, uniqueZoneId,
  type Handle,
} from "./geometry";
import { DEFAULT_PLAN_OPACITY, fitPlan, planAssetIds, planView } from "./floors";
import {
  addEntrance, addFloor, deleteFloor, doorClick, edgeMidpoint, fromEditModel, moveFloor, patchFloor, reshapeZone, toEditModel,
  validateModel, type EditModel,
} from "./layoutModel";
import { polygonBounds, polygonCentroid, type Pt } from "./placement";

type Drag =
  | { mode: "create"; start: Pt; cur: Pt }
  | { mode: "move"; id: string; start: Pt; orig: Pt[]; origDoors?: Pt[] }
  | { mode: "resize"; id: string; handle: Handle; orig: Pt[]; origDoors?: Pt[] }
  | { mode: "entrance"; id: string };

type Selection = { type: "zone" | "entrance"; id: string } | null;
type Props = { site: Site; onSaved: (s: Site) => void; onClose: () => void; initialFloorId?: string };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Top-down editor for floors, plan images, zones, doors and entrances. Saves `layout` via PUT /api/sites/{id}. */
export default function LayoutEditor({ site, onSaved, onClose, initialFloorId }: Props) {
  const [model, setModel] = useState<EditModel>(() => toEditModel(site.layout));
  const [floorId, setFloorId] = useState(() =>
    model.floors.some((f) => f.id === initialFloorId) ? initialFloorId! : model.floors[0].id);
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [doorMode, setDoorMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string; items?: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [importing, setImporting] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  // Plan images: those the saved layout uses, and those uploaded in this session.
  // Images nothing refers to any more are deleted on save (or on leaving without saving).
  const savedPlans = useRef(planAssetIds(site.layout));
  const uploaded = useRef(new Set<string>());
  const planSizes = useRef(new Map<string, [number, number]>());

  useEffect(() => () => {
    for (const id of uploaded.current) if (!savedPlans.current.has(id)) void api.deletePlan(site.id, id).catch(() => undefined);
  }, [site.id]);

  const floor: Floor = model.floors.find((f) => f.id === floorId) ?? model.floors[0];
  const { width, depth } = floor;
  const zones = model.zones.filter((z) => z.floor_id === floor.id);
  const entrances = model.entrances.filter((e) => e.floor_id === floor.id);
  const selZone = selection?.type === "zone" ? zones.find((z) => z.id === selection.id) ?? null : null;
  const selEntrance = selection?.type === "entrance" ? entrances.find((e) => e.id === selection.id) ?? null : null;
  const plan = planView(site.id, floor);

  const edit = (fn: (m: EditModel) => EditModel) => {
    setModel(fn);
    setDirty(true);
    setMessage(null);
  };
  const patchZone = (id: string, p: Partial<Zone>) => edit((m) => ({ ...m, zones: m.zones.map((z) => (z.id === id ? { ...z, ...p } : z)) }));
  const patchEntrance = (id: string, p: Partial<Entrance>) =>
    edit((m) => ({ ...m, entrances: m.entrances.map((e) => (e.id === id ? { ...e, ...p } : e)) }));
  const patchPlan = (p: Partial<FloorPlan>) => edit((m) => {
    const f = m.floors.find((x) => x.id === floor.id);
    return f?.plan ? patchFloor(m, floor.id, { plan: { ...f.plan, ...p } }) : m;
  });
  const reshape = (z: Zone, polygon: Pt[]) => patchZone(z.id, reshapeZone(z, polygon));

  const pickFloor = (id: string) => {
    setFloorId(id);
    setSelection(null);
    setDrag(null);
  };

  const toLayout = (e: { clientX: number; clientY: number }, step = 0.5): Pt => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [snap(p.x, step), snap(p.y, step)];
  };

  const hs = Math.max(width, depth) / 70; // handle / marker size in layout units

  const onDown = (e: PointerEvent<SVGElement>, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    setDrag(d);
  };

  const onCanvasDown = (e: PointerEvent<SVGSVGElement>) => {
    if (doorMode) {
      const r = doorClick(zones, toLayout(e, 0.1), hs * 1.5);
      if (r) {
        patchZone(r.zoneId, { doors: r.doors });
        setSelection({ type: "zone", id: r.zoneId });
      }
      return;
    }
    const p = toLayout(e);
    onDown(e, { mode: "create", start: p, cur: p });
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = toLayout(e);
    if (drag.mode === "create") setDrag({ ...drag, cur: p });
    else if (drag.mode === "entrance") patchEntrance(drag.id, { point: [clamp(p[0], 0, width), clamp(p[1], 0, depth)] });
    else {
      const base = { ...zones.find((z) => z.id === drag.id)!, polygon: drag.orig, doors: drag.origDoors };
      const poly = drag.mode === "move"
        ? translatePolygon(drag.orig, p[0] - drag.start[0], p[1] - drag.start[1], width, depth)
        : resizePolygon(drag.orig, drag.handle, p[0], p[1], width, depth);
      patchZone(drag.id, reshapeZone(base, poly));
    }
  };

  const onUp = () => {
    if (drag?.mode === "create") {
      const r = rectFromDrag(drag.start, drag.cur, width, depth);
      if (r.w >= MIN_ZONE && r.h >= MIN_ZONE) addZoneAt(r);
      else setSelection(null);
    }
    setDrag(null);
  };

  const addZoneAt = (r: { x: number; y: number; w: number; h: number }) => {
    const id = uniqueZoneId(model.zones);
    edit((m) => ({ ...m, zones: [...m.zones, { id, name: nextZoneName(m.zones), polygon: rectToPolygon(r), floor_id: floor.id }] }));
    setSelection({ type: "zone", id });
  };
  const addZone = () => {
    const w = Math.min(20, width / 2);
    const h = Math.min(12, depth / 2);
    addZoneAt({ x: snap((width - w) / 2), y: snap((depth - h) / 2), w, h });
  };
  const removeZone = (id: string) => {
    edit((m) => ({ ...m, zones: m.zones.filter((z) => z.id !== id) }));
    setSelection(null);
  };
  const removeEntrance = (id: string) => {
    edit((m) => ({ ...m, entrances: m.entrances.filter((e) => e.id !== id) }));
    setSelection(null);
  };

  const arrow = (e: KeyboardEvent): Pt | null => {
    const step = e.shiftKey ? 5 : 1;
    const d: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    return d[e.key] ?? null;
  };
  const onZoneKey = (e: KeyboardEvent, z: Zone) => {
    const d = arrow(e);
    if (d) {
      e.preventDefault();
      setSelection({ type: "zone", id: z.id });
      reshape(z, translatePolygon(z.polygon, d[0], d[1], width, depth));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeZone(z.id);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelection({ type: "zone", id: z.id });
    }
  };
  const onEntranceKey = (e: KeyboardEvent, en: Entrance) => {
    const d = arrow(e);
    if (d) {
      e.preventDefault();
      setSelection({ type: "entrance", id: en.id });
      patchEntrance(en.id, { point: [clamp(en.point[0] + d[0], 0, width), clamp(en.point[1] + d[1], 0, depth)] });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeEntrance(en.id);
    }
  };

  const onDeleteFloor = (id: string) => {
    const f = model.floors.find((x) => x.id === id);
    if (!f) return;
    const nz = model.zones.filter((z) => z.floor_id === id).length;
    const ne = model.entrances.filter((e) => e.floor_id === id).length;
    const parts = [nz ? plural(nz, "zone") : "", ne ? plural(ne, "entrance") : "", f.plan ? "its plan" : ""].filter(Boolean);
    const what = parts.length ? ` with ${parts.join(", ")}` : "";
    if (!window.confirm(`Delete ${f.name.trim() || "this floor"}${what}? Assets on it will show on the first floor until you save a layout that has their floor.`)) return;
    edit((m) => deleteFloor(m, id));
    if (id === floor.id) pickFloor(model.floors.find((x) => x.id !== id)!.id);
  };

  const upload = async (file: File) => {
    setUploading(true);
    setPlanError(null);
    try {
      const res = await api.uploadPlan(site.id, file);
      uploaded.current.add(res.asset_id);
      planSizes.current.set(res.asset_id, [res.width_px, res.height_px]);
      const target = floor.id;
      edit((m) => {
        const f = m.floors.find((x) => x.id === target)!;
        const opacity = f.plan?.opacity ?? DEFAULT_PLAN_OPACITY;
        return patchFloor(m, target, { plan: { asset_id: res.asset_id, ...fitPlan(f, res.width_px, res.height_px), opacity } });
      });
    } catch (e) {
      const err = e as ApiError;
      setPlanError(`Could not upload ${file.name}: ${err.message}.${err.hint ? ` ${err.hint}` : ""}`);
    } finally {
      setUploading(false);
    }
  };
  const fitToFloor = () => {
    const p = floor.plan;
    if (!p) return;
    const [w, h] = planSizes.current.get(p.asset_id) ?? [p.w, p.h];
    patchPlan(fitPlan(floor, w, h));
  };
  const removePlan = () => edit((m) => patchFloor(m, floor.id, { plan: undefined }));

  const save = async () => {
    const problems = validateModel(model);
    if (problems.length) {
      setMessage({ kind: "bad", text: "The layout was not saved. Fix these first:", items: problems });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const layout = fromEditModel(site.layout, model);
      const updated = await api.updateSite(site.id, { layout });
      const keep = planAssetIds(layout);
      for (const id of new Set([...savedPlans.current, ...uploaded.current])) {
        if (!keep.has(id)) void api.deletePlan(site.id, id).catch(() => undefined);
      }
      savedPlans.current = keep;
      uploaded.current = new Set();
      setDirty(false);
      const nf = model.floors.length;
      setMessage({
        kind: "ok",
        text: nf > 1
          ? `Layout saved: ${plural(model.zones.length, "zone")} on ${nf} floors.`
          : `Layout saved: ${plural(model.zones.length, "zone")}, floor ${width} × ${depth}.`,
      });
      onSaved(updated);
    } catch (e) {
      const err = e as ApiError;
      const hint = err.hint ? ` ${err.hint}` : " Check that the backend is running and try again.";
      setMessage({ kind: "bad", text: `Could not save the layout: ${err.message}.${hint}`, items: err.problems });
    } finally {
      setSaving(false);
    }
  };

  // Import saves on the server; show the result here and on the map (ADR 0007).
  const onImported = (updated: Site) => {
    const m = toEditModel(updated.layout);
    setModel(m);
    setDirty(false);
    setSelection(null);
    setDrag(null);
    if (!m.floors.some((f) => f.id === floorId)) setFloorId(m.floors[0].id);
    const keep = planAssetIds(updated.layout);
    for (const id of new Set([...savedPlans.current, ...uploaded.current])) {
      if (!keep.has(id)) void api.deletePlan(site.id, id).catch(() => undefined);
    }
    savedPlans.current = keep;
    uploaded.current = new Set();
    onSaved(updated);
  };

  const cancel = () => {
    if (dirty && !window.confirm("Discard your layout changes?")) return;
    onClose();
  };

  const preview = drag?.mode === "create" ? rectFromDrag(drag.start, drag.cur, width, depth) : null;
  const selBounds = selZone ? polygonBounds(selZone.polygon) : null;
  const handles: [Handle, number, number][] = selBounds && !doorMode
    ? [["nw", selBounds.x, selBounds.y], ["ne", selBounds.x + selBounds.w, selBounds.y], ["sw", selBounds.x, selBounds.y + selBounds.h], ["se", selBounds.x + selBounds.w, selBounds.y + selBounds.h]]
    : [];
  const many = model.floors.length > 1;

  return (
    <div className="lm-editor">
      <div className="lm-editor-canvas panel">
        <div className="lm-details-head lm-wrap">
          <h2 className="lm-editor-title">{many ? floor.name.trim() || "Unnamed floor" : "Floor"}</h2>
          <div className="lm-actions">
            <button type="button" className="btn" onClick={addZone}>Add zone</button>
            <button type="button" className={`btn ${doorMode ? "primary" : ""}`} aria-pressed={doorMode}
              onClick={() => { setDoorMode((v) => !v); setDrag(null); }}>
              {doorMode ? "Done placing doors" : "Place doors"}
            </button>
          </div>
        </div>
        <p className="muted lm-small" id="lm-editor-help">
          {doorMode
            ? "Click a zone's edge to add a door there; click a door to remove it. Doors are where people enter the zone."
            : "Drag on empty floor to draw a zone. Drag a zone to move it, drag its corners to resize. With the keyboard: Tab to a zone or entrance, arrow keys move it (Shift for 5), Delete removes it."}
        </p>
        <svg
          ref={svgRef}
          className={`lm-svg lm-editor-svg ${plan ? "lm-editor-svg--plan" : ""} ${doorMode ? "lm-editor-svg--doors" : ""}`}
          viewBox={`-1 -1 ${width + 2} ${depth + 2}`}
          aria-describedby="lm-editor-help"
          onPointerDown={onCanvasDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)}
        >
          <rect className="lm-floor" x={0} y={0} width={width} height={depth} />
          {plan && <FloorPlanImage plan={plan} />}
          {zones.map((z, i) => {
            const [cx, cy] = polygonCentroid(z.polygon);
            const isSel = z.id === selZone?.id;
            return (
              <g key={z.id}>
                <polygon
                  className={`lm-zone lm-zone--edit ${i % 2 ? "lm-zone--alt" : ""} ${z.kind === "corridor" ? "lm-zone--corridor" : ""} ${isSel ? "lm-zone--sel" : ""}`}
                  points={z.polygon.map((p) => p.join(",")).join(" ")}
                  style={z.color ? { fill: z.color } : undefined}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSel}
                  aria-label={`Zone ${z.name || z.id}${z.doors?.length ? `, ${plural(z.doors.length, "door")}` : ""}`}
                  onPointerDown={(e) => {
                    if (doorMode) return; // the canvas handles door clicks
                    setSelection({ type: "zone", id: z.id });
                    onDown(e, { mode: "move", id: z.id, start: toLayout(e), orig: z.polygon, origDoors: z.doors });
                  }}
                  onKeyDown={(e) => onZoneKey(e, z)}
                  onFocus={() => setSelection({ type: "zone", id: z.id })}
                />
                <text className="lm-zone-text" x={cx} y={cy}>{z.name || z.id}</text>
                {(z.doors ?? []).map(([x, y]) => (
                  <rect key={`${x},${y}`} className="lm-door" x={x - hs * 0.45} y={y - hs * 0.45} width={hs * 0.9} height={hs * 0.9} aria-hidden="true" />
                ))}
              </g>
            );
          })}
          {selZone && handles.map(([h, x, y]) => (
            <rect
              key={h}
              className="lm-handle"
              x={x - hs / 2}
              y={y - hs / 2}
              width={hs}
              height={hs}
              aria-hidden="true"
              onPointerDown={(e) => onDown(e, { mode: "resize", id: selZone.id, handle: h, orig: selZone.polygon, origDoors: selZone.doors })}
            />
          ))}
          {entrances.map((en) => (
            <g key={en.id} className={`lm-entrance lm-entrance--${en.kind} ${en.id === selEntrance?.id ? "lm-entrance--sel" : ""}`}>
              <circle
                cx={en.point[0]}
                cy={en.point[1]}
                r={hs * 0.8}
                tabIndex={0}
                role="button"
                aria-pressed={en.id === selEntrance?.id}
                aria-label={`${en.kind === "walk" ? "Walk-in entrance" : "Ambulance bay"} ${en.name}`}
                onPointerDown={(e) => {
                  if (doorMode) return;
                  setSelection({ type: "entrance", id: en.id });
                  onDown(e, { mode: "entrance", id: en.id });
                }}
                onKeyDown={(e) => onEntranceKey(e, en)}
                onFocus={() => setSelection({ type: "entrance", id: en.id })}
              />
              <text className="lm-entrance-text" x={en.point[0]} y={en.point[1] - hs * 1.3}
                // keep the label on the floor when the entrance is near a side edge
                textAnchor={en.point[0] < width * 0.15 ? "start" : en.point[0] > width * 0.85 ? "end" : "middle"}>
                {en.name}
              </text>
            </g>
          ))}
          {preview && <rect className="lm-draft" x={preview.x} y={preview.y} width={preview.w} height={preview.h} />}
        </svg>
      </div>

      <aside className="lm-editor-side">
        <section className="panel lm-panel">
          {importing ? (
            <LayoutImport
              site={site}
              onImported={onImported}
              onClose={() => setImporting(false)}
              confirmImport={() => !dirty || window.confirm("Importing saves the layout from the source. Your unsaved changes here will be lost. Continue?")}
            />
          ) : (
            <button type="button" className="btn" onClick={() => setImporting(true)}>Import layout from a source</button>
          )}
        </section>
        <FloorsPanel
          floors={model.floors}
          current={floor}
          onPick={pickFloor}
          onAdd={() => {
            const r = addFloor(model);
            edit(() => r.model);
            pickFloor(r.id);
          }}
          onMove={(id, dir) => edit((m) => moveFloor(m, id, dir))}
          onDelete={onDeleteFloor}
          onPatch={(p) => edit((m) => patchFloor(m, floor.id, p))}
        />
        <PlanPanel
          floor={floor}
          busy={uploading}
          error={planError}
          onUpload={(f) => void upload(f)}
          onPatch={patchPlan}
          onFit={fitToFloor}
          onRemove={removePlan}
        />

        <section className="panel lm-panel" aria-labelledby="lm-zones-h">
          <div className="lm-details-head">
            <h2 id="lm-zones-h">Zones <span className="muted mono lm-total">{zones.length}</span></h2>
          </div>
          {zones.length === 0 && <p className="muted">No zones on this floor yet. Draw one on the floor or use Add zone.</p>}
          <ul className="lm-zone-list">
            {zones.map((z) => (
              <li key={z.id}>
                <button type="button" className={`lm-link ${z.id === selZone?.id ? "lm-link--active" : ""}`} aria-pressed={z.id === selZone?.id}
                  onClick={() => setSelection({ type: "zone", id: z.id })}>
                  {z.name || <em>unnamed</em>} <span className="muted mono">{z.id}</span>
                </button>
              </li>
            ))}
          </ul>
          {selZone && selBounds && (
            <ZoneForm
              key={selZone.id}
              zone={selZone}
              bounds={selBounds}
              onPatch={(p) => patchZone(selZone.id, p)}
              onBounds={(r) => reshape(selZone, setBounds(selZone.polygon, r, width, depth))}
              onAddDoor={(edge) => {
                const p = edgeMidpoint(selZone.polygon, edge);
                const doors = selZone.doors ?? [];
                if (!doors.some((d) => d[0] === p[0] && d[1] === p[1])) patchZone(selZone.id, { doors: [...doors, p] });
              }}
              onRemoveDoor={(i) => patchZone(selZone.id, { doors: (selZone.doors ?? []).filter((_, j) => j !== i) })}
              onDelete={() => removeZone(selZone.id)}
            />
          )}
        </section>

        <EntrancesPanel
          floor={floor}
          entrances={entrances}
          selected={selEntrance?.id ?? null}
          onSelect={(id) => setSelection({ type: "entrance", id })}
          onAdd={(kind) => {
            const r = addEntrance(model, floor.id, kind);
            edit(() => r.model);
            setSelection({ type: "entrance", id: r.id });
          }}
          onPatch={patchEntrance}
          onDelete={removeEntrance}
        />

        {message && (
          <div className={`notice ${message.kind === "ok" ? "info" : "bad"}`} role={message.kind === "ok" ? "status" : "alert"}>
            {message.text}
            {message.items && message.items.length > 0 && <ul>{message.items.map((m) => <li key={m}>{m}</li>)}</ul>}
          </div>
        )}
        <div className="lm-actions">
          <button type="button" className="btn primary" onClick={save} disabled={saving || uploading}>{saving ? "Saving…" : "Save layout"}</button>
          <button type="button" className="btn" onClick={cancel} disabled={saving}>{dirty ? "Cancel" : "Back to live map"}</button>
        </div>
      </aside>
    </div>
  );
}
