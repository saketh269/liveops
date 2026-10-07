// GPU side of the figures (LIVEOPS-98, models LIVEOPS-109).
//
// Software renderers (SwiftShader, llvmpipe) pay a large fixed cost per
// instance, more than for the vertices themselves, so figures are not
// instanced. Each model has merged meshes (one draw call each):
//  - a resting batch with a fixed slot per figure, rewritten only for figures
//    that change (pulse, recolor, start or stop walking);
//  - a lying batch (patients in a bed), created when the first one lies down;
//  - a moving batch holding only the walkers, packed at the front and rewritten
//    every frame while anyone walks. Their stride runs in the vertex shader.
// Part colors come from the models palette; parts painted "state" take the
// record's state color. Picking is a ray / box test per figure.
import * as THREE from "three";
import { figureTemplate } from "./figureGeometry";
import { canLie, type BodyPose, type FigureModel } from "./figures";
import { figureMaterial, figureUniforms, tickUniforms } from "./models/figureMaterial";
import { PAINTS, type ModelTemplate } from "./models/modelGeometry";
import { currentModelTheme, getModelPalette, idHash, onModelPaletteChange } from "./models/palette";
import { onThemeChange, readStateColors, type StateKey } from "./stateColors";

/**
 * What the layer needs to draw one figure. `pose` is the body pose (ADR 0007):
 * "lying" draws a patient in the bed at (x, y), square to the room like the
 * bed; anything else, and every walker, stands. Placement decides it.
 */
export type FigurePose = { x: number; y: number; heading: number; level: number; size: number; pose?: BodyPose };

export type LayerEntry = { id: string; key: FigureModel; pose: FigurePose; moving: boolean; color: THREE.Color };

type WorldPose = { wx: number; wy: number; wz: number; heading: number; scale: number; phase: number };

/** Above this many changed slots, one span upload is cheaper than many small ones. */
const MAX_RANGES = 48;
/** States whose ambulance light bar flashes. */
const FLASHING: readonly StateKey[] = ["in-use", "alert"];
/** Walkers bob this much (footprint units) per stride. */
const BOB = 0.02;

/** Resolved palette: linear RGB per paint index, plus the skin tones. */
type Paints = { rgb: Float32Array; skin: THREE.Color[] };
const SKIN = PAINTS.indexOf("skin");
const STATE = PAINTS.indexOf("state");

/** Per-figure color inputs: state color, skin choice, light bar on. */
type Look = { color: THREE.Color; variant: number; active: boolean };

/** One merged mesh holding `capacity` copies of a template. */
class Batch {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private nrm: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private flash: THREE.BufferAttribute;
  private walk: THREE.BufferAttribute | null = null;
  private attrs: THREE.BufferAttribute[];
  private dirty = new Map<THREE.BufferAttribute, Set<number>>();
  /** Per slot: world x, y, z, heading and scale last written (NaN = collapsed), so a pure move only shifts positions. */
  private last: Float64Array;

  constructor(readonly t: ModelTemplate, readonly capacity: number, material: THREE.Material, sphere: THREE.Sphere, name: string, walking: boolean) {
    const n = Math.max(1, capacity);
    this.last = new Float64Array(n * 5).fill(NaN);
    const geo = new THREE.BufferGeometry();
    const v = n * t.verts;
    this.pos = new THREE.BufferAttribute(new Float32Array(v * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(v * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(v * 3), 3);
    this.flash = new THREE.BufferAttribute(new Float32Array(v), 1);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("normal", this.nrm);
    geo.setAttribute("color", this.col);
    geo.setAttribute("aFlash", this.flash);
    this.attrs = [this.pos, this.nrm, this.col, this.flash];
    if (walking) {
      const swing = new Float32Array(v);
      for (let s = 0; s < n; s++) swing.set(t.swing, s * t.verts);
      geo.setAttribute("aSwing", new THREE.BufferAttribute(swing, 1));
      this.walk = new THREE.BufferAttribute(new Float32Array(v * 4), 4);
      geo.setAttribute("aWalk", this.walk);
      this.attrs.push(this.walk);
    }
    for (const a of this.attrs) { a.setUsage(THREE.DynamicDrawUsage); this.dirty.set(a, new Set()); }
    const idx = v > 65535 ? new Uint32Array(n * t.index.length) : new Uint16Array(n * t.index.length);
    for (let s = 0; s < n; s++) for (let k = 0; k < t.index.length; k++) idx[s * t.index.length + k] = s * t.verts + t.index[k];
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = sphere;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
  }

  private mark(a: THREE.BufferAttribute, slot: number) { this.dirty.get(a)!.add(slot); }

  /** Draw only the first `n` slots. */
  setCount(n: number) {
    this.mesh.geometry.setDrawRange(0, n * this.t.index.length);
    this.mesh.visible = n > 0;
  }

  /** Bake a figure into a slot, or collapse the slot (degenerate triangles) when `pose` is null. */
  write(slot: number, pose: WorldPose | null) {
    const { t } = this;
    const p = this.pos.array as Float32Array, nm = this.nrm.array as Float32Array;
    const o = slot * t.verts * 3;
    const L = this.last, lo = slot * 5;
    if (!pose) {
      p.fill(0, o, o + t.verts * 3);
      L.fill(NaN, lo, lo + 5);
    } else if (L[lo + 3] === pose.heading && L[lo + 4] === pose.scale) {
      // Same heading and size (walking a straight segment): shift positions, normals and stride stay.
      const dx = pose.wx - L[lo], dy = pose.wy - L[lo + 1], dz = pose.wz - L[lo + 2];
      for (let v = o; v < o + t.verts * 3; v += 3) { p[v] += dx; p[v + 1] += dy; p[v + 2] += dz; }
      L[lo] = pose.wx; L[lo + 1] = pose.wy; L[lo + 2] = pose.wz;
      this.mark(this.pos, slot);
      return;
    } else {
      const c = Math.cos(-pose.heading), s = Math.sin(-pose.heading), k = pose.scale;
      for (let v = 0; v < t.verts * 3; v += 3) {
        const x = t.pos[v] * k, y = t.pos[v + 1] * k, z = t.pos[v + 2] * k;
        p[o + v] = pose.wx + x * c + z * s;
        p[o + v + 1] = pose.wy + y;
        p[o + v + 2] = pose.wz - x * s + z * c;
        const nx = t.nrm[v], nz = t.nrm[v + 2];
        nm[o + v] = nx * c + nz * s;
        nm[o + v + 1] = t.nrm[v + 1];
        nm[o + v + 2] = -nx * s + nz * c;
      }
      if (this.walk) {
        // Stride direction = the figure's +x in world space, times its scale.
        const w = this.walk.array as Float32Array, wo = slot * t.verts * 4;
        const fx = c * k, fz = -s * k, bob = t.walks ? BOB * k : 0;
        for (let v = 0; v < t.verts; v++) { w[wo + v * 4] = fx; w[wo + v * 4 + 1] = fz; w[wo + v * 4 + 2] = pose.phase; w[wo + v * 4 + 3] = bob; }
        this.mark(this.walk, slot);
      }
      L[lo] = pose.wx; L[lo + 1] = pose.wy; L[lo + 2] = pose.wz; L[lo + 3] = pose.heading; L[lo + 4] = pose.scale;
      this.mark(this.nrm, slot);
    }
    this.mark(this.pos, slot);
  }

  writeColor(slot: number, look: Look, paints: Paints) {
    const { t } = this;
    const a = this.col.array as Float32Array, f = this.flash.array as Float32Array;
    const o = slot * t.verts;
    const skin = paints.skin[look.variant % paints.skin.length];
    for (let v = 0; v < t.verts; v++) {
      const sh = t.shade[v], pi = t.paint[v], q = (o + v) * 3;
      if (pi === STATE) { a[q] = look.color.r * sh; a[q + 1] = look.color.g * sh; a[q + 2] = look.color.b * sh; }
      else if (pi === SKIN) { a[q] = skin.r * sh; a[q + 1] = skin.g * sh; a[q + 2] = skin.b * sh; }
      else { a[q] = paints.rgb[pi * 3] * sh; a[q + 1] = paints.rgb[pi * 3 + 1] * sh; a[q + 2] = paints.rgb[pi * 3 + 2] * sh; }
      f[o + v] = look.active ? t.flash[v] : 0;
    }
    this.mark(this.col, slot);
    this.mark(this.flash, slot);
  }

  /** Copy slot `from` over slot `to`. */
  copy(from: number, to: number) {
    for (const a of this.attrs) {
      const per = this.t.verts * a.itemSize;
      (a.array as Float32Array).copyWithin(to * per, from * per, from * per + per);
      this.mark(a, to);
    }
    this.last.copyWithin(to * 5, from * 5, from * 5 + 5);
  }

  /** Copy the first `n` slots from a smaller batch of the same template (when growing). */
  copyFrom(other: Batch, n: number) {
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i], b = other.attrs[i];
      (a.array as Float32Array).set((b.array as Float32Array).subarray(0, n * this.t.verts * a.itemSize));
      for (let s = 0; s < n; s++) this.mark(a, s);
    }
    this.last.set(other.last.subarray(0, n * 5));
  }

  flush() {
    for (const [a, slots] of this.dirty) this.upload(a, slots);
  }

  private upload(a: THREE.BufferAttribute, slots: Set<number>) {
    if (!slots.size) return;
    const per = this.t.verts * a.itemSize;
    a.clearUpdateRanges();
    if (slots.size > MAX_RANGES) {
      let lo = Infinity, hi = -Infinity;
      for (const s of slots) { if (s < lo) lo = s; if (s > hi) hi = s; }
      a.addUpdateRange(lo * per, (hi - lo + 1) * per);
    } else {
      const sorted = [...slots].sort((x, y) => x - y);
      let start = sorted[0], end = sorted[0]; // adjacent slots share one range
      for (let i = 1; i <= sorted.length; i++) {
        const s = sorted[i];
        if (s === end + 1) { end = s; continue; }
        a.addUpdateRange(start * per, (end - start + 1) * per);
        start = end = s;
      }
    }
    a.needsUpdate = true;
    slots.clear();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

type Materials = { rest: THREE.Material; walk: THREE.Material };

class ModelGroup {
  readonly resting: Batch;
  /** Patients lying in a bed (lazily created; same slots as `resting`). */
  lying: Batch | null = null;
  moving: Batch | null = null;
  /** Fixed resting slot per figure. */
  readonly slots = new Map<string, number>();
  readonly movingIds: string[] = [];
  readonly movingAt = new Map<string, number>();
  /** Last pose written per figure (x, y, heading, level, size·scale, moving, lying) so unchanged figures are skipped. */
  readonly poses: Float64Array;
  /** Per slot: 1 while drawn in the lying batch. */
  readonly lies: Uint8Array;
  readonly t: ModelTemplate;

  constructor(readonly key: FigureModel, readonly ids: readonly string[], private materials: Materials, private sphere: THREE.Sphere, private parent: THREE.Object3D) {
    this.t = figureTemplate(key);
    this.resting = new Batch(this.t, ids.length, materials.rest, sphere, `figures:${key}`, false);
    this.resting.setCount(ids.length);
    parent.add(this.resting.mesh);
    ids.forEach((id, i) => this.slots.set(id, i));
    this.poses = new Float64Array(Math.max(1, ids.length) * 7).fill(NaN);
    this.lies = new Uint8Array(Math.max(1, ids.length));
  }

  lyingBatch(): Batch {
    if (!this.lying) {
      this.lying = new Batch(figureTemplate(this.key, true), this.ids.length, this.materials.rest, this.sphere, `figures:${this.key}:lying`, false);
      this.lying.setCount(this.ids.length);
      this.parent.add(this.lying.mesh);
    }
    return this.lying;
  }

  /** Move a figure into the moving batch; returns its moving slot. */
  startMoving(id: string, look: Look | undefined, paints: Paints): number {
    const need = this.movingIds.length + 1;
    if (!this.moving || this.moving.capacity < need) {
      const next = new Batch(this.t, Math.max(16, 2 ** Math.ceil(Math.log2(need))), this.materials.walk, this.sphere, `walkers:${this.key}`, true);
      if (this.moving) { next.copyFrom(this.moving, this.movingIds.length); this.moving.dispose(); }
      this.parent.add(next.mesh);
      this.moving = next;
    }
    const i = this.movingIds.length;
    this.movingIds.push(id);
    this.movingAt.set(id, i);
    if (look) this.moving.writeColor(i, look, paints);
    this.moving.setCount(this.movingIds.length);
    return i;
  }

  stopMoving(id: string) {
    const i = this.movingAt.get(id)!;
    const last = this.movingIds.length - 1;
    if (i !== last) {
      const moved = this.movingIds[last];
      this.moving!.copy(last, i);
      this.movingIds[i] = moved;
      this.movingAt.set(moved, i);
    }
    this.movingIds.pop();
    this.movingAt.delete(id);
    this.moving!.setCount(this.movingIds.length);
  }

  flush() {
    this.resting.flush();
    this.lying?.flush();
    this.moving?.flush();
  }

  dispose() {
    this.resting.dispose();
    this.lying?.dispose();
    this.moving?.dispose();
  }
}

export class FigureLayer {
  readonly group = new THREE.Group();
  private groups = new Map<string, ModelGroup>();
  private home = new Map<string, ModelGroup>();
  private looks = new Map<string, Look>();
  private uniforms = figureUniforms();
  private materials: Materials = { rest: figureMaterial(this.uniforms, false), walk: figureMaterial(this.uniforms, true) };
  private paints: Paints = { rgb: new Float32Array(PAINTS.length * 3), skin: [] };
  private flashColors: THREE.Color[] = [];
  private paletteDirty = false;
  private reducedMotion = false;
  private disposers: (() => void)[] = [];
  private tmpV = new THREE.Vector3();
  private tmpBox = new THREE.Box3();
  private tmpHit = new THREE.Vector3();

  /** `world` maps layout (x, y) to world (X, 0, Z). */
  constructor(private world: (x: number, y: number, out: THREE.Vector3) => THREE.Vector3) {
    this.readPalette();
    const repaint = () => { this.paletteDirty = true; };
    this.disposers.push(onModelPaletteChange(repaint));
    if (typeof document !== "undefined") this.disposers.push(onThemeChange(repaint));
    if (typeof matchMedia === "function") {
      const mq = matchMedia("(prefers-reduced-motion: reduce)");
      this.reducedMotion = mq.matches;
      const on = () => { this.reducedMotion = mq.matches; };
      mq.addEventListener?.("change", on);
      this.disposers.push(() => mq.removeEventListener?.("change", on));
    }
  }

  /** Resolve the palette for the current theme and the state colors whose light bar flashes. */
  private readPalette() {
    const p = getModelPalette(currentModelTheme());
    const c = new THREE.Color();
    PAINTS.forEach((key, i) => {
      if (key === "state" || key === "skin") return;
      try { c.setStyle(p[key]); } catch { c.set(0x999999); }
      this.paints.rgb[i * 3] = c.r; this.paints.rgb[i * 3 + 1] = c.g; this.paints.rgb[i * 3 + 2] = c.b;
    });
    this.paints.skin = (p.skin.length ? p.skin : ["#d9a57f"]).map((s) => { try { return new THREE.Color().setStyle(s); } catch { return new THREE.Color(0xd9a57f); } });
    this.flashColors = [];
    if (typeof document !== "undefined") {
      const sc = readStateColors();
      for (const k of FLASHING) if (sc[k]) { try { this.flashColors.push(new THREE.Color().setStyle(sc[k])); } catch { /* unparsable token */ } }
    }
  }

  /**
   * The light bar flashes for in_use / alert records. The layer is given the
   * drawn state color, so it recognises those states by their token color.
   */
  private isActive(color: THREE.Color) {
    return this.flashColors.some((c) => c.equals(color));
  }

  /**
   * Set every figure (new placement or new set of figures). A model whose list
   * of figures is unchanged keeps its buffers and only rewrites what changed.
   */
  rebuild(entries: LayerEntry[], sphere: THREE.Sphere) {
    const byKey = new Map<FigureModel, LayerEntry[]>();
    for (const e of entries) {
      const l = byKey.get(e.key);
      if (l) l.push(e); else byKey.set(e.key, [e]);
    }
    for (const [key, g] of this.groups) {
      const list = byKey.get(key as FigureModel);
      if (list && list.length === g.ids.length && list.every((e, i) => e.id === g.ids[i])) continue;
      g.dispose();
      this.groups.delete(key);
    }
    this.home.clear();
    const live = new Set<string>();
    for (const [key, list] of byKey) {
      let g = this.groups.get(key);
      if (!g) {
        g = new ModelGroup(key, list.map((e) => e.id), this.materials, sphere, this.group);
        this.groups.set(key, g);
        for (const e of list) this.looks.delete(e.id); // fresh buffers: every color must be written
      }
      for (const e of list) {
        live.add(e.id);
        this.home.set(e.id, g);
        this.setColor(e.id, e.color);
        this.write(e.id, e.pose, e.moving);
      }
    }
    for (const id of this.looks.keys()) if (!live.has(id)) this.looks.delete(id);
  }

  has(id: string) { return this.home.has(id); }
  keyOf(id: string) { return this.home.get(id)?.key; }
  /** Height of the figure as drawn (a lying patient is as tall as the bed). */
  heightOf(id: string) {
    const g = this.home.get(id);
    if (!g) return 1;
    const slot = g.slots.get(id)!;
    return g.lies[slot] && g.lying ? g.lying.t.height : g.t.height;
  }
  /** Body pose as drawn. */
  poseOf(id: string): BodyPose | undefined {
    const g = this.home.get(id);
    if (!g) return undefined;
    return g.lies[g.slots.get(id)!] ? "lying" : "standing";
  }

  /** Draw a figure at `pose`, in the resting, lying or moving batch. `scale` animates pulses. */
  write(id: string, pose: FigurePose, moving: boolean, scale = 1) {
    const g = this.home.get(id);
    if (!g) return;
    const slot = g.slots.get(id)!;
    const lying = !moving && pose.pose === "lying" && canLie(g.key);
    const heading = lying ? 0 : pose.heading; // in bed: square to the room, like the bed
    const q = g.poses, o = slot * 7, k = pose.size * scale, m = moving ? 1 : 0, ly = lying ? 1 : 0;
    if (q[o] === pose.x && q[o + 1] === pose.y && q[o + 2] === heading && q[o + 3] === pose.level && q[o + 4] === k && q[o + 5] === m && q[o + 6] === ly) return;
    q[o] = pose.x; q[o + 1] = pose.y; q[o + 2] = heading; q[o + 3] = pose.level; q[o + 4] = k; q[o + 5] = m; q[o + 6] = ly;
    this.world(pose.x, pose.y, this.tmpV);
    const t = lying ? g.lyingBatch().t : g.t;
    const wp: WorldPose = { wx: this.tmpV.x, wy: pose.level * t.height * pose.size, wz: this.tmpV.z, heading, scale: k, phase: (idHash(id) % 628) / 100 };
    const look = this.looks.get(id);
    const wasMoving = g.movingAt.has(id);
    if (moving) {
      if (!wasMoving) {
        this.collapseResting(g, slot);
        g.startMoving(id, look, this.paints);
      }
      g.moving!.write(g.movingAt.get(id)!, wp);
      return;
    }
    if (wasMoving) g.stopMoving(id);
    if (lying) {
      if (!g.lies[slot]) {
        g.resting.write(slot, null);
        g.lies[slot] = 1;
        if (look) g.lying!.writeColor(slot, look, this.paints);
      }
      g.lying!.write(slot, wp);
    } else {
      if (g.lies[slot]) { g.lying!.write(slot, null); g.lies[slot] = 0; }
      g.resting.write(slot, wp);
    }
  }

  private collapseResting(g: ModelGroup, slot: number) {
    if (g.lies[slot]) { g.lying!.write(slot, null); g.lies[slot] = 0; }
    else g.resting.write(slot, null);
  }

  setColor(id: string, color: THREE.Color) {
    const g = this.home.get(id);
    if (!g) return;
    let look = this.looks.get(id);
    if (look && look.color.equals(color)) return;
    if (look) { look.color.copy(color); look.active = this.isActive(color); }
    else { look = { color: color.clone(), variant: idHash(id), active: this.isActive(color) }; this.looks.set(id, look); }
    this.paint(g, id, look);
  }

  private paint(g: ModelGroup, id: string, look: Look) {
    const slot = g.slots.get(id)!;
    g.resting.writeColor(slot, look, this.paints);
    if (g.lying) g.lying.writeColor(slot, look, this.paints);
    const i = g.movingAt.get(id);
    if (i !== undefined) g.moving!.writeColor(i, look, this.paints);
  }

  /** Hex (#rrggbb, sRGB) of the state color drawn for a figure. */
  colorOf(id: string): string | null {
    const l = this.looks.get(id);
    return l ? `#${l.color.getHexString()}` : null;
  }

  /** Upload this frame's changes and advance the shared animation clock. */
  flush(now = typeof performance !== "undefined" ? performance.now() : Date.now()) {
    if (this.paletteDirty) {
      this.paletteDirty = false;
      this.readPalette();
      for (const [id, g] of this.home) {
        const look = this.looks.get(id);
        if (!look) continue;
        look.active = this.isActive(look.color);
        this.paint(g, id, look);
      }
    }
    tickUniforms(this.uniforms, now, this.reducedMotion);
    for (const g of this.groups.values()) g.flush();
  }

  /** Nearest figure hit by a world-space ray. */
  pick(ray: THREE.Ray, poseOf: (id: string) => FigurePose | undefined): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id] of this.home) {
      const p = poseOf(id);
      if (!p) continue;
      const h = this.heightOf(id) * p.size;
      // A patient in bed is picked over the middle of the bed (and over it); the bed's head and foot still pick the bed.
      const r = p.size * (this.poseOf(id) === "lying" ? 0.3 : 0.5);
      this.world(p.x, p.y, this.tmpV);
      const y0 = p.level * h;
      this.tmpBox.min.set(this.tmpV.x - r, y0, this.tmpV.z - r);
      this.tmpBox.max.set(this.tmpV.x + r, y0 + h, this.tmpV.z + r);
      const hit = ray.intersectBox(this.tmpBox, this.tmpHit);
      if (!hit) continue;
      const d = hit.distanceToSquared(ray.origin);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  get count() { return this.home.size; }
  get walkers() { let n = 0; for (const g of this.groups.values()) n += g.movingIds.length; return n; }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
    for (const g of this.groups.values()) g.dispose();
    this.groups.clear();
    this.home.clear();
    this.materials.rest.dispose();
    this.materials.walk.dispose();
  }
}
