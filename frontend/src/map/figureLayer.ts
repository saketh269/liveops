// GPU side of the figures (LIVEOPS-98).
//
// Software renderers (SwiftShader, llvmpipe) pay a large fixed cost per
// instance, more than for the vertices themselves, so figures are not
// instanced. Each model has two merged meshes (one draw call each):
//  - a resting batch with a fixed slot per figure, rewritten only for figures
//    that change (pulse, recolor, start or stop walking);
//  - a moving batch holding only the walkers, packed at the front and rewritten
//    every frame while anyone walks.
// Picking is a ray / box test per figure, so it is the same for both.
import * as THREE from "three";
import { figureGeometry } from "./figureGeometry";
import type { FigureModel } from "./figures";

/** What the layer needs to draw one figure. */
export type FigurePose = { x: number; y: number; heading: number; level: number; size: number };

export type LayerEntry = { id: string; key: string; pose: FigurePose; moving: boolean; color: THREE.Color };

type Template = { pos: Float32Array; nrm: Float32Array; shade: Float32Array; index: ArrayLike<number>; verts: number; height: number };

type WorldPose = { wx: number; wy: number; wz: number; heading: number; scale: number };

/** Above this many changed slots, one span upload is cheaper than many small ones. */
const MAX_RANGES = 48;

/** One merged mesh holding `capacity` copies of a template. */
class Batch {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private nrm: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private dirtyPos = new Set<number>();
  private dirtyNrm = new Set<number>();
  private dirtyCol = new Set<number>();
  /** Per slot: world x, y, z, heading and scale last written (NaN = collapsed), so a pure move only shifts positions. */
  private last: Float64Array;

  constructor(readonly t: Template, readonly capacity: number, material: THREE.Material, sphere: THREE.Sphere, name: string) {
    const n = Math.max(1, capacity);
    this.last = new Float64Array(n * 5).fill(NaN);
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * t.verts * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(n * t.verts * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(n * t.verts * 3), 3);
    for (const a of [this.pos, this.nrm, this.col]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("normal", this.nrm);
    geo.setAttribute("color", this.col);
    const idx = n * t.verts > 65535 ? new Uint32Array(n * t.index.length) : new Uint16Array(n * t.index.length);
    for (let s = 0; s < n; s++) for (let k = 0; k < t.index.length; k++) idx[s * t.index.length + k] = s * t.verts + t.index[k];
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = sphere;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
  }

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
      // Same heading and size (walking a straight segment): shift positions, normals stay.
      const dx = pose.wx - L[lo], dy = pose.wy - L[lo + 1], dz = pose.wz - L[lo + 2];
      for (let v = o; v < o + t.verts * 3; v += 3) { p[v] += dx; p[v + 1] += dy; p[v + 2] += dz; }
      L[lo] = pose.wx; L[lo + 1] = pose.wy; L[lo + 2] = pose.wz;
      this.dirtyPos.add(slot);
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
      L[lo] = pose.wx; L[lo + 1] = pose.wy; L[lo + 2] = pose.wz; L[lo + 3] = pose.heading; L[lo + 4] = pose.scale;
      this.dirtyNrm.add(slot);
    }
    this.dirtyPos.add(slot);
  }

  writeColor(slot: number, color: THREE.Color) {
    const { t } = this;
    const a = this.col.array as Float32Array;
    const o = slot * t.verts * 3;
    for (let v = 0; v < t.verts; v++) {
      const sh = t.shade[v * 3];
      a[o + v * 3] = color.r * sh; a[o + v * 3 + 1] = color.g * sh; a[o + v * 3 + 2] = color.b * sh;
    }
    this.dirtyCol.add(slot);
  }

  /** Copy slot `from` over slot `to` (geometry and color). */
  copy(from: number, to: number) {
    const per = this.t.verts * 3;
    for (const a of [this.pos, this.nrm, this.col]) (a.array as Float32Array).copyWithin(to * per, from * per, from * per + per);
    this.last.copyWithin(to * 5, from * 5, from * 5 + 5);
    this.dirtyPos.add(to);
    this.dirtyNrm.add(to);
    this.dirtyCol.add(to);
  }

  /** Copy the first `n` slots from a smaller batch of the same template (when growing). */
  copyFrom(other: Batch, n: number) {
    const len = n * this.t.verts * 3;
    const pairs: [THREE.BufferAttribute, THREE.BufferAttribute][] = [[this.pos, other.pos], [this.nrm, other.nrm], [this.col, other.col]];
    for (const [a, b] of pairs) (a.array as Float32Array).set((b.array as Float32Array).subarray(0, len));
    this.last.set(other.last.subarray(0, n * 5));
    for (let i = 0; i < n; i++) { this.dirtyPos.add(i); this.dirtyNrm.add(i); this.dirtyCol.add(i); }
  }

  flush() {
    this.upload(this.pos, this.dirtyPos);
    this.upload(this.nrm, this.dirtyNrm);
    this.upload(this.col, this.dirtyCol);
  }

  private upload(a: THREE.BufferAttribute, slots: Set<number>) {
    if (!slots.size) return;
    const per = this.t.verts * 3;
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

class ModelGroup {
  readonly resting: Batch;
  moving: Batch | null = null;
  /** Fixed resting slot per figure. */
  readonly slots = new Map<string, number>();
  readonly movingIds: string[] = [];
  readonly movingAt = new Map<string, number>();
  /** Last pose written per figure (x, y, heading, level, size·scale, moving) so unchanged figures are skipped. */
  readonly poses: Float64Array;

  constructor(readonly key: string, readonly t: Template, readonly ids: readonly string[], private material: THREE.Material, private sphere: THREE.Sphere, parent: THREE.Object3D) {
    this.resting = new Batch(t, ids.length, material, sphere, `figures:${key}`);
    this.resting.setCount(ids.length);
    parent.add(this.resting.mesh);
    ids.forEach((id, i) => this.slots.set(id, i));
    this.poses = new Float64Array(Math.max(1, ids.length) * 6).fill(NaN);
  }

  /** Move a figure into the moving batch; returns its moving slot. */
  startMoving(id: string, color: THREE.Color | undefined, parent: THREE.Object3D): number {
    const need = this.movingIds.length + 1;
    if (!this.moving || this.moving.capacity < need) {
      const next = new Batch(this.t, Math.max(16, 2 ** Math.ceil(Math.log2(need))), this.material, this.sphere, `walkers:${this.key}`);
      if (this.moving) { next.copyFrom(this.moving, this.movingIds.length); this.moving.dispose(); }
      parent.add(next.mesh);
      this.moving = next;
    }
    const i = this.movingIds.length;
    this.movingIds.push(id);
    this.movingAt.set(id, i);
    if (color) this.moving.writeColor(i, color);
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
    this.moving?.flush();
  }

  dispose() {
    this.resting.dispose();
    this.moving?.dispose();
  }
}

const templates = new Map<string, Template>();

function templateFor(key: string): Template {
  let t = templates.get(key);
  if (t) return t;
  const { geo, height } = figureGeometry(key as FigureModel);
  const pos = geo.getAttribute("position").array as Float32Array;
  t = {
    height, pos,
    nrm: geo.getAttribute("normal").array as Float32Array,
    shade: geo.getAttribute("color").array as Float32Array,
    index: geo.index ? geo.index.array : [...Array(pos.length / 3).keys()],
    verts: pos.length / 3,
  };
  templates.set(key, t);
  return t;
}

export class FigureLayer {
  readonly group = new THREE.Group();
  private groups = new Map<string, ModelGroup>();
  private home = new Map<string, ModelGroup>();
  private colors = new Map<string, THREE.Color>();
  private material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  private tmpV = new THREE.Vector3();
  private tmpBox = new THREE.Box3();
  private tmpHit = new THREE.Vector3();

  /** `world` maps layout (x, y) to world (X, 0, Z). */
  constructor(private world: (x: number, y: number, out: THREE.Vector3) => THREE.Vector3) {}

  /**
   * Set every figure (new placement or new set of figures). A model whose list
   * of figures is unchanged keeps its buffers and only rewrites what changed.
   */
  rebuild(entries: LayerEntry[], sphere: THREE.Sphere) {
    const byKey = new Map<string, LayerEntry[]>();
    for (const e of entries) {
      const l = byKey.get(e.key);
      if (l) l.push(e); else byKey.set(e.key, [e]);
    }
    for (const [key, g] of this.groups) {
      const list = byKey.get(key);
      if (list && list.length === g.ids.length && list.every((e, i) => e.id === g.ids[i])) continue;
      g.dispose();
      this.groups.delete(key);
    }
    this.home.clear();
    const live = new Set<string>();
    for (const [key, list] of byKey) {
      let g = this.groups.get(key);
      if (!g) {
        g = new ModelGroup(key, templateFor(key), list.map((e) => e.id), this.material, sphere, this.group);
        this.groups.set(key, g);
        for (const e of list) this.colors.delete(e.id); // fresh buffers: every color must be written
      }
      for (const e of list) {
        live.add(e.id);
        this.home.set(e.id, g);
        this.setColor(e.id, e.color);
        this.write(e.id, e.pose, e.moving);
      }
    }
    for (const id of this.colors.keys()) if (!live.has(id)) this.colors.delete(id);
  }

  has(id: string) { return this.home.has(id); }
  keyOf(id: string) { return this.home.get(id)?.key; }
  heightOf(id: string) { return this.home.get(id)?.t.height ?? 1; }

  /** Draw a figure at `pose`, in the resting or the moving batch. `scale` animates pulses. */
  write(id: string, pose: FigurePose, moving: boolean, scale = 1) {
    const g = this.home.get(id);
    if (!g) return;
    const slot = g.slots.get(id)!;
    const q = g.poses, o = slot * 6, k = pose.size * scale, m = moving ? 1 : 0;
    if (q[o] === pose.x && q[o + 1] === pose.y && q[o + 2] === pose.heading && q[o + 3] === pose.level && q[o + 4] === k && q[o + 5] === m) return;
    q[o] = pose.x; q[o + 1] = pose.y; q[o + 2] = pose.heading; q[o + 3] = pose.level; q[o + 4] = k; q[o + 5] = m;
    this.world(pose.x, pose.y, this.tmpV);
    const wp: WorldPose = { wx: this.tmpV.x, wy: pose.level * g.t.height * pose.size, wz: this.tmpV.z, heading: pose.heading, scale: k };
    const wasMoving = g.movingAt.has(id);
    if (moving) {
      if (!wasMoving) {
        g.resting.write(slot, null);
        g.startMoving(id, this.colors.get(id), this.group);
      }
      g.moving!.write(g.movingAt.get(id)!, wp);
      return;
    }
    if (wasMoving) g.stopMoving(id);
    g.resting.write(slot, wp);
  }

  setColor(id: string, color: THREE.Color) {
    const g = this.home.get(id);
    if (!g) return;
    const c = this.colors.get(id);
    if (c && c.equals(color)) return;
    if (c) c.copy(color); else this.colors.set(id, color.clone());
    g.resting.writeColor(g.slots.get(id)!, color);
    const i = g.movingAt.get(id);
    if (i !== undefined) g.moving!.writeColor(i, color);
  }

  /** Hex (#rrggbb, sRGB) drawn for a figure. */
  colorOf(id: string): string | null {
    const c = this.colors.get(id);
    return c ? `#${c.getHexString()}` : null;
  }

  /** Upload this frame's changes. */
  flush() {
    for (const g of this.groups.values()) g.flush();
  }

  /** Nearest figure hit by a world-space ray. */
  pick(ray: THREE.Ray, poseOf: (id: string) => FigurePose | undefined): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, g] of this.home) {
      const p = poseOf(id);
      if (!p) continue;
      const h = g.t.height * p.size;
      const r = p.size * 0.5;
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
    for (const g of this.groups.values()) g.dispose();
    this.groups.clear();
    this.home.clear();
    this.material.dispose();
  }
}
