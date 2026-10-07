import { useEffect, useMemo, useReducer, useRef } from "react";
import type { Asset, SiteLayout } from "../api/types";
import { FigureGlyph } from "./FigureGlyph";
import { FIGURE_LABELS } from "./figures";
import { Motion, type FigureState } from "./motion";
import { floorSize, PlacementCache, polygonCentroid } from "./placement";
import { stateKey } from "./stateColors";

type Props = {
  layout: SiteLayout;
  assets: ReadonlyMap<string, Asset>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null, x: number, y: number) => void;
  reason?: string;
  /** False (?motion=off) makes every change jump instead of walking. */
  motion?: boolean;
  /** False until the first snapshot arrived; that snapshot is placed without movement. */
  ready?: boolean;
  /** Removed records still walking out, with their final data. */
  onDeparting?: (assets: Map<string, Asset>) => void;
};

const STACK = 0.15;

function transformOf(f: FigureState): string {
  const deg = (f.heading * 180) / Math.PI;
  return `translate(${f.x + f.level * STACK} ${f.y - f.level * STACK}) rotate(${deg}) scale(${f.size})`;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Top-down SVG view used when WebGL is unavailable. Same zones, positions, figures and movement as the 3D map. */
export default function Map2D({ layout, assets, selectedId, onSelect, onHover, reason, motion = true, ready = true, onDeparting }: Props) {
  const cache = useMemo(() => new PlacementCache(), []);
  const placement = cache.get(layout, assets.values());
  const { width, depth } = floorSize(layout);
  const u = placement.unassigned;
  const totalH = u ? u.y + u.h + 1 : depth;

  // Motion state lives outside React; walkers are moved by writing transforms directly.
  const engine = useMemo(() => new Motion(), []);
  const [reduced, setReduced] = useReducer((_: boolean, v: boolean) => v, false, prefersReducedMotion);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const els = useRef(new Map<string, SVGGElement>());
  const departingSeen = useRef(0);
  const cb = useRef(onDeparting);
  cb.current = onDeparting;
  engine.setEnabled(motion && !reduced);
  engine.setLayout(layout);
  // The first snapshot is placed instantly: no mass walk-in.
  const primed = useRef(false);
  engine.update(assets, placement, !primed.current);
  if (ready) primed.current = true;
  const figures = [...engine.all()];

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // After every render: report departures and run the walk loop while anyone is moving.
  useEffect(() => {
    const report = () => {
      if (engine.departingVersion === departingSeen.current) return;
      departingSeen.current = engine.departingVersion;
      cb.current?.(engine.departing());
    };
    report();
    if (!engine.walkerCount) return;
    let raf = requestAnimationFrame(function tick() {
      const { moved, finished } = engine.step();
      for (const id of moved) {
        const f = engine.get(id);
        const el = els.current.get(id);
        if (f && el) el.setAttribute("transform", transformOf(f));
      }
      if (finished) { report(); rerender(); return; }
      if (engine.walkerCount) raf = requestAnimationFrame(tick);
      else rerender(); // landed: resting heading and stack level
    });
    return () => cancelAnimationFrame(raf);
  });

  return (
    <div className="lm-viewport lm-viewport--2d">
      {reason && <p className="lm-fallback-note muted">2D view: {reason}</p>}
      <svg
        className="lm-svg"
        viewBox={`-2 -2 ${width + 4} ${totalH + 4}`}
        role="img"
        aria-label={`Top view of the site floor, ${width} by ${depth}, with ${assets.size} assets`}
        onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
      >
        <rect className="lm-floor" x={0} y={0} width={width} height={depth} />
        {(layout.zones ?? []).map((z, i) =>
          z.polygon?.length >= 3 ? (
            <polygon
              key={z.id}
              className={`lm-zone ${i % 2 ? "lm-zone--alt" : ""}`}
              points={z.polygon.map((p) => p.join(",")).join(" ")}
              style={z.color ? { fill: z.color } : undefined}
            />
          ) : null,
        )}
        {u && (
          <g>
            <rect className="lm-unassigned" x={u.x} y={u.y} width={u.w} height={u.h} />
            <text className="lm-zone-text lm-zone-text--start" x={u.x + 0.5} y={u.y - 1}>Unassigned (zone not in layout)</text>
          </g>
        )}
        {figures.map((f) => (
          <g
            key={f.id}
            ref={(el) => { if (el) els.current.set(f.id, el); else els.current.delete(f.id); }}
            data-asset={f.id}
            data-figure={f.model}
            className={`lm-asset lm-s-${stateKey(f.asset.state)} ${f.id === selectedId ? "lm-asset--sel" : ""} ${f.leaving ? "lm-asset--leaving" : ""}`}
            transform={transformOf(f)}
            onClick={(e) => { e.stopPropagation(); onSelect(f.id); }}
            onPointerEnter={(e) => onHover(f.id, e.clientX, e.clientY)}
            onPointerLeave={(e) => onHover(null, e.clientX, e.clientY)}
          >
            <title>{FIGURE_LABELS[f.model]}</title>
            <FigureGlyph model={f.model} />
          </g>
        ))}
        {/* Labels last so assets never hide them. */}
        {(layout.zones ?? []).map((z) =>
          z.polygon?.length >= 3 ? (
            <text key={z.id} className="lm-zone-text" x={polygonCentroid(z.polygon)[0]} y={polygonCentroid(z.polygon)[1]}>{z.name || z.id}</text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
