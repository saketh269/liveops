// Imperative Three.js scene for the live map. Loaded lazily by LiveMapPage so
// three.js is only downloaded when the map is opened.
import * as THREE from "three";
import type { Asset, SiteLayout } from "../api/types";
import { FloorPlanLayer } from "./floorPlanLayer";
import type { PlanView } from "./floors";
import { FigureLayer, type LayerEntry } from "./figureLayer";
import { figureOf } from "./figures";
import { APPROACH_DISTANCE, Motion } from "./motion";
import { floorSize, polygonBounds, polygonCentroid, type PlacementResult, type Rect } from "./placement";
import { STATE_KEYS, onThemeChange, readStateColors, readToken, stateKey, type StateKey } from "./stateColors";
import { buildWorld, type BuiltWorld } from "./world/build";
// --- camera fix ---
import { DEFAULT_AZIMUTH, DEFAULT_POLAR, FOCUS_ZOOM, boundsFor, fitOrtho, frameZoomFor, maxZoomFor, minZoomFor, viewDirection, zoomToFit, type CameraReadout, type MapCamera } from "./world/camera";
import { CameraRig, type CameraState } from "./world/cameraRig";
// --- end camera fix ---
import { applyLightPalette, configureRenderer, createLights, fitSun, type Lights } from "./world/lighting";
import { currentPalette, type ScenePalette } from "./world/style";
import { GLOW_MS, glowAt, isBed, newlyFree, roomStates, statesChanged, tintFor } from "./world/tint";
import type { Zone } from "../api/types";

export type SceneCallbacks = {
  onHover?: (assetId: string | null, clientX: number, clientY: number) => void;
  onSelect?: (assetId: string | null) => void;
  /** Removed records still walking out (final data kept for the details panel). */
  onDeparting?: (assets: Map<string, Asset>) => void;
};

export type SceneStats = {
  frames: number; lastFrameMs: number; renderer: string; webgl: string; software: boolean; antialias: boolean; instances: number; drawCalls: number; walkers: number;
};

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;

/** Probe the WebGL renderer name on a throwaway context (before choosing antialiasing). */
function isSoftwareRenderer(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return false;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SOFTWARE.test(name);
  } catch {
    return false;
  }
}

const PULSE_MS = 700;
/**
 * Software renderers (SwiftShader/llvmpipe) are fill-rate bound, and the angled view
 * fills more of the canvas with floor and figures than the old top view: they draw at
 * 80% resolution (upscaled, slightly soft) to keep the frame rate. GPUs draw at full.
 */
const SOFTWARE_RENDER_SCALE = 0.8;

export class MapScene implements MapCamera {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  /** Frustum half height at zoom 1 that frames the current floor. */
  private frameHalf = 30;
  private lights: Lights;
  private palette: ScenePalette = currentPalette();
  private world: BuiltWorld | null = null;
  private roomState = new Map<string, StateKey>();
  private zoneById = new Map<string, Zone>();
  private glows = new Map<string, number>();
  private tmpColor = new THREE.Color();
  private rig: CameraRig; // camera fix: free orbit/tilt/pan/zoom (world/cameraRig.ts)
  private floor = new THREE.Group();
  private planLayer = new FloorPlanLayer(); // floor plan image (LIVEOPS-97)
  private figures = new FigureLayer((x, y, out) => this.toWorld(x, y, out));
  private assets: ReadonlyMap<string, Asset> = new Map();
  private placement: PlacementResult | null = null;
  private colors = new Map<StateKey, THREE.Color>();
  private pulses = new Map<string, number>();
  private reducedMotion: boolean;
  private motion = new Motion();
  private motionAllowed = true;
  private departingSeen = 0;
  private following = false;
  private raf = 0;
  private frames = 0;
  private lastFrameMs = 0;
  private pointer: { x: number; y: number; clientX: number; clientY: number } | null = null;
  private pointerDirty = false;
  private hovered: string | null = null;
  private selected: string | null = null;
  private down: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private selectionBox: THREE.LineSegments;
  private labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
  private layout: SiteLayout = {};
  private disposers: (() => void)[] = [];
  private tmpV = new THREE.Vector3();
  private rendererName = "unknown";
  private webglVersion = "";
  private software = false;
  private userMoved = false;

  constructor(private container: HTMLElement, private labelLayer: HTMLElement, private cb: SceneCallbacks = {}) {
    // MSAA roughly halves frame rate on software renderers (SwiftShader/llvmpipe), so it is only used on a GPU.
    this.software = isSoftwareRenderer();
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.software, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * (this.software ? SOFTWARE_RENDER_SCALE : 1));
    configureRenderer(this.renderer, this.palette, this.software);
    this.renderer.domElement.className = "lm-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(this.renderer.domElement);
    this.readRendererInfo();

    // --- camera fix --- mouse, trackpad, touch and keyboard (when the map has focus) move the camera.
    this.rig = new CameraRig(this.camera, this.renderer.domElement, container);
    this.rig.onUserInput = () => { this.userMoved = true; };
    this.rig.onReset = () => this.reset();
    // --- end camera fix ---

    this.lights = createLights(this.software);
    this.scene.add(this.lights.group);
    this.scene.add(this.floor);
    this.scene.add(this.planLayer.group);
    this.scene.add(this.figures.group);

    const boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    boxGeo.translate(0, 0.5, 0);
    this.selectionBox = new THREE.LineSegments(boxGeo, new THREE.LineBasicMaterial());
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    this.rig.reducedMotion = mq.matches;
    const onMq = () => { this.reducedMotion = mq.matches; this.rig.reducedMotion = mq.matches; this.applyMotionSetting(); };
    mq.addEventListener("change", onMq);
    this.disposers.push(() => mq.removeEventListener("change", onMq));
    this.disposers.push(onThemeChange(() => this.refreshTheme()));
    this.motion.setEnabled(this.motionAllowed && !this.reducedMotion);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.disposers.push(() => ro.disconnect());

    const el = this.renderer.domElement;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      this.pointer = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1, clientX: e.clientX, clientY: e.clientY };
      this.pointerDirty = true;
    };
    const leave = () => { this.pointer = null; this.pointerDirty = true; };
    const down = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY }; };
    const up = (e: PointerEvent) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved > 5) return;
      move(e);
      this.cb.onSelect?.(this.pick());
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    this.disposers.push(() => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
    });

    this.refreshTheme();
    this.resize();
    this.loop();
  }

  private readRendererInfo() {
    const gl = this.renderer.getContext();
    this.webglVersion = String(gl.getParameter(gl.VERSION));
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    this.rendererName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  /** layout (x, y) → world (X, Z), floor centred on the origin. */
  private toWorld(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { width, depth } = floorSize(this.layout);
    return out.set(x - width / 2, 0, y - depth / 2);
  }

  setLayout(layout: SiteLayout, unassigned: Rect | null) {
    const changed = JSON.stringify(layout) !== JSON.stringify(this.layout) || !this.floor.children.length || unassignedChanged(this.floor.userData.unassigned, unassigned);
    if (!changed) return;
    const first = !this.floor.children.length;
    if (JSON.stringify(layout) !== JSON.stringify(this.layout)) {
      this.motion.setLayout(layout); // new floor: no walking across layouts
      this.roomState = new Map();
      this.glows.clear();
    }
    this.layout = layout;
    this.zoneById = new Map((layout.zones ?? []).map((z) => [z.id, z]));
    this.floor.userData.unassigned = unassigned;
    this.buildFloor();
    if (first) this.resetCamera();
  }

  /** (Re)build the static world of the floor in the current palette. */
  private buildFloor() {
    disposeTree(this.floor);
    this.floor.clear();
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    const layout = this.layout;
    const unassigned = this.floor.userData.unassigned as Rect | null;

    const { width, depth } = floorSize(layout);
    this.planLayer.setFloor(width, depth);
    const floors = layout.floors ?? [];
    this.world = buildWorld({
      width, depth,
      zones: layout.zones ?? [],
      entrances: layout.entrances ?? [],
      // Site decoration only around the ground floor (level 0, or a layout without floors).
      ground: floors.length === 0 || Number(floors[0]?.level) === 0,
      palette: this.palette,
      software: this.software,
      fonts: { data: readToken("--f-data") || "ui-monospace, monospace", body: readToken("--f-body") || "system-ui, sans-serif" },
    });
    this.floor.add(this.world.group);
    this.scene.background = new THREE.Color(this.world.background);
    fitSun(this.lights, width, depth);
    this.renderer.shadowMap.needsUpdate = true; // static shadows: redraw once for the new world
    this.paintRooms();

    if (unassigned) {
      const u = unassigned;
      const pts = [[u.x, u.y], [u.x + u.w, u.y], [u.x + u.w, u.y + u.h], [u.x, u.y + u.h]].map(([x, y]) => this.toWorld(x, y).setY(0.03));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ dashSize: 1, gapSize: 0.6 }));
      line.computeLineDistances();
      line.userData.token = "--warn";
      this.floor.add(line);
      this.addLabel("Unassigned (zone not in layout)", this.toWorld(u.x + u.w / 2, u.y - 1).setY(0.1), "lm-zone-label lm-zone-label--warn");
    }
    this.applyTokens();
  }

  /** Tint every room tile from its bed's state (plus any running glow). */
  private paintRooms(now = performance.now()) {
    const tiles = this.world?.tiles;
    if (!tiles) return;
    for (const id of tiles.ids()) {
      const t = tintFor(this.roomState.get(id), this.palette);
      const start = this.glows.get(id);
      const g = start === undefined ? 0 : glowAt(now - start) * this.palette.glow;
      this.tmpColor.setStyle(t.color);
      tiles.set(id, this.tmpColor, Math.min(1, t.strength + g));
    }
  }

  /** Recompute room states from the beds; glow rooms that just became free. */
  private updateRooms(assets: ReadonlyMap<string, Asset>) {
    if (!this.world?.tiles.mesh) return;
    const zones = this.layout.zones ?? [];
    const beds: Asset[] = [];
    for (const a of assets.values()) if (isBed(a)) beds.push(a);
    const next = roomStates(zones, beds);
    if (!statesChanged(this.roomState, next)) return;
    if (!this.reducedMotion) {
      const now = performance.now();
      for (const id of newlyFree(this.roomState, next)) this.glows.set(id, now);
    }
    this.roomState = next;
    this.paintRooms();
  }

  private addLabel(text: string, pos: THREE.Vector3, cls: string) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.labels.push({ el, pos });
  }

  // --- camera fix --- framing, buttons and fly-to go through the camera rig.
  /** Frame the floor (and the Unassigned strip) from the default angle, fitted to the viewport aspect. */
  resetCamera() {
    this.frameFloor(false);
  }

  /**
   * Frame the whole floor. `keepAngle` (switching floors, "whole floor" tiles) keeps the
   * user's rotation and tilt and zooms so the floor fits from that angle.
   */
  frameFloor(keepAngle = true) {
    const { width, depth } = floorSize(this.layout);
    const extra = this.placement?.unassigned ? this.placement.unassigned.h + 4 : 0;
    const dist = Math.max(120, Math.max(width, depth) * 2);
    this.camera.near = 0.1;
    this.camera.far = dist * 4;
    this.rig.distance = dist;
    this.fitFrustum();
    const azimuth = keepAngle ? this.rig.goal.azimuth : DEFAULT_AZIMUTH;
    const polar = keepAngle ? this.rig.goal.polar : DEFAULT_POLAR;
    const zoom = keepAngle ? Math.min(1, frameZoomFor(width, depth + extra, this.aspect(), viewDirection(azimuth, polar))) : 1;
    this.rig.jumpTo({ target: new THREE.Vector3(0, 0, extra / 2), azimuth, polar, zoom });
    this.userMoved = false;
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  private fitFrustum() {
    const { width, depth } = floorSize(this.layout);
    const extra = this.placement?.unassigned ? this.placement.unassigned.h + 4 : 0;
    const aspect = this.aspect();
    this.frameHalf = fitOrtho(width, depth + extra, aspect);
    this.camera.top = this.frameHalf;
    this.camera.bottom = -this.frameHalf;
    this.camera.left = -this.frameHalf * aspect;
    this.camera.right = this.frameHalf * aspect;
    this.camera.updateProjectionMatrix();
    this.rig.frameHalf = this.frameHalf;
    this.rig.bounds = boundsFor(width, depth + 2 * extra, minZoomFor(width, depth + extra, aspect), maxZoomFor(width, depth));
  }

  /** `factor` < 1 zooms in (buttons: 0.8 in, 1.25 out). */
  zoom(factor: number) {
    if (factor > 0) this.rig.zoomBy(1 / factor);
  }

  /** Turn the view by `radians` (positive: the map turns clockwise on screen). */
  rotate(radians: number) {
    this.rig.rotateBy(radians);
  }

  /** Tilt by `radians`: positive towards the horizon, negative towards a top view. */
  tilt(radians: number) {
    this.rig.tiltBy(radians);
  }

  /** Turn so north (the layout's top edge) points up. */
  faceNorth() {
    this.rig.faceNorth();
  }

  /** "Resume tracking" after the user panned away from a followed figure. */
  resumeFollow() {
    this.rig.resumeFollow();
  }

  /** Camera angles and follow state for the HUD (compass, Resume tracking). */
  onCameraChange(fn: (s: CameraState) => void): () => void {
    return this.rig.subscribe(fn);
  }

  /** Smoothly bring a layout point to the centre of the view (reduced motion: jump). */
  flyTo(point: readonly [number, number], zoom = Math.max(this.rig.goal.zoom, FOCUS_ZOOM)) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
    this.userMoved = true;
    this.rig.flyTo(this.toWorld(point[0], point[1], new THREE.Vector3()), Number.isFinite(zoom) ? zoom : FOCUS_ZOOM);
  }

  /** Fly to a zone of the current floor (e.g. a room picked in a panel), zoomed to fit it. False if it is not on this floor. */
  flyToZone(zoneId: string): boolean {
    const z = this.zoneById.get(zoneId);
    if (!z || !Array.isArray(z.polygon) || z.polygon.length < 3) return false;
    const b = polygonBounds(z.polygon);
    const { minZoom, maxZoom } = this.rig.bounds;
    this.flyTo(polygonCentroid(z.polygon), zoomToFit(this.frameHalf, this.aspect(), b.w, b.h, minZoom, maxZoom));
    return true;
  }

  /** The user's "Reset view": default framing; following (if on) pauses so the reset sticks. */
  reset() {
    this.rig.pauseFollow();
    this.resetCamera();
  }

  view(): CameraReadout {
    const { width, depth } = floorSize(this.layout);
    const c = this.rig.current;
    const r = (v: number, k: number) => Math.round(v * k) / k;
    const s = this.rig.state();
    return {
      target: [r(c.target.x + width / 2, 100), r(c.target.z + depth / 2, 100)],
      zoom: r(c.zoom, 1000),
      azimuth: r(c.azimuth, 10000),
      polar: r(c.polar, 10000),
      following: s.following,
      paused: s.paused,
    };
  }
  // --- end camera fix ---

  /**
   * Update assets. A new `placement` object rebuilds every instance; otherwise
   * only assets whose object identity changed are recoloured (and pulsed).
   * `instant` (the first snapshot) places everyone without movement.
   */
  setAssets(assets: ReadonlyMap<string, Asset>, placement: PlacementResult, instant = false) {
    const prev = this.assets;
    this.assets = assets;
    this.motion.update(assets, placement, instant);
    this.updateRooms(assets);
    this.notifyDeparting();
    if (placement !== this.placement) {
      const firstPlacement = this.placement === null;
      this.placement = placement;
      this.rebuild(prev);
      if (firstPlacement && !this.userMoved) this.resetCamera();
      return;
    }
    const now = performance.now();
    for (const [id, a] of assets) {
      const before = prev.get(id);
      if (before === a) continue;
      if (!this.figures.has(id)) continue;
      if (figureOf(a) !== this.figures.keyOf(id)) { this.rebuild(prev); return; } // role changed: different figure
      this.figures.setColor(id, this.colorFor(a));
      if (before && stateKey(before.state) !== stateKey(a.state) && !this.reducedMotion) this.pulses.set(id, now);
    }
    for (const id of this.motion.drainTouched()) this.drawFigure(id);
    this.updateSelectionBox();
  }

  /** ?motion=off: every change jumps. prefers-reduced-motion does the same. */
  setMotionAllowed(on: boolean) {
    this.motionAllowed = on;
    this.applyMotionSetting();
  }

  private applyMotionSetting() {
    const on = this.motionAllowed && !this.reducedMotion;
    if (on === this.motion.isEnabled) return;
    this.motion.setEnabled(on);
    if (this.placement) this.rebuild(this.assets);
    this.notifyDeparting();
  }

  /** Keep the camera on the selected figure while it moves. */
  setFollow(on: boolean) {
    this.following = on;
    this.rig.setFollowing(on); // camera fix
    if (on) this.userMoved = true;
  }

  private notifyDeparting() {
    if (this.motion.departingVersion === this.departingSeen) return;
    this.departingSeen = this.motion.departingVersion;
    this.cb.onDeparting?.(this.motion.departing());
  }

  private colorFor(a: Asset): THREE.Color {
    return this.colors.get(stateKey(a.state)) ?? this.colors.get("unknown")!;
  }

  private rebuild(prev: ReadonlyMap<string, Asset>) {
    const now = performance.now();
    const entries: LayerEntry[] = [];
    // Figures: current records plus removed ones still walking out.
    for (const f of this.motion.all()) {
      entries.push({ id: f.id, key: f.model, pose: f, moving: this.motion.isMoving(f.id), color: this.colorFor(f.asset) });
      const before = prev.get(f.id);
      if (before && before !== f.asset && stateKey(before.state) !== stateKey(f.asset.state) && !this.reducedMotion) this.pulses.set(f.id, now);
    }
    this.motion.drainTouched();
    this.figures.rebuild(entries, this.floorSphere());
    for (const id of this.pulses.keys()) if (!this.figures.has(id)) this.pulses.delete(id);
    this.updateSelectionBox();
  }

  private floorSphere(): THREE.Sphere {
    const { width, depth } = floorSize(this.layout);
    const u = this.placement?.unassigned;
    const r = Math.hypot(width, depth + (u ? u.h + u.y - depth : 0)) / 2 + APPROACH_DISTANCE + 4;
    return new THREE.Sphere(new THREE.Vector3(0, 0, u ? (u.y + u.h - depth) / 2 : 0), r);
  }

  /** Redraw one figure where the motion engine has it now (with its pulse, if any). */
  private drawFigure(id: string, now = performance.now()) {
    const f = this.motion.get(id);
    if (!f) return;
    const start = this.pulses.get(id);
    const p = start === undefined ? 1 : Math.min(1, (now - start) / PULSE_MS);
    this.figures.write(id, f, this.motion.isMoving(id), p >= 1 ? 1 : 1 + 0.6 * Math.sin(Math.PI * p));
  }

  setSelected(id: string | null) {
    const changed = id !== this.selected;
    this.selected = id;
    this.updateSelectionBox();
    if (changed && id && !this.following) {
      const f = this.motion.get(id);
      if (f) this.flyTo([f.x, f.y]);
    }
  }

  private updateSelectionBox() {
    const id = this.selected;
    const p = id && this.figures.has(id) ? this.motion.get(id) : undefined;
    if (!id || !p) { this.selectionBox.visible = false; return; }
    const h = this.figures.heightOf(id);
    const s = p.size * 1.35;
    this.toWorld(p.x, p.y, this.selectionBox.position).setY(p.level * h * p.size - 0.05);
    this.selectionBox.rotation.y = -p.heading;
    this.selectionBox.scale.set(s, h * p.size + 0.3, s);
    this.selectionBox.visible = true;
  }

  /** Floor plan image under the zones and assets, or null for none. */
  setPlan(plan: PlanView | null) {
    this.planLayer.setPlan(plan);
  }

  refreshTheme() {
    const p = currentPalette();
    const themeChanged = p !== this.palette;
    this.palette = p;
    configureRenderer(this.renderer, p, this.software);
    applyLightPalette(this.lights, p);
    this.scene.background = new THREE.Color(this.world?.background ?? p.sky);
    if (themeChanged && this.floor.children.length) this.buildFloor();
    else this.applyTokens();
  }

  /** UI-token colors (selection outline, Unassigned strip) and figure state colors. */
  private applyTokens() {
    this.planLayer.refreshTheme();
    const sc = readStateColors();
    for (const k of STATE_KEYS) {
      const c = this.colors.get(k) ?? new THREE.Color();
      try { c.setStyle(sc[k] || readToken("--faint") || "gray"); } catch { /* keep previous */ }
      this.colors.set(k, c);
    }
    const fg = readToken("--fg");
    if (fg) (this.selectionBox.material as THREE.LineBasicMaterial).color.setStyle(fg);
    this.floor.traverse((o) => {
      const token = o.userData.token as string | undefined;
      if (!token) return;
      const value = readToken(token);
      if (!value) return;
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        try { (m as THREE.Material & { color?: THREE.Color }).color?.setStyle(value); } catch { /* ignore */ }
      }
    });
    for (const f of this.motion.all()) this.figures.setColor(f.id, this.colorFor(f.asset));
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, true);
    this.fitFrustum();
    if (!this.userMoved && this.floor.children.length) this.resetCamera();
  }

  private pick(): string | null {
    if (!this.pointer) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(this.pointer.x, this.pointer.y), this.camera);
    return this.figures.pick(this.raycaster.ray, (id) => this.motion.get(id));
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    this.animateMotion();
    this.rig.update(t0); // camera fix: easing, inertia, follow
    if (this.pulses.size) this.animatePulses(t0);
    if (this.glows.size) this.animateGlows(t0);
    if (this.pointerDirty) {
      this.pointerDirty = false;
      const id = this.pick();
      if (id !== this.hovered || id) {
        this.hovered = id;
        this.cb.onHover?.(id, this.pointer?.clientX ?? 0, this.pointer?.clientY ?? 0);
      }
      this.renderer.domElement.style.cursor = id ? "pointer" : "";
    }
    this.figures.flush();
    this.castFigureShadows();
    this.renderer.render(this.scene, this.camera);
    this.positionLabels();
    this.frames++;
    this.lastFrameMs = performance.now() - t0;
  };

  /** Advance walking figures; only the figures that moved are rewritten. */
  private animateMotion() {
    const { moved, finished } = this.motion.step();
    if (finished) {
      this.rebuild(this.assets); // a figure finished walking out: drop it
      this.notifyDeparting();
    } else {
      const now = performance.now();
      for (const id of moved) this.drawFigure(id, now);
      for (const id of this.motion.drainTouched()) this.drawFigure(id, now);
      if (this.selected && this.motion.isMoving(this.selected)) this.updateSelectionBox();
      else if (this.selected && moved.includes(this.selected)) this.updateSelectionBox();
    }
    if (this.following) this.followSelected();
  }

  /** camera fix: the rig eases onto the followed figure unless the user panned away. */
  private followSelected() {
    const f = this.selected ? this.motion.get(this.selected) : undefined;
    this.rig.setFollowPoint(f ? this.toWorld(f.x, f.y, this.tmpV) : null);
  }

  private animateGlows(now: number) {
    for (const [id, start] of this.glows) if (now - start >= GLOW_MS) this.glows.delete(id);
    this.paintRooms(now);
  }

  /** Figures cast soft shadows on a GPU; on software renderers the extra pass costs too much. */
  private castFigureShadows() {
    const on = !this.software;
    for (const c of this.figures.group.children) if (c.castShadow !== on) c.castShadow = on;
  }

  private animatePulses(now: number) {
    for (const [id, start] of this.pulses) {
      if (!this.figures.has(id)) { this.pulses.delete(id); continue; }
      if (now - start >= PULSE_MS) this.pulses.delete(id);
      this.drawFigure(id, now);
    }
  }

  private positionLabels() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    for (const l of this.labels) {
      const v = this.tmpV.copy(l.pos).project(this.camera);
      if (v.z > 1 || v.z < -1) { l.el.style.display = "none"; continue; }
      l.el.style.display = "";
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  /** Client (page) coordinates of an asset's centre, for tests and debugging. */
  screenOf(id: string): { x: number; y: number } | null {
    const p = this.motion.get(id);
    if (!p || !this.figures.has(id)) return null;
    const h = this.figures.heightOf(id);
    const v = this.toWorld(p.x, p.y, new THREE.Vector3()).setY((p.level + 0.5) * h * p.size).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // --- track fix: project a layout point (route and trail overlay) ---
  /** Page coordinates of a layout point on the floor, or null when it is outside the camera's depth range. */
  screenOfPoint(x: number, y: number): { x: number; y: number } | null {
    const v = this.toWorld(x, y, new THREE.Vector3()).setY(0.05).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }
  // --- end track fix ---

  /** Layout position currently drawn for a figure and whether it is moving, for tests and debugging. */
  positionOf(id: string): { x: number; y: number; moving: boolean; leaving: boolean } | null {
    const f = this.motion.get(id);
    return f ? { x: f.x, y: f.y, moving: this.motion.isMoving(id), leaving: f.leaving } : null;
  }

  /** Tile color and opacity currently drawn for a room zone, for tests and debugging. */
  roomTintOf(zoneId: string): { color: string; alpha: number; state: StateKey | null } | null {
    const t = this.world?.tiles.get(zoneId);
    return t ? { ...t, state: this.roomState.get(zoneId) ?? null } : null;
  }

  /** Hex (#rrggbb, sRGB) currently drawn for an asset, for tests and debugging. */
  colorOf(id: string): string | null {
    return this.figures.colorOf(id);
  }

  stats(): SceneStats {
    const instances = this.figures.count;
    return { frames: this.frames, lastFrameMs: this.lastFrameMs, renderer: this.rendererName, webgl: this.webglVersion, software: this.software, antialias: !this.software, instances, drawCalls: this.renderer.info.render.calls, walkers: this.motion.walkerCount };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.rig.dispose(); // camera fix
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.planLayer.dispose();
    this.scene.remove(this.figures.group);
    this.figures.dispose();
    disposeTree(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function unassignedChanged(a: Rect | null | undefined, b: Rect | null): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      (x as THREE.Material & { map?: THREE.Texture | null }).map?.dispose();
      x.dispose();
    }
  });
}
