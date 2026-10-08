// Camera rig (camera fix): free orbit / tilt / pan / zoom of the angled orthographic
// camera with mouse, trackpad, touch and keyboard. The user always wins: any input
// cancels a fly-to; following keeps the followed figure as the pivot, and a pan
// pauses following until resumed. Smooth damping and a little inertia, none of
// either with prefers-reduced-motion.
import * as THREE from "three";
import {
  DEFAULT_AZIMUTH, DEFAULT_POLAR, ORBIT, angleDelta, clampPolar, clampTarget, clampView, easeFactor, followAfterInput,
  followResume, isTracking, isWheelNotch, metresPerPixel, panDelta, readWheel, viewDirection, wrapAngle, yawAround, zoomTowards,
  type CameraBounds, type CameraInputKind, type CameraView, type FollowState,
} from "./camera";

/** What the HUD needs to draw the compass and the "Resume tracking" button. */
export type CameraState = { azimuth: number; polar: number; zoom: number; following: boolean; paused: boolean };

/** Time constants (ms) of the damping: direct input, fly-to, follow. */
const TAU = { input: 60, fly: 160, follow: 110 } as const;
/** Inertia after a fling decays with this time constant (ms); slower flings stop at once. */
const INERTIA_TAU = 220;
const ROTATE_PER_PX = (2 * Math.PI) / 900; // a 900 px drag turns the floor once
const TILT_PER_PX = Math.PI / 700;
const KEY_ROTATE = Math.PI / 12;
const KEY_TILT = Math.PI / 24;
const KEY_ZOOM = 1.25;
const KEY_PAN_PX = 80;
const DOUBLE_TAP_MS = 300;
const MOUSE_LATCH_MS = 1500;

type Pointer = { x: number; y: number; type: string };
type Gesture =
  | { kind: "orbit"; pivot: THREE.Vector3 | null }
  | { kind: "pan" }
  | { kind: "touch2"; dist: number; angle: number; mid: { x: number; y: number } };

const clone = (v: CameraView): CameraView => ({ target: v.target.clone(), azimuth: v.azimuth, polar: v.polar, zoom: v.zoom });

export class CameraRig {
  /** Where the camera is now (eased) and where it is going. */
  readonly current: CameraView = { target: new THREE.Vector3(), azimuth: DEFAULT_AZIMUTH, polar: DEFAULT_POLAR, zoom: 1 };
  readonly goal: CameraView = clone(this.current);
  bounds: CameraBounds = { halfW: 20, halfD: 20, margin: 4, minZoom: ORBIT.minZoom, maxZoom: 4 };
  /** Frustum half height at zoom 1 (set by the scene when it fits the floor). */
  frameHalf = 30;
  /** Camera distance from the target (ortho: only near/far care). */
  distance = 120;
  reducedMotion = false;

  private follow: FollowState = { on: false, paused: false };
  private followPoint: THREE.Vector3 | null = null;
  private flying = false;
  private pointers = new Map<number, Pointer>();
  private gesture: Gesture | null = null;
  private velocity = { az: 0, polar: 0, pan: new THREE.Vector3() };
  private lastMove = { t: 0, az: 0, polar: 0, pan: new THREE.Vector3() };
  private lastTap = { t: 0, x: 0, y: 0 };
  private mouseWheelAt = -Infinity;
  private last = performance.now();
  private listeners = new Set<(s: CameraState) => void>();
  private emitted: CameraState | null = null;
  private disposers: (() => void)[] = [];
  private tmp = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /** Called on every user gesture (the scene uses it to stop treating the view as "untouched"). */
  onUserInput: (kind: CameraInputKind) => void = () => {};

  constructor(private camera: THREE.OrthographicCamera, private el: HTMLElement, private keyTarget: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(el, "pointerdown", (e) => this.pointerDown(e));
    on(el, "pointermove", (e) => this.pointerMove(e));
    on(el, "pointerup", (e) => this.pointerUp(e));
    on(el, "pointercancel", (e) => this.pointerUp(e));
    on(el, "wheel", (e) => this.wheel(e), { passive: false });
    on(el, "contextmenu", (e) => e.preventDefault());
    on(el, "dblclick", (e) => { if (!this.pointers.size) this.zoomAt(1.6, e.clientX, e.clientY); });
    on(keyTarget, "keydown", (e) => this.key(e));
    // Safari reports a trackpad pinch as gesture events, not ctrl+wheel.
    let gs = 1;
    const gStart = (e: Event) => { e.preventDefault(); gs = 1; };
    const gChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const s = ge.scale ?? 1;
      if (s > 0) this.zoomAt(s / gs, ge.clientX ?? NaN, ge.clientY ?? NaN);
      gs = s;
    };
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    this.disposers.push(() => { el.removeEventListener("gesturestart", gStart); el.removeEventListener("gesturechange", gChange); });
  }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.listeners.clear();
  }

  // ---- state for the HUD ---------------------------------------------------

  subscribe(fn: (s: CameraState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => { this.listeners.delete(fn); };
  }

  state(): CameraState {
    return { azimuth: this.current.azimuth, polar: this.current.polar, zoom: this.current.zoom, following: this.follow.on, paused: this.follow.paused };
  }

  private emit() {
    const s = this.state();
    const e = this.emitted;
    if (e && Math.abs(angleDelta(e.azimuth, s.azimuth)) < 1e-3 && Math.abs(e.polar - s.polar) < 1e-3 && Math.abs(e.zoom - s.zoom) < 1e-3
      && e.following === s.following && e.paused === s.paused) return;
    this.emitted = s;
    for (const fn of this.listeners) fn(s);
  }

  // ---- programmatic moves --------------------------------------------------

  /** Jump to a view (no easing): framing a floor, reset. */
  jumpTo(v: Partial<CameraView>) {
    this.stopMotion();
    if (v.target) this.goal.target.copy(v.target);
    if (v.azimuth !== undefined) this.goal.azimuth = v.azimuth;
    if (v.polar !== undefined) this.goal.polar = v.polar;
    if (v.zoom !== undefined) this.goal.zoom = v.zoom;
    clampView(this.goal, this.bounds);
    Object.assign(this.current, clone(this.goal));
    this.flying = false;
    this.apply();
  }

  /** Ease towards a target and zoom (selection, KPI tiles, panels). Reduced motion: jump. */
  flyTo(target: THREE.Vector3, zoom: number) {
    this.stopMotion();
    this.goal.target.copy(target);
    this.goal.zoom = zoom;
    clampView(this.goal, this.bounds);
    this.flying = true;
    if (this.reducedMotion) this.jumpTo({});
  }

  get isFlying(): boolean { return this.flying; }

  /** Buttons and keys: rotate (yaw) by `radians` around the target. */
  rotateBy(radians: number) { this.userInput("orbit"); this.goal.azimuth += radians; this.settle(); }
  /** Buttons and keys: tilt by `radians` (positive: towards the horizon). */
  tiltBy(radians: number) { this.userInput("tilt"); this.goal.polar = clampPolar(this.goal.polar + radians); this.settle(); }
  /** Buttons and keys: zoom by `factor` (> 1 zooms in) around the centre of the view. */
  zoomBy(factor: number) { this.userInput("zoom"); this.goal.zoom *= factor; this.settle(); }
  /** Turn so that north (layout "up", world -Z) points up on screen. */
  faceNorth() { this.userInput("orbit"); this.goal.azimuth = this.nearestTurn(0); this.settle(); }
  /** Pan the view by screen pixels (keys; drag uses the same math). */
  panBy(dxPx: number, dyPx: number) {
    this.userInput("pan");
    const d = panDelta(this.goal.azimuth, this.goal.polar, this.mpp(), dxPx, dyPx);
    this.goal.target.add(d);
    this.settle();
  }

  // ---- follow ----------------------------------------------------------------

  setFollowing(on: boolean) {
    if (on === this.follow.on) return;
    this.follow = { on, paused: false };
    if (!on) this.followPoint = null;
    this.emit();
  }

  /** Where the followed figure is now (world); null when it is gone. */
  setFollowPoint(p: THREE.Vector3 | null) {
    if (!p) { this.followPoint = null; return; }
    (this.followPoint ??= new THREE.Vector3()).copy(p);
  }

  /** Stop moving with the figure until resumed (reset, or the user looked away). */
  pauseFollow() {
    const before = this.follow;
    this.follow = followAfterInput(this.follow, "pan");
    if (before !== this.follow) this.emit();
  }

  /** "Resume tracking": back on the figure after a pan. */
  resumeFollow() {
    this.follow = followResume(this.follow);
    this.emit();
  }

  get tracking(): boolean { return isTracking(this.follow); }

  // ---- frame -----------------------------------------------------------------

  /** Advance easing, inertia and follow; write the camera. Call once per frame. */
  update(now = performance.now()) {
    const dt = Math.min(100, Math.max(0, now - this.last));
    this.last = now;
    // Inertia (released fling).
    if (!this.reducedMotion && !this.pointers.size) {
      const v = this.velocity;
      if (v.az || v.polar || v.pan.lengthSq()) {
        this.goal.azimuth += v.az * dt;
        this.goal.polar = clampPolar(this.goal.polar + v.polar * dt);
        this.goal.target.addScaledVector(v.pan, dt);
        const k = Math.exp(-dt / INERTIA_TAU);
        v.az *= k; v.polar *= k; v.pan.multiplyScalar(k);
        if (Math.abs(v.az) < 1e-6 && Math.abs(v.polar) < 1e-6 && v.pan.lengthSq() < 1e-10) this.stopMotion();
        clampView(this.goal, this.bounds);
      }
    }
    if (this.tracking && this.followPoint) {
      this.goal.target.copy(this.followPoint);
      clampTarget(this.goal.target, this.bounds);
    }
    const tau = this.reducedMotion ? 0 : this.flying ? TAU.fly : this.tracking ? TAU.follow : TAU.input;
    const k = easeFactor(dt, tau);
    const c = this.current, g = this.goal;
    c.target.lerp(g.target, k);
    c.azimuth += (g.azimuth - c.azimuth) * k;
    c.polar += (g.polar - c.polar) * k;
    c.zoom += (g.zoom - c.zoom) * k;
    if (c.target.distanceToSquared(g.target) < 1e-6 && Math.abs(g.azimuth - c.azimuth) < 1e-5 && Math.abs(g.polar - c.polar) < 1e-5 && Math.abs(g.zoom - c.zoom) < 1e-5) {
      Object.assign(c, { azimuth: g.azimuth, polar: g.polar, zoom: g.zoom });
      c.target.copy(g.target);
      this.flying = false;
    }
    // Keep angles small without a visible jump.
    if (Math.abs(g.azimuth) > 4 * Math.PI) {
      const w = wrapAngle(g.azimuth) - g.azimuth;
      g.azimuth += w; c.azimuth += w;
    }
    this.apply();
  }

  /** Write the current view into the Three.js camera. */
  private apply() {
    const c = this.current;
    viewDirection(c.azimuth, c.polar, this.tmp).multiplyScalar(this.distance).add(c.target);
    this.camera.position.copy(this.tmp);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(c.target);
    if (this.camera.zoom !== c.zoom) {
      this.camera.zoom = c.zoom;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.emit();
  }

  // ---- input -----------------------------------------------------------------

  private mpp(): number {
    return metresPerPixel(this.frameHalf, this.goal.zoom, this.el.clientHeight || this.el.getBoundingClientRect().height);
  }

  /** User input wins: cancel a fly-to, pause following on a pan. */
  private userInput(kind: CameraInputKind) {
    if (this.flying) {
      // Stop where the camera is now, not where it was going.
      this.goal.target.copy(this.current.target);
      this.goal.zoom = this.current.zoom;
      this.flying = false;
    }
    const before = this.follow;
    this.follow = followAfterInput(this.follow, kind);
    if (before !== this.follow) this.emit();
    this.onUserInput(kind);
  }

  private settle() {
    clampView(this.goal, this.bounds);
    if (this.reducedMotion) { Object.assign(this.current, clone(this.goal)); this.apply(); }
  }

  private stopMotion() {
    this.velocity.az = 0; this.velocity.polar = 0; this.velocity.pan.set(0, 0, 0);
  }

  /** `angle` + k·2π closest to the current azimuth (no spinning the long way round). */
  private nearestTurn(angle: number): number {
    return this.goal.azimuth + angleDelta(this.goal.azimuth, angle);
  }

  /** Floor point (world, y = 0) under client coordinates, using the goal view; null off-canvas or parallel. */
  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    // Use a camera posed at the goal so consecutive events agree while easing.
    const cam = this.camera.clone();
    const g = this.goal;
    cam.zoom = g.zoom;
    cam.position.copy(viewDirection(g.azimuth, g.polar, new THREE.Vector3()).multiplyScalar(this.distance).add(g.target));
    cam.up.set(0, 1, 0);
    cam.lookAt(g.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, cam);
    const hit = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    return hit ? clampTarget(hit, this.bounds) : null;
  }

  /** Zoom by `factor` keeping the floor point under the cursor in place (while tracking: around the figure). */
  zoomAt(factor: number, clientX: number, clientY: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.userInput("zoom");
    const anchor = this.tracking ? null : this.groundAt(clientX, clientY);
    const z = zoomTowards(this.goal.target, this.goal.zoom, factor, anchor, this.bounds);
    this.goal.target.copy(z.target);
    this.goal.zoom = z.zoom;
    this.settle();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const now = performance.now();
    if (isWheelNotch(e)) this.mouseWheelAt = now;
    const intent = readWheel(e, now - this.mouseWheelAt < MOUSE_LATCH_MS);
    if (intent.kind === "zoom") this.zoomAt(intent.factor, e.clientX, e.clientY);
    else this.panBy(-intent.dx, -intent.dy); // scrolling moves the view like a page: content goes the other way
  }

  private pointerDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.stopMotion();
    this.lastMove = { t: performance.now(), az: 0, polar: 0, pan: new THREE.Vector3() };
    if (this.pointers.size === 1) {
      const panMode = e.pointerType === "mouse" && (e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey);
      this.gesture = panMode ? { kind: "pan" } : { kind: "orbit", pivot: this.tracking ? null : this.groundAt(e.clientX, e.clientY) };
      if (e.pointerType === "touch") this.doubleTap(e);
    } else if (this.pointers.size === 2) {
      this.gesture = this.twoFinger();
    }
  }

  private doubleTap(e: PointerEvent) {
    const now = performance.now();
    if (now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30) {
      this.zoomAt(1.6, e.clientX, e.clientY);
      this.lastTap.t = 0;
    } else {
      this.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }

  private twoFinger(): Gesture {
    const [a, b] = [...this.pointers.values()];
    return { kind: "touch2", dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private pointerMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.gesture) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (!dx && !dy) return;
    const g = this.gesture;
    const now = performance.now();
    if (g.kind === "orbit") {
      const dAz = -dx * ROTATE_PER_PX, dPolar = -dy * TILT_PER_PX;
      this.userInput(Math.abs(dx) >= Math.abs(dy) ? "orbit" : "tilt");
      const pivot = this.tracking ? null : g.pivot;
      this.goal.target.copy(yawAround(this.goal.target, pivot, dAz));
      this.goal.azimuth += dAz;
      this.goal.polar = clampPolar(this.goal.polar + dPolar);
      this.track(now, dAz, dPolar, null);
    } else if (g.kind === "pan") {
      this.userInput("pan");
      const d = panDelta(this.goal.azimuth, this.goal.polar, this.mpp(), dx, dy);
      this.goal.target.add(d);
      this.track(now, 0, 0, d);
    } else if (this.pointers.size >= 2) {
      const n = this.twoFinger();
      if (n.kind !== "touch2") return;
      if (g.dist > 0 && n.dist > 0) this.zoomAt(n.dist / g.dist, n.mid.x, n.mid.y);
      const twist = angleDelta(g.angle, n.angle);
      if (Math.abs(twist) > 1e-4) { this.userInput("orbit"); this.goal.azimuth -= twist; }
      const mx = n.mid.x - g.mid.x, my = n.mid.y - g.mid.y;
      if (mx || my) {
        this.userInput("pan");
        this.goal.target.add(panDelta(this.goal.azimuth, this.goal.polar, this.mpp(), mx, my));
      }
      this.gesture = n;
    }
    this.settle();
  }

  /** Remember the latest drag speed for inertia. */
  private track(now: number, dAz: number, dPolar: number, pan: THREE.Vector3 | null) {
    const dt = Math.max(8, now - this.lastMove.t);
    this.lastMove = { t: now, az: dAz / dt, polar: dPolar / dt, pan: pan ? pan.clone().divideScalar(dt) : new THREE.Vector3() };
  }

  private pointerUp(e: PointerEvent) {
    if (!this.pointers.delete(e.pointerId)) return;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (this.pointers.size === 1) {
      // One finger left after a pinch: continue as an orbit from where it is.
      const [rest] = [...this.pointers.values()];
      this.gesture = { kind: "orbit", pivot: this.tracking ? null : this.groundAt(rest.x, rest.y) };
      return;
    }
    if (this.pointers.size) return;
    this.gesture = null;
    // Fling: only if the pointer was still moving when released.
    if (!this.reducedMotion && performance.now() - this.lastMove.t < 60) {
      this.velocity.az = this.lastMove.az * 0.6;
      this.velocity.polar = this.lastMove.polar * 0.6;
      this.velocity.pan.copy(this.lastMove.pan).multiplyScalar(0.6);
    }
  }

  private key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target !== this.keyTarget) return; // typing in a field inside the map host
    const k = e.key;
    let handled = true;
    if (e.shiftKey && (k === "ArrowLeft" || k === "ArrowRight")) this.rotateBy(k === "ArrowLeft" ? -KEY_ROTATE : KEY_ROTATE);
    else if (e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) this.tiltBy(k === "ArrowUp" ? KEY_TILT : -KEY_TILT);
    else if (k === "ArrowLeft") this.panBy(KEY_PAN_PX, 0);
    else if (k === "ArrowRight") this.panBy(-KEY_PAN_PX, 0);
    else if (k === "ArrowUp") this.panBy(0, KEY_PAN_PX);
    else if (k === "ArrowDown") this.panBy(0, -KEY_PAN_PX);
    else if (k === "q" || k === "Q") this.rotateBy(-KEY_ROTATE);
    else if (k === "e" || k === "E") this.rotateBy(KEY_ROTATE);
    else if (k === "PageUp" || k === "w" || k === "W") this.tiltBy(KEY_TILT);
    else if (k === "PageDown" || k === "s" || k === "S") this.tiltBy(-KEY_TILT);
    else if (k === "+" || k === "=") this.zoomBy(KEY_ZOOM);
    else if (k === "-" || k === "_") this.zoomBy(1 / KEY_ZOOM);
    else if (k === "0" || k === "Home") this.onReset();
    else handled = false;
    if (handled) e.preventDefault();
  }

  /** 0 / Home: the scene frames the floor from the default angle. */
  onReset: () => void = () => {};
}
