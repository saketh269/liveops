import { useEffect, useMemo, useReducer, useRef } from "react";
import { navFloorOf } from "./navigation";
import type { TrackHost } from "./track/RouteOverlay";
import { wallPlanFor } from "./world/wallPlan";
import "./map2d.css";
import type { Asset, SiteLayout } from "../api/types";
import { FloorPlanImage } from "./FloorPlanImage";
import type { PlanView } from "./floors";
import { FigureGlyph } from "./FigureGlyph";
import { FIGURE_LABELS, type BodyPose } from "./figures";
import { Motion, type FigureState } from "./motion";
import { floorSize, PlacementCache, polygonCentroid } from "./placement";
import { onThemeChange, stateKey } from "./stateColors";
import { currentPalette } from "./world/style";
import { roomStates, tintFor } from "./world/tint";
// --- camera fix ---
import CameraControls from "./hud/CameraControls";
import { useView2D } from "./view2d";
// --- end camera fix ---
import type { Zone } from "../api/types";
import { zoneLabel } from "./labels"; // --- polish fix ---

type Props = {
  layout: SiteLayout;
  assets: ReadonlyMap<string, Asset>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null, x: number, y: number) => void;
  reason?: string;
  /** Floor plan image drawn over the zone fills, under assets. */
  plan?: PlanView | null;
  /** False (?motion=off) makes every change jump instead of walking. */
  motion?: boolean;
  /** False until the first snapshot arrived; that snapshot is placed without movement. */
  ready?: boolean;
  /** Removed records still walking out, with their final data. */
  onDeparting?: (assets: Map<string, Asset>) => void;
  /** camera fix: HUD slot for the camera controls; absent: drawn on the map. */
  controlsHost?: HTMLElement | null;
  /** Keep the selected figure in view as it moves (tracking). */
  follow?: boolean;
  /** The camera's Follow button: start or stop tracking the selection. Absent: no Follow button. */
  onFollow?: () => void;
  /** Gets point projection and figure positions for the route and trail overlay while the view is up. */
  onTrackHost?: (host: TrackHost | null) => void;
};

const STACK = 0.15;

/** Zone name size (SVG units) that fits the zone's width; at most the stylesheet's 2. */
function labelSize(z: Zone, text: string): number {
  const xs = z.polygon.map((p) => p[0]);
  const w = Math.max(...xs) - Math.min(...xs);
  return Math.max(0.5, Math.min(2, (w * 0.9) / (Math.max(1, text.length) * 0.62)));
}

function transformOf(f: FigureState): string {
  const deg = (f.heading * 180) / Math.PI;
  return `translate(${f.x + f.level * STACK} ${f.y - f.level * STACK}) rotate(${deg}) scale(${f.size})`;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Top-down SVG view used when WebGL is unavailable. Same zones, positions, figures and movement as the 3D map. */
export default function Map2D({ layout, assets, selectedId, onSelect, onHover, reason, plan, motion = true, ready = true, onDeparting, controlsHost, follow = false, onFollow, onTrackHost }: Props) {
  const cache = useMemo(() => new PlacementCache(), []);
  const placement = cache.get(layout, assets.values());
  const { width, depth } = floorSize(layout);
  const u = placement.unassigned;
  const totalH = u ? u.y + u.h + 1 : depth;
  const cam = useView2D({ x: -2, y: -2, w: width + 4, h: totalH + 4 }); // camera fix: pan, zoom, rotate

  // Motion state lives outside React; walkers are moved by writing transforms directly.
  const engine = useMemo(() => new Motion(), []);
  const [reduced, setReduced] = useReducer((_: boolean, v: boolean) => v, false, prefersReducedMotion);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Room tint (ADR 0007), same palette as the 3D view; follows the app theme.
  const [palette, setPalette] = useReducer((_: ReturnType<typeof currentPalette>, v: ReturnType<typeof currentPalette>) => v, undefined, currentPalette);
  useEffect(() => onThemeChange(() => setPalette(currentPalette())), []);
  const rooms = roomStates(layout.zones ?? [], assets.values());
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
  // The same walls as the 3D view and navigation (world/wallPlan): rooms with door gaps, building walls with entrances.
  const walls = useMemo(() => wallPlanFor(navFloorOf(layout)), [layout]);

  // Route and trail overlay (map/track): layout point → page point, and where a figure is drawn now.
  const hostRef = useRef(onTrackHost);
  hostRef.current = onTrackHost;
  useEffect(() => {
    const host: TrackHost = {
      screenOfPoint: (x, y) => {
        const m = cam.groupRef.current?.getScreenCTM?.();
        if (!m) return null;
        const p = new DOMPoint(x, y).matrixTransform(m);
        return { x: p.x, y: p.y };
      },
      positionOf: (id) => {
        const f = engine.get(id);
        return f ? { x: f.x, y: f.y, moving: engine.isMoving(id), leaving: f.leaving } : null;
      },
    };
    hostRef.current?.(host);
    return () => hostRef.current?.(null);
  }, [engine, cam.groupRef]);

  // Following: the view glides onto the selected figure and keeps it in the middle while it walks.
  const following = follow && !!selectedId;
  const { setFollowing, followTo } = cam;
  useEffect(() => { setFollowing(following); }, [setFollowing, following]);
  useEffect(() => {
    if (!following || !selectedId) return;
    let raf = requestAnimationFrame(function tick() {
      const f = engine.get(selectedId);
      if (f && !f.leaving) followTo(f.x, f.y);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [following, selectedId, engine, followTo]);

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
        ref={cam.svgRef}
        className="lm-svg lm-svg--cam lm-svg--walls"
        viewBox={cam.viewBox}
        role="img"
        aria-label={`Top view of the site floor, ${width} by ${depth}, with ${assets.size} assets`}
        onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
      >
        <g ref={cam.groupRef} transform={cam.contentTransform}>{/* camera fix: rotation */}
        <rect className="lm-floor" x={0} y={0} width={width} height={depth} />
        {(layout.zones ?? []).map((z, i) => {
          if (!(z.polygon?.length >= 3)) return null;
          const tint = z.kind === "room" ? tintFor(rooms.get(z.id), palette) : null;
          const style = tint
            ? { fill: tint.color, fillOpacity: 0.2 + tint.strength * 0.75 }
            : z.kind === "corridor" ? { fill: palette.corridor } : z.color ? { fill: z.color } : undefined;
          return (
            <polygon
              key={z.id}
              className={`lm-zone ${i % 2 ? "lm-zone--alt" : ""}`}
              data-zone={z.id}
              data-room-state={tint ? rooms.get(z.id) ?? "none" : undefined}
              points={z.polygon.map((p) => p.join(",")).join(" ")}
              style={style}
            />
          );
        })}
        {plan && <FloorPlanImage plan={plan} />}
        <g className="lm-2d-walls" aria-hidden="true">
          {walls.inner.map((w, i) => <line key={`i${i}`} className="lm-2d-wall" x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} />)}
          {walls.outer.map((w, i) => <line key={`o${i}`} className="lm-2d-wall lm-2d-wall--outer" x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} />)}
        </g>
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
            {/* models (LIVEOPS-109): pose is optional until placement sets it */}
            <FigureGlyph model={f.model} pose={(f as { pose?: BodyPose }).pose} id={f.id} state={f.asset.state} />
          </g>
        ))}
        {/* Labels last so assets never hide them. */}
        {(layout.zones ?? []).map((z) =>
          z.polygon?.length >= 3 && z.kind !== "corridor" ? (
            <text key={z.id} className="lm-zone-text" x={polygonCentroid(z.polygon)[0]} y={polygonCentroid(z.polygon)[1]} style={{ fontSize: labelSize(z, zoneLabel(z.name || z.id)) }}>{zoneLabel(z.name || z.id)}</text> /* --- polish fix: humanized zone names --- */
          ) : null,
        )}
        </g>
      </svg>
      <CameraControls camera={cam.handle} host={controlsHost}
        follow={onFollow ? { on: following, enabled: !!selectedId, toggle: onFollow } : undefined} />{/* camera fix */}
    </div>
  );
}
