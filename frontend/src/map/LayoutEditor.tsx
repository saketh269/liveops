import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ApiError, api } from "../api/client";
import type { Site, Zone } from "../api/types";
import {
  MAX_FLOOR, MIN_FLOOR, MIN_ZONE, clamp, nextZoneName, rectFromDrag, rectToPolygon, resizePolygon, setBounds, snap,
  translatePolygon, uniqueZoneId, validateLayout, type Handle,
} from "./geometry";
import { floorSize, polygonBounds, polygonCentroid, type Pt } from "./placement";

type Drag =
  | { mode: "create"; start: Pt; cur: Pt }
  | { mode: "move"; id: string; start: Pt; orig: Pt[] }
  | { mode: "resize"; id: string; handle: Handle; orig: Pt[] };

type Props = { site: Site; onSaved: (s: Site) => void; onClose: () => void };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Top-down editor for rectangle zones. Saves `layout` via PUT /api/sites/{id}. */
export default function LayoutEditor({ site, onSaved, onClose }: Props) {
  const initial = floorSize(site.layout);
  const [width, setWidth] = useState(initial.width);
  const [depth, setDepth] = useState(initial.depth);
  const [zones, setZones] = useState<Zone[]>(() => structuredClone(site.layout?.zones ?? []));
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string; items?: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const sel = zones.find((z) => z.id === selected) ?? null;

  const edit = (fn: (zs: Zone[]) => Zone[]) => {
    setZones(fn);
    setDirty(true);
    setMessage(null);
  };
  const patch = (id: string, p: Partial<Zone>) => edit((zs) => zs.map((z) => (z.id === id ? { ...z, ...p } : z)));

  const toLayout = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [snap(p.x), snap(p.y)];
  };

  const onDown = (e: PointerEvent<SVGElement>, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag(d);
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = toLayout(e);
    if (drag.mode === "create") setDrag({ ...drag, cur: p });
    else if (drag.mode === "move") {
      const poly = translatePolygon(drag.orig, p[0] - drag.start[0], p[1] - drag.start[1], width, depth);
      patch(drag.id, { polygon: poly });
    } else {
      patch(drag.id, { polygon: resizePolygon(drag.orig, drag.handle, p[0], p[1], width, depth) });
    }
  };

  const onUp = () => {
    if (drag?.mode === "create") {
      const r = rectFromDrag(drag.start, drag.cur, width, depth);
      if (r.w >= MIN_ZONE && r.h >= MIN_ZONE) {
        const id = uniqueZoneId(zones);
        edit((zs) => [...zs, { id, name: nextZoneName(zs), polygon: rectToPolygon(r) }]);
        setSelected(id);
      } else {
        setSelected(null);
      }
    }
    setDrag(null);
  };

  const addZone = () => {
    const w = Math.min(20, width / 2);
    const h = Math.min(12, depth / 2);
    const id = uniqueZoneId(zones);
    edit((zs) => [...zs, { id, name: nextZoneName(zs), polygon: rectToPolygon({ x: snap((width - w) / 2), y: snap((depth - h) / 2), w, h }) }]);
    setSelected(id);
  };

  const remove = (id: string) => {
    edit((zs) => zs.filter((z) => z.id !== id));
    setSelected(null);
  };

  const onZoneKey = (e: KeyboardEvent, z: Zone) => {
    const step = e.shiftKey ? 5 : 1;
    const d: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) {
      e.preventDefault();
      setSelected(z.id);
      patch(z.id, { polygon: translatePolygon(z.polygon, d[e.key][0], d[e.key][1], width, depth) });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(z.id);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(z.id);
    }
  };

  const save = async () => {
    const problems = validateLayout(zones, width, depth);
    if (problems.length) {
      setMessage({ kind: "bad", text: "The layout was not saved. Fix these first:", items: problems });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const clean = zones.map((z) => ({ ...z, name: z.name.trim(), polygon: z.polygon.map(([x, y]) => [r1(x), r1(y)] as Pt) }));
      const updated = await api.updateSite(site.id, { layout: { ...site.layout, zones: clean, width, depth } });
      setDirty(false);
      setMessage({ kind: "ok", text: `Layout saved: ${clean.length} zone${clean.length === 1 ? "" : "s"}, floor ${width} × ${depth}.` });
      onSaved(updated);
    } catch (e) {
      const err = e as ApiError;
      const hint = err.hint ? ` ${err.hint}` : " Check that the backend is running and try again.";
      setMessage({ kind: "bad", text: `Could not save the layout: ${err.message}.${hint}`, items: err.problems });
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm("Discard your layout changes?")) return;
    onClose();
  };

  const preview = drag?.mode === "create" ? rectFromDrag(drag.start, drag.cur, width, depth) : null;
  const selBounds = sel ? polygonBounds(sel.polygon) : null;
  const handles: [Handle, number, number][] = selBounds
    ? [["nw", selBounds.x, selBounds.y], ["ne", selBounds.x + selBounds.w, selBounds.y], ["sw", selBounds.x, selBounds.y + selBounds.h], ["se", selBounds.x + selBounds.w, selBounds.y + selBounds.h]]
    : [];
  const hs = Math.max(width, depth) / 70;
  const setNum = (v: string, set: (n: number) => void) => {
    const n = Number(v);
    if (Number.isFinite(n)) { set(clamp(n, MIN_FLOOR, MAX_FLOOR)); setDirty(true); setMessage(null); }
  };

  return (
    <div className="lm-editor">
      <div className="lm-editor-canvas panel">
        <p className="muted lm-small" id="lm-editor-help">
          Drag on empty floor to draw a zone. Drag a zone to move it, drag its corners to resize. With the keyboard: Tab to a zone,
          arrow keys move it (Shift for 5), Delete removes it.
        </p>
        <svg
          ref={svgRef}
          className="lm-svg lm-editor-svg"
          viewBox={`-1 -1 ${width + 2} ${depth + 2}`}
          aria-describedby="lm-editor-help"
          onPointerDown={(e) => { const p = toLayout(e); onDown(e, { mode: "create", start: p, cur: p }); }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)}
        >
          <rect className="lm-floor" x={0} y={0} width={width} height={depth} />
          {zones.map((z, i) => {
            const [cx, cy] = polygonCentroid(z.polygon);
            return (
              <g key={z.id}>
                <polygon
                  className={`lm-zone lm-zone--edit ${i % 2 ? "lm-zone--alt" : ""} ${z.id === selected ? "lm-zone--sel" : ""}`}
                  points={z.polygon.map((p) => p.join(",")).join(" ")}
                  style={z.color ? { fill: z.color } : undefined}
                  tabIndex={0}
                  role="button"
                  aria-pressed={z.id === selected}
                  aria-label={`Zone ${z.name || z.id}`}
                  onPointerDown={(e) => { setSelected(z.id); onDown(e, { mode: "move", id: z.id, start: toLayout(e), orig: z.polygon }); }}
                  onKeyDown={(e) => onZoneKey(e, z)}
                  onFocus={() => setSelected(z.id)}
                />
                <text className="lm-zone-text" x={cx} y={cy}>{z.name || z.id}</text>
              </g>
            );
          })}
          {sel && handles.map(([h, x, y]) => (
            <rect
              key={h}
              className="lm-handle"
              x={x - hs / 2}
              y={y - hs / 2}
              width={hs}
              height={hs}
              aria-hidden="true"
              onPointerDown={(e) => onDown(e, { mode: "resize", id: sel.id, handle: h, orig: sel.polygon })}
            />
          ))}
          {preview && <rect className="lm-draft" x={preview.x} y={preview.y} width={preview.w} height={preview.h} />}
        </svg>
      </div>

      <aside className="lm-editor-side">
        <section className="panel lm-panel" aria-labelledby="lm-floor-h">
          <h2 id="lm-floor-h">Floor</h2>
          <div className="lm-row">
            <div className="field">
              <label htmlFor="lm-w">Width</label>
              <input id="lm-w" type="number" min={MIN_FLOOR} max={MAX_FLOOR} value={width} onChange={(e) => setNum(e.target.value, setWidth)} />
            </div>
            <div className="field">
              <label htmlFor="lm-d">Depth</label>
              <input id="lm-d" type="number" min={MIN_FLOOR} max={MAX_FLOOR} value={depth} onChange={(e) => setNum(e.target.value, setDepth)} />
            </div>
          </div>
        </section>

        <section className="panel lm-panel" aria-labelledby="lm-zones-h">
          <div className="lm-details-head">
            <h2 id="lm-zones-h">Zones <span className="muted mono lm-total">{zones.length}</span></h2>
            <button type="button" className="btn" onClick={addZone}>Add zone</button>
          </div>
          {zones.length === 0 && <p className="muted">No zones yet. Draw one on the floor or use Add zone.</p>}
          <ul className="lm-zone-list">
            {zones.map((z) => (
              <li key={z.id}>
                <button type="button" className={`lm-link ${z.id === selected ? "lm-link--active" : ""}`} aria-pressed={z.id === selected} onClick={() => setSelected(z.id)}>
                  {z.name || <em>unnamed</em>} <span className="muted mono">{z.id}</span>
                </button>
              </li>
            ))}
          </ul>
          {sel && selBounds && (
            <div className="lm-zone-form">
              <div className="field">
                <label htmlFor="lm-zname">Name</label>
                <input id="lm-zname" value={sel.name} onChange={(e) => patch(sel.id, { name: e.target.value })} />
                <span className="help">Assets whose zone field equals this name (or the id <span className="mono">{sel.id}</span>) are placed here.</span>
              </div>
              <div className="lm-row">
                {(["x", "y", "w", "h"] as const).map((key) => (
                  <div className="field" key={key}>
                    <label htmlFor={`lm-z${key}`}>{{ x: "X", y: "Y", w: "Width", h: "Depth" }[key]}</label>
                    <input
                      id={`lm-z${key}`}
                      type="number"
                      step={0.5}
                      value={r1(selBounds[key])}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) patch(sel.id, { polygon: setBounds(sel.polygon, { ...selBounds, [key]: n }, width, depth) });
                      }}
                    />
                  </div>
                ))}
              </div>
              <button type="button" className="btn lm-danger" onClick={() => remove(sel.id)}>Delete zone</button>
            </div>
          )}
        </section>

        {message && (
          <div className={`notice ${message.kind === "ok" ? "info" : "bad"}`} role={message.kind === "ok" ? "status" : "alert"}>
            {message.text}
            {message.items && message.items.length > 0 && <ul>{message.items.map((m) => <li key={m}>{m}</li>)}</ul>}
          </div>
        )}
        <div className="lm-actions">
          <button type="button" className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save layout"}</button>
          <button type="button" className="btn" onClick={cancel} disabled={saving}>{dirty ? "Cancel" : "Back to live map"}</button>
        </div>
      </aside>
    </div>
  );
}
