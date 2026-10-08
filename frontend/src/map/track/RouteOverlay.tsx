import { useEffect, useRef, type MutableRefObject } from "react";
import type { Pt } from "../placement";
import type { Route } from "./route";
import type { TrailPoint } from "./tracking";

/** What the 3D view lends the tracker: point projection and figure positions. */
export type TrackHost = {
  /** Page coordinates of a layout point on the floor, or null when behind the camera. */
  screenOfPoint: (x: number, y: number) => { x: number; y: number } | null;
  /** Layout position the figure is drawn at now. */
  positionOf: (id: string) => { x: number; y: number; moving: boolean; leaving: boolean } | null;
};

type Props = {
  host: TrackHost | null;
  route: Route | null;
  /** Live trail behind the tracked figure (updated in place, read every frame). */
  trail: MutableRefObject<TrailPoint[]>;
  trailOn: boolean;
};

/**
 * Route and trail drawn over the 3D map in an SVG layer. Points are re-projected
 * every frame (the camera moves), written straight to the DOM.
 */
export default function RouteOverlay({ host, route, trail, trailOn }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const legs = useRef<(SVGPolylineElement | null)[]>([]);
  const stops = useRef<(SVGGElement | null)[]>([]);
  const marks = useRef<(SVGGElement | null)[]>([]);
  const trailEl = useRef<SVGPolylineElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    if (!host) return;
    let raf = 0;
    const toLocal = (r: DOMRect, p: Pt): string | null => {
      const s = host.screenOfPoint(p[0], p[1]);
      return s ? `${(s.x - r.left).toFixed(1)},${(s.y - r.top).toFixed(1)}` : null;
    };
    const place = (el: SVGGElement | null, r: DOMRect, p: Pt) => {
      if (!el) return;
      const s = host.screenOfPoint(p[0], p[1]);
      el.style.display = s ? "" : "none";
      if (s) el.setAttribute("transform", `translate(${(s.x - r.left).toFixed(1)} ${(s.y - r.top).toFixed(1)})`);
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = svg.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const rt = routeRef.current;
      rt?.legs.forEach((l, i) => {
        const pl = legs.current[i];
        if (pl) pl.setAttribute("points", l.points.map((p) => toLocal(r, p)).filter(Boolean).join(" "));
      });
      rt?.stops.forEach((s, i) => place(stops.current[i], r, s.at));
      rt?.marks.forEach((m, i) => place(marks.current[i], r, m.at));
      if (trailEl.current) {
        trailEl.current.setAttribute("points", trailOn ? trail.current.map((p) => toLocal(r, [p.x, p.y])).filter(Boolean).join(" ") : "");
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [host, trail, trailOn]);

  if (!host || (!route && !trailOn)) return null;
  return (
    <svg ref={svg} className="lm-track-overlay" aria-hidden="true">
      <defs>
        <marker id="lm-track-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="lm-track-arrowhead" />
        </marker>
      </defs>
      {route?.legs.map((l, i) => (
        <polyline key={`l${i}`} ref={(e) => { legs.current[i] = e; }} className="lm-track-leg"
          style={{ opacity: 0.25 + 0.75 * l.fade }} markerEnd="url(#lm-track-arrow)" />
      ))}
      {route?.stops.map((_s, i) => (
        <g key={`s${i}`} ref={(e) => { stops.current[i] = e; }} className="lm-track-stop">
          <circle r={i === route.stops.length - 1 ? 5 : 3.5} />
        </g>
      ))}
      {route?.marks.map((m, i) => (
        <g key={`m${i}`} ref={(e) => { marks.current[i] = e; }} className="lm-track-mark">
          <rect x={-4} y={-24} width={m.text.length * 6.4 + 22} height={18} rx={9} />
          <text x={6} y={-11}>{m.dir === "up" ? "↑" : m.dir === "down" ? "↓" : "⇄"} {m.text}</text>
        </g>
      ))}
      <polyline ref={trailEl} className="lm-track-trail" />
    </svg>
  );
}
