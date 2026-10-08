// 2D fallback camera (camera fix): drag to pan, wheel / pinch to zoom towards the
// pointer, two-finger trackpad scroll pans, and rotate / zoom / reset / face north from
// the on-screen controls. The view is applied to the SVG imperatively (viewBox and a
// rotation on the content group) so panning does not re-render every figure.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CameraControlsHandle, CameraControlsState } from "./hud/CameraControls";
import { isWheelNotch, readWheel } from "./world/camera";

/** The area the 2D view frames at zoom 1 (SVG user units = layout metres). */
export type Box2D = { x: number; y: number; w: number; h: number };
/** Centre of the view (outer SVG units), zoom (1 = whole floor) and rotation (radians, clockwise). */
export type View2D = { cx: number; cy: number; scale: number; rot: number };

export const SCALE_2D = { min: 0.6, max: 8 } as const;
/** Zoom the 2D view eases to while following a figure (the 3D focus zoom). */
export const FOLLOW_SCALE_2D = 2.2;
/** Share of the remaining distance covered per frame while following (smooth glide). */
const FOLLOW_EASE = 0.18;
const MOUSE_LATCH_MS = 1500;

export function initialView2D(b: Box2D, rot = 0): View2D {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, scale: 1, rot };
}

/** Keeps the centre over the floor (plus a quarter of it) and the zoom within limits. */
export function clampView2D(v: View2D, b: Box2D): View2D {
  const mx = b.w * 0.25, my = b.h * 0.25;
  const scale = Math.min(SCALE_2D.max, Math.max(SCALE_2D.min, Number.isFinite(v.scale) ? v.scale : 1));
  return {
    cx: Math.min(b.x + b.w + mx, Math.max(b.x - mx, Number.isFinite(v.cx) ? v.cx : b.x + b.w / 2)),
    cy: Math.min(b.y + b.h + my, Math.max(b.y - my, Number.isFinite(v.cy) ? v.cy : b.y + b.h / 2)),
    scale,
    rot: Number.isFinite(v.rot) ? v.rot : 0,
  };
}

export function viewBoxOf(v: View2D, b: Box2D): string {
  const w = b.w / v.scale, h = b.h / v.scale;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `${r(v.cx - w / 2)} ${r(v.cy - h / 2)} ${r(w)} ${r(h)}`;
}

/** SVG transform that turns the floor content around the floor's centre. */
export function rotationOf(v: View2D, b: Box2D): string {
  return `rotate(${((v.rot * 180) / Math.PI).toFixed(3)} ${b.x + b.w / 2} ${b.y + b.h / 2})`;
}

/** Zoom by `factor` (> 1 in) keeping the outer point (px, py) where it is on screen. */
export function zoom2DAt(v: View2D, b: Box2D, factor: number, px: number | null, py: number | null): View2D {
  const next = clampView2D({ ...v, scale: v.scale * factor }, b);
  const k = v.scale / next.scale;
  if (px === null || py === null) return next;
  return clampView2D({ ...next, cx: px + (v.cx - px) * k, cy: py + (v.cy - py) * k }, b);
}

/** Pan by a drag of (dx, dy) outer SVG units: the content follows the pointer. */
export function pan2D(v: View2D, b: Box2D, dx: number, dy: number): View2D {
  return clampView2D({ ...v, cx: v.cx - dx, cy: v.cy - dy }, b);
}

/** Turn the map by `radians` around the point at the centre of the view (it stays put). */
export function rotate2D(v: View2D, b: Box2D, radians: number): View2D {
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const c = Math.cos(radians), s = Math.sin(radians);
  const dx = v.cx - bx, dy = v.cy - by;
  return clampView2D({ ...v, rot: v.rot + radians, cx: bx + dx * c - dy * s, cy: by + dx * s + dy * c }, b);
}

/** Outer SVG point where content point (x, y) is drawn (the content turns around the floor's centre). */
export function outerPoint(v: View2D, b: Box2D, x: number, y: number): { x: number; y: number } {
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const c = Math.cos(v.rot), s = Math.sin(v.rot);
  const dx = x - bx, dy = y - by;
  return { x: bx + dx * c - dy * s, y: by + dx * s + dy * c };
}

/** One frame of following content point (x, y): ease the centre onto it and zoom in to at least the follow zoom. */
export function follow2D(v: View2D, b: Box2D, x: number, y: number, k = FOLLOW_EASE): View2D {
  const p = outerPoint(v, b, x, y);
  const scale = v.scale < FOLLOW_SCALE_2D ? v.scale + (FOLLOW_SCALE_2D - v.scale) * k : v.scale;
  return clampView2D({ ...v, cx: v.cx + (p.x - v.cx) * k, cy: v.cy + (p.y - v.cy) * k, scale }, b);
}

type Ptr = { x: number; y: number };

/**
 * Pan/zoom/rotate for the 2D map. Spread `svgProps` on the <svg>, put `contentTransform`
 * on the group that holds the floor, and pass `handle` to <CameraControls>.
 */
export function useView2D(base: Box2D) {
  const baseKey = `${base.x} ${base.y} ${base.w} ${base.h}`;
  const box = useMemo(() => base, [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = useRef<View2D>(initialView2D(box));
  const svg = useRef<SVGSVGElement | null>(null);
  const group = useRef<SVGGElement | null>(null);
  const listeners = useRef(new Set<(s: CameraControlsState) => void>());
  const boxRef = useRef(box);
  // track2: following a figure; a pan by the user pauses it until "Resume tracking" (as in 3D).
  const follow = useRef({ on: false, paused: false });

  const emit = () => {
    for (const fn of listeners.current) fn({ azimuth: view.current.rot, following: follow.current.on, paused: follow.current.paused });
  };
  const set = (v: View2D) => {
    view.current = clampView2D(v, boxRef.current);
    svg.current?.setAttribute("viewBox", viewBoxOf(view.current, boxRef.current));
    group.current?.setAttribute("transform", rotationOf(view.current, boxRef.current));
    emit();
  };
  const userPan = (v: View2D) => {
    if (follow.current.on && !follow.current.paused) follow.current = { on: true, paused: true };
    set(v);
  };

  // A new floor: frame it again, keeping the rotation.
  if (boxRef.current !== box) {
    boxRef.current = box;
    view.current = initialView2D(box, view.current.rot);
  }

  const handle = useMemo<CameraControlsHandle>(() => ({
    zoom: (f) => { if (f > 0) set(zoom2DAt(view.current, boxRef.current, 1 / f, null, null)); },
    rotate: (r) => set(rotate2D(view.current, boxRef.current, r)),
    faceNorth: () => set(rotate2D(view.current, boxRef.current, -view.current.rot)),
    reset: () => {
      if (follow.current.on) follow.current = { on: true, paused: true };
      set(initialView2D(boxRef.current));
    },
    resumeFollow: () => { follow.current = { on: follow.current.on, paused: false }; emit(); },
    onCameraChange: (fn) => {
      listeners.current.add(fn);
      fn({ azimuth: view.current.rot, following: follow.current.on, paused: follow.current.paused });
      return () => { listeners.current.delete(fn); };
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Turn following on or off (a new value clears a pause). */
  const setFollowing = useCallback((on: boolean) => {
    if (follow.current.on === on) return;
    follow.current = { on, paused: false };
    emit();
  }, []);
  /** One frame of following the figure at content point (x, y); no-op while paused or off. */
  const followTo = useCallback((x: number, y: number) => {
    if (!follow.current.on || follow.current.paused) return;
    const next = follow2D(view.current, boxRef.current, x, y);
    const v = view.current;
    if (Math.abs(next.cx - v.cx) < 1e-3 && Math.abs(next.cy - v.cy) < 1e-3 && Math.abs(next.scale - v.scale) < 1e-4) return;
    set(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    /** Outer SVG units per CSS pixel, and a client point in outer units. */
    const toUser = (x: number, y: number): Ptr | null => {
      const m = el.getScreenCTM?.();
      if (!m) return null;
      const p = new DOMPoint(x, y).matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    };
    const unitsPerPx = () => { const m = el.getScreenCTM?.(); return m && m.a ? 1 / m.a : 0; };
    const ptrs = new Map<number, Ptr>();
    let moved = 0;
    let mouseAt = -Infinity;
    let pinch: { d: number; mid: Ptr } | null = null;
    const pair = () => {
      const [a, b] = [...ptrs.values()];
      return { d: Math.hypot(b.x - a.x, b.y - a.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) moved = 0;
      if (ptrs.size === 2) pinch = pair();
    };
    const move = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      moved += Math.hypot(dx, dy);
      if (moved > 4 && !el.hasPointerCapture(e.pointerId)) { try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      const k = unitsPerPx();
      if (ptrs.size >= 2 && pinch) {
        const n = pair();
        const at = toUser(n.mid.x, n.mid.y);
        let v = view.current;
        if (pinch.d > 0 && n.d > 0) v = zoom2DAt(v, boxRef.current, n.d / pinch.d, at?.x ?? null, at?.y ?? null);
        v = pan2D(v, boxRef.current, (n.mid.x - pinch.mid.x) * k, (n.mid.y - pinch.mid.y) * k);
        pinch = n;
        userPan(v);
      } else if (moved > 4) {
        userPan(pan2D(view.current, boxRef.current, dx * k, dy * k));
      }
    };
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
    };
    // A drag is not a click: keep it from selecting or clearing the selection.
    const click = (e: MouseEvent) => { if (moved > 4) { e.stopPropagation(); e.preventDefault(); moved = 0; } };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (isWheelNotch(e)) mouseAt = now;
      const w = readWheel(e, now - mouseAt < MOUSE_LATCH_MS);
      if (w.kind === "zoom") {
        const at = toUser(e.clientX, e.clientY);
        set(zoom2DAt(view.current, boxRef.current, w.factor, at?.x ?? null, at?.y ?? null));
      } else {
        const k = unitsPerPx();
        userPan(pan2D(view.current, boxRef.current, -w.dx * k, -w.dy * k));
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", click, true);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
      el.removeEventListener("wheel", wheel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    handle,
    setFollowing,
    followTo,
    viewBox: viewBoxOf(view.current, box),
    contentTransform: rotationOf(view.current, box),
    svgRef: svg,
    groupRef: group,
  };
}
