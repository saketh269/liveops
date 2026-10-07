// Imperative Three.js scene for the live map. Loaded lazily by LiveMapPage so
// three.js is only downloaded when the map is opened.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Asset, SiteLayout } from "../api/types";
import { figureGeometry } from "./figureGeometry";
import { figureKey, type FigureModel } from "./figures";
import { APPROACH_DISTANCE, Motion } from "./motion";
import { floorSize, polygonCentroid, type PlacementResult, type Pt, type Rect } from "./placement";
import { STATE_KEYS, onThemeChange, readStateColors, readToken, stateKey, type StateKey } from "./stateColors";

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
const UP = new THREE.Vector3(0, 1, 0);
/** How quickly the camera catches up with a followed figure (per frame, 0..1). */
const FOLLOW_EASE = 0.15;

type KindMesh = { mesh: THREE.InstancedMesh; ids: string[]; capacity: number; height: number };

/** Mesh group key → figure model (and the raw kind for the "other" fallback shapes). */
function modelOfKey(key: string): { model: FigureModel; kind: string } {
  return key.startsWith("other:") ? { model: "other", kind: key.slice(6) } : { model: key as FigureModel, kind: "" };
}

export class MapScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  private controls: OrbitControls;
  private floor = new THREE.Group();
  private meshes = new Map<string, KindMesh>();
  private index = new Map<string, { kind: string; i: number }>();
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
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpC = new THREE.Color();
  private rendererName = "unknown";
  private webglVersion = "";
  private software = false;
  private userMoved = false;

  constructor(private container: HTMLElement, private labelLayer: HTMLElement, private cb: SceneCallbacks = {}) {
    // MSAA roughly halves frame rate on software renderers (SwiftShader/llvmpipe), so it is only used on a GPU.
    this.software = isSoftwareRenderer();
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.software, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = "lm-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(this.renderer.domElement);
    this.readRendererInfo();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.screenSpacePanning = false;
    this.controls.listenToKeyEvents(container); // arrow keys pan when the map has focus
    this.controls.keyPanSpeed = 20;
    this.controls.addEventListener("start", () => { this.userMoved = true; });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(30, 80, 40);
    this.scene.add(sun);
    this.scene.add(this.floor);

    const boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    boxGeo.translate(0, 0.5, 0);
    this.selectionBox = new THREE.LineSegments(boxGeo, new THREE.LineBasicMaterial());
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    const onMq = () => { this.reducedMotion = mq.matches; this.applyMotionSetting(); };
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
  private world(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { width, depth } = floorSize(this.layout);
    return out.set(x - width / 2, 0, y - depth / 2);
  }

  private shapeFrom(poly: readonly Pt[]): THREE.Shape {
    // Shape lives in XY; rotating by -90° about X maps shape y → world -Z, so negate.
    const { width, depth } = floorSize(this.layout);
    return new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x - width / 2, -(y - depth / 2))));
  }

  setLayout(layout: SiteLayout, unassigned: Rect | null) {
    const changed = JSON.stringify(layout) !== JSON.stringify(this.layout) || !this.floor.children.length || unassignedChanged(this.floor.userData.unassigned, unassigned);
    if (!changed) return;
    const first = !this.floor.children.length;
    if (JSON.stringify(layout) !== JSON.stringify(this.layout)) this.motion.setLayout(layout); // new floor: no walking across layouts
    this.layout = layout;
    this.floor.userData.unassigned = unassigned;
    disposeTree(this.floor);
    this.floor.clear();
    for (const l of this.labels) l.el.remove();
    this.labels = [];

    const { width, depth } = floorSize(layout);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial());
    plane.rotation.x = -Math.PI / 2;
    plane.userData.token = "--panel";
    this.floor.add(plane);

    const grid = new THREE.GridHelper(1, 1);
    grid.userData.grid = true;
    this.floor.add(grid);
    this.rebuildGrid(width, depth);

    (layout.zones ?? []).forEach((z, i) => {
      if (!Array.isArray(z.polygon) || z.polygon.length < 3) return;
      const shape = this.shapeFrom(z.polygon);
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = 0.02;
      fill.userData.token = i % 2 ? "--info-soft" : "--accent-soft";
      fill.userData.color = z.color; // a zone may carry its own color from the layout data
      this.floor.add(fill);
      const pts = z.polygon.map(([x, y]) => this.world(x, y).setY(0.04));
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial());
      outline.userData.token = i % 2 ? "--info" : "--accent";
      this.floor.add(outline);
      const [cx, cy] = polygonCentroid(z.polygon);
      this.addLabel(z.name || z.id, this.world(cx, cy).setY(0.1), "lm-zone-label");
    });

    if (unassigned) {
      const u = unassigned;
      const pts = [[u.x, u.y], [u.x + u.w, u.y], [u.x + u.w, u.y + u.h], [u.x, u.y + u.h]].map(([x, y]) => this.world(x, y).setY(0.03));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ dashSize: 1, gapSize: 0.6 }));
      line.computeLineDistances();
      line.userData.token = "--warn";
      this.floor.add(line);
      this.addLabel("Unassigned (zone not in layout)", this.world(u.x + u.w / 2, u.y - 1).setY(0.1), "lm-zone-label lm-zone-label--warn");
    }
    this.refreshTheme();
    if (first) this.resetCamera();
  }

  private rebuildGrid(width: number, depth: number) {
    const old = this.floor.children.find((c) => c.userData.grid);
    if (!old) return;
    const size = Math.max(width, depth);
    const divisions = Math.min(200, Math.max(1, Math.round(size / 5)));
    const grid = new THREE.GridHelper(size, divisions);
    grid.userData.grid = true;
    grid.userData.token = "--line";
    grid.scale.set(width / size, 1, depth / size);
    grid.position.y = 0.01;
    this.floor.remove(old);
    disposeTree(old);
    this.floor.add(grid);
  }

  private addLabel(text: string, pos: THREE.Vector3, cls: string) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.labels.push({ el, pos });
  }

  /** Frame the floor (and the Unassigned strip) from a 55° elevation, fitted to the viewport aspect. */
  resetCamera() {
    const { width, depth } = floorSize(this.layout);
    const extra = this.placement?.unassigned ? this.placement.unassigned.h + 4 : 0;
    const d = depth + extra;
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // The near (front) edge looks wider under perspective, so width gets more headroom than depth.
    const dist = Math.max((d / 2 / t) * 1.1, (width / 2 / (t * this.camera.aspect)) * 1.35) + 2;
    const el = THREE.MathUtils.degToRad(55);
    this.controls.target.set(0, 0, extra / 2);
    this.camera.position.set(0, Math.sin(el) * dist, extra / 2 + Math.cos(el) * dist);
    this.camera.near = Math.max(0.1, dist / 1000);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = 2;
    this.controls.maxDistance = dist * 4;
    this.controls.update();
    this.userMoved = false;
  }

  zoom(factor: number) {
    this.userMoved = true;
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    const len = THREE.MathUtils.clamp(off.length(), this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(off.setLength(len));
    this.controls.update();
  }

  rotate(radians: number) {
    this.userMoved = true;
    const off = this.camera.position.clone().sub(this.controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
  }

  /**
   * Update assets. A new `placement` object rebuilds every instance; otherwise
   * only assets whose object identity changed are recoloured (and pulsed).
   * `instant` (the first snapshot) places everyone without movement.
   */
  setAssets(assets: ReadonlyMap<string, Asset>, placement: PlacementResult, instant = false) {
    const prev = this.assets;
    this.assets = assets;
    this.motion.update(assets, placement, instant);
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
      const at = this.index.get(id);
      if (!at) continue;
      if (figureKey(a) !== at.kind) { this.rebuild(prev); return; } // role changed: different figure
      const km = this.meshes.get(at.kind)!;
      km.mesh.setColorAt(at.i, this.colorFor(a));
      km.mesh.instanceColor!.needsUpdate = true;
      if (before && stateKey(before.state) !== stateKey(a.state) && !this.reducedMotion) this.pulses.set(id, now);
    }
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
    const groups = new Map<string, string[]>();
    // Figures: current records plus removed ones still walking out.
    for (const f of this.motion.all()) {
      const k = figureKey(f.asset);
      const g = groups.get(k);
      if (g) g.push(f.id); else groups.set(k, [f.id]);
    }
    for (const [k, km] of this.meshes) {
      if (!groups.has(k)) {
        this.scene.remove(km.mesh);
        km.mesh.geometry.dispose();
        (km.mesh.material as THREE.Material).dispose();
        km.mesh.dispose();
        this.meshes.delete(k);
      }
    }
    this.index.clear();
    const now = performance.now();
    for (const [k, ids] of groups) {
      let km = this.meshes.get(k);
      if (!km || km.capacity < ids.length) {
        const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(ids.length)));
        let geo: THREE.BufferGeometry, height: number;
        if (km) {
          geo = km.mesh.geometry; height = km.height;
          this.scene.remove(km.mesh);
          (km.mesh.material as THREE.Material).dispose();
          km.mesh.dispose();
        } else {
          const { model, kind } = modelOfKey(k);
          ({ geo, height } = figureGeometry(model, kind));
        }
        const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }), capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, this.colors.get("unknown") ?? new THREE.Color());
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.name = `assets:${k}`;
        this.scene.add(mesh);
        km = { mesh, ids: [], capacity, height };
        this.meshes.set(k, km);
      }
      km.ids = ids;
      ids.forEach((id, i) => {
        this.index.set(id, { kind: k, i });
        const a = this.motion.get(id)!.asset;
        this.writeMatrix(km!, i, id, 1);
        km!.mesh.setColorAt(i, this.colorFor(a));
        const before = prev.get(id);
        if (before && before !== a && stateKey(before.state) !== stateKey(a.state) && !this.reducedMotion) this.pulses.set(id, now);
      });
      km.mesh.count = ids.length;
      km.mesh.instanceMatrix.needsUpdate = true;
      km.mesh.instanceColor!.needsUpdate = true;
      // Figures move, so picking uses a sphere around the whole floor and its approach roads.
      km.mesh.boundingSphere = this.floorSphere();
    }
    for (const id of this.pulses.keys()) if (!this.index.has(id)) this.pulses.delete(id);
    this.updateSelectionBox();
  }

  private floorSphere(): THREE.Sphere {
    const { width, depth } = floorSize(this.layout);
    const u = this.placement?.unassigned;
    const r = Math.hypot(width, depth + (u ? u.h + u.y - depth : 0)) / 2 + APPROACH_DISTANCE + 4;
    return new THREE.Sphere(new THREE.Vector3(0, 0, u ? (u.y + u.h - depth) / 2 : 0), r);
  }

  private writeMatrix(km: KindMesh, i: number, id: string, scale: number) {
    const f = this.motion.get(id)!;
    const s = f.size;
    this.world(f.x, f.y, this.tmpV).setY(f.level * km.height * s);
    this.tmpQ.setFromAxisAngle(UP, -f.heading);
    this.tmpS.set(s * scale, s * scale, s * scale);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    km.mesh.setMatrixAt(i, this.tmpM);
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.updateSelectionBox();
  }

  private updateSelectionBox() {
    const id = this.selected;
    const at = id ? this.index.get(id) : undefined;
    const p = id ? this.motion.get(id) : undefined;
    if (!id || !at || !p) { this.selectionBox.visible = false; return; }
    const km = this.meshes.get(at.kind)!;
    const s = p.size * 1.35;
    this.world(p.x, p.y, this.selectionBox.position).setY(p.level * km.height * p.size - 0.05);
    this.selectionBox.rotation.y = -p.heading;
    this.selectionBox.scale.set(s, km.height * p.size + 0.3, s);
    this.selectionBox.visible = true;
  }

  refreshTheme() {
    const sc = readStateColors();
    for (const k of STATE_KEYS) {
      const c = this.colors.get(k) ?? new THREE.Color();
      try { c.setStyle(sc[k] || readToken("--faint") || "gray"); } catch { /* keep previous */ }
      this.colors.set(k, c);
    }
    const bg = readToken("--bg");
    if (bg) this.scene.background = new THREE.Color(bg);
    const fg = readToken("--fg");
    if (fg) (this.selectionBox.material as THREE.LineBasicMaterial).color.setStyle(fg);
    this.floor.traverse((o) => {
      const token = o.userData.token as string | undefined;
      if (!token) return;
      const value = (o.userData.color as string | undefined) || readToken(token);
      if (!value) return;
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        const cm = m as THREE.Material & { color?: THREE.Color; vertexColors?: boolean };
        if (o.userData.grid) { cm.vertexColors = false; cm.needsUpdate = true; }
        try { cm.color?.setStyle(value); } catch { /* ignore unparsable custom zone colors */ }
      }
    });
    for (const km of this.meshes.values()) {
      km.ids.forEach((id, i) => {
        const a = this.motion.get(id)?.asset;
        if (a) km.mesh.setColorAt(i, this.colorFor(a));
      });
      if (km.mesh.instanceColor) km.mesh.instanceColor.needsUpdate = true;
    }
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved && this.floor.children.length) this.resetCamera();
  }

  private pick(): string | null {
    if (!this.pointer) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(this.pointer.x, this.pointer.y), this.camera);
    let best: { d: number; id: string } | null = null;
    for (const km of this.meshes.values()) {
      const hits = this.raycaster.intersectObject(km.mesh, false);
      const h = hits[0];
      if (h && h.instanceId !== undefined && (!best || h.distance < best.d)) best = { d: h.distance, id: km.ids[h.instanceId] };
    }
    return best?.id ?? null;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    this.animateMotion();
    this.controls.update();
    if (this.pulses.size) this.animatePulses(t0);
    if (this.pointerDirty) {
      this.pointerDirty = false;
      const id = this.pick();
      if (id !== this.hovered || id) {
        this.hovered = id;
        this.cb.onHover?.(id, this.pointer?.clientX ?? 0, this.pointer?.clientY ?? 0);
      }
      this.renderer.domElement.style.cursor = id ? "pointer" : "";
    }
    this.renderer.render(this.scene, this.camera);
    this.positionLabels();
    this.frames++;
    this.lastFrameMs = performance.now() - t0;
  };

  /** Advance walking figures; only their instances are rewritten. */
  private animateMotion() {
    const { moved, finished } = this.motion.step();
    if (finished) {
      this.rebuild(this.assets); // a figure finished walking out: drop its instance
      this.notifyDeparting();
    } else if (moved.length) {
      const now = performance.now();
      const touched = new Set<KindMesh>();
      for (const id of moved) {
        const at = this.index.get(id);
        if (!at) continue;
        const km = this.meshes.get(at.kind)!;
        const start = this.pulses.get(id);
        this.writeMatrix(km, at.i, id, start === undefined ? 1 : 1 + 0.6 * Math.sin(Math.PI * Math.min(1, (now - start) / PULSE_MS)));
        touched.add(km);
      }
      for (const km of touched) km.mesh.instanceMatrix.needsUpdate = true;
      if (this.selected && moved.includes(this.selected)) this.updateSelectionBox();
    }
    if (this.following) this.followSelected();
  }

  private followSelected() {
    const f = this.selected ? this.motion.get(this.selected) : undefined;
    if (!f) return;
    const goal = this.world(f.x, f.y, this.tmpV);
    const ease = this.reducedMotion ? 1 : FOLLOW_EASE;
    const dx = (goal.x - this.controls.target.x) * ease;
    const dz = (goal.z - this.controls.target.z) * ease;
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
    this.controls.target.x += dx; this.controls.target.z += dz;
    this.camera.position.x += dx; this.camera.position.z += dz;
  }

  private animatePulses(now: number) {
    const touched = new Set<KindMesh>();
    for (const [id, start] of this.pulses) {
      const at = this.index.get(id);
      if (!at) { this.pulses.delete(id); continue; }
      const km = this.meshes.get(at.kind)!;
      const p = (now - start) / PULSE_MS;
      if (p >= 1) {
        this.pulses.delete(id);
        this.writeMatrix(km, at.i, id, 1);
      } else {
        this.writeMatrix(km, at.i, id, 1 + 0.6 * Math.sin(Math.PI * p));
      }
      touched.add(km);
    }
    for (const km of touched) km.mesh.instanceMatrix.needsUpdate = true;
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
    const at = this.index.get(id);
    if (!p || !at) return null;
    const km = this.meshes.get(at.kind)!;
    const v = this.world(p.x, p.y, new THREE.Vector3()).setY((p.level + 0.5) * km.height * p.size).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** Layout position currently drawn for a figure and whether it is moving, for tests and debugging. */
  positionOf(id: string): { x: number; y: number; moving: boolean; leaving: boolean } | null {
    const f = this.motion.get(id);
    return f ? { x: f.x, y: f.y, moving: this.motion.isMoving(id), leaving: f.leaving } : null;
  }

  /** Hex (#rrggbb, sRGB) currently drawn for an asset, for tests and debugging. */
  colorOf(id: string): string | null {
    const at = this.index.get(id);
    if (!at) return null;
    this.meshes.get(at.kind)!.mesh.getColorAt(at.i, this.tmpC);
    return `#${this.tmpC.getHexString()}`;
  }

  stats(): SceneStats {
    let instances = 0;
    for (const km of this.meshes.values()) instances += km.mesh.count;
    return { frames: this.frames, lastFrameMs: this.lastFrameMs, renderer: this.rendererName, webgl: this.webglVersion, software: this.software, antialias: !this.software, instances, drawCalls: this.renderer.info.render.calls, walkers: this.motion.walkerCount };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.controls.stopListenToKeyEvents();
    this.controls.dispose();
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    for (const km of this.meshes.values()) km.mesh.dispose();
    disposeTree(this.scene);
    this.scene.clear();
    this.meshes.clear();
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
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) x.dispose();
  });
}
