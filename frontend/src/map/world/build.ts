// Builds the static 3D world of one floor: site ground (first floor only), rounded slab,
// painted floor, room tiles, walls, nurse-station desks and waiting chairs.
// Static pieces are baked into one vertex-colored mesh per floor (one draw call).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Entrance, Zone } from "../../api/types";
import { pointInPolygon, polygonBounds, type Pt } from "../placement";
import { paintFloor, type PaintFonts } from "./floorPaint";
import { WORLD, type ScenePalette } from "./style";
import { isNurseStation, planWalls, type Seg } from "./walls";

export type WorldInput = {
  width: number;
  depth: number;
  zones: readonly Zone[];
  entrances: readonly Entrance[];
  /** Ground floor: draw the site around it (grass, road, trees). Decoration only, never data. */
  ground: boolean;
  palette: ScenePalette;
  software: boolean;
  fonts: PaintFonts;
};

const tmpColor = new THREE.Color();

/** Collects colored, non-indexed pieces and merges them into one geometry. */
export class Baker {
  private parts: THREE.BufferGeometry[] = [];

  /** Add `geo` (consumed) in `color`; faces pointing up get `topColor` when given. */
  add(geo: THREE.BufferGeometry, color: string, matrix?: THREE.Matrix4, topColor?: string) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    if (matrix) g.applyMatrix4(matrix);
    const n = g.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    const nrm = g.getAttribute("normal");
    const base = tmpColor.setStyle(color).clone();
    const top = topColor ? new THREE.Color().setStyle(topColor) : base;
    for (let i = 0; i < n; i++) {
      const c = nrm.getY(i) > 0.7 ? top : base;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.groups.length = 0;
    this.parts.push(g);
  }

  get size() { return this.parts.length; }

  /** Merged geometry (null when empty); the pieces are released. */
  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return merged;
  }
}

/** Rounded rectangle extruded upwards from y = 0 to `h`, centred on the origin. */
export function roundedBox(w: number, d: number, r: number, h: number): THREE.BufferGeometry {
  const rr = Math.max(0.01, Math.min(r, w / 2 - 0.01, d / 2 - 0.01));
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y); s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + d - rr); s.quadraticCurveTo(x + w, y + d, x + w - rr, y + d);
  s.lineTo(x + rr, y + d); s.quadraticCurveTo(x, y + d, x, y + d - rr);
  s.lineTo(x, y + rr); s.quadraticCurveTo(x, y, x + rr, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  return g;
}

const m4 = (x: number, y: number, z: number, rotY = 0, rotX = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, "YXZ")), new THREE.Vector3(1, 1, 1));

/** Merged, tinted floor tiles for room zones; each room's color and opacity can change live. */
export class RoomTiles {
  readonly mesh: THREE.Mesh | null;
  private ranges = new Map<string, [number, number]>();
  private col: THREE.BufferAttribute | null = null;

  constructor(rooms: readonly Zone[], toWorld: (x: number, y: number) => THREE.Vector3) {
    const pos: number[] = [];
    for (const z of rooms) {
      const poly = z.polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      const contour = poly.map(([x, y]) => new THREE.Vector2(x, y));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const start = pos.length / 3;
      for (const t of tris) for (const k of t) { const v = toWorld(poly[k][0], poly[k][1]); pos.push(v.x, WORLD.tileY, v.z); }
      this.ranges.set(z.id, [start, pos.length / 3]);
    }
    if (!pos.length) { this.mesh = null; return; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    this.col = new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
    this.col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", this.col);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "room-tiles";
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 0;
  }

  has(id: string) { return this.ranges.has(id); }
  ids() { return this.ranges.keys(); }

  set(id: string, color: THREE.Color, alpha: number) {
    const r = this.ranges.get(id);
    if (!r || !this.col) return;
    const a = this.col.array as Float32Array;
    for (let i = r[0]; i < r[1]; i++) { a[i * 4] = color.r; a[i * 4 + 1] = color.g; a[i * 4 + 2] = color.b; a[i * 4 + 3] = alpha; }
    this.col.needsUpdate = true;
  }

  /** sRGB hex and opacity currently drawn for a room (tests, debugging). */
  get(id: string): { color: string; alpha: number } | null {
    const r = this.ranges.get(id);
    if (!r || !this.col) return null;
    const a = this.col.array as Float32Array, i = r[0] * 4;
    return { color: `#${new THREE.Color(a[i], a[i + 1], a[i + 2]).getHexString()}`, alpha: Math.round(a[i + 3] * 1000) / 1000 };
  }
}

export type BuiltWorld = { group: THREE.Group; tiles: RoomTiles; wallCount: number };

/** Build the static world of a floor centred on the origin. */
export function buildWorld(input: WorldInput): BuiltWorld {
  const { width, depth, zones, entrances, palette: p } = input;
  const group = new THREE.Group();
  group.name = "world";
  const toWorld = (x: number, y: number) => new THREE.Vector3(x - width / 2, 0, y - depth / 2);
  const valid = zones.filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3);
  const mat = (o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ roughness: p.roughness, metalness: 0.02, ...o });

  // Site ground (first floor only) and decoration.
  if (input.ground) group.add(...buildSite(width, depth, entrances, p, mat));

  // Slab with rounded edges, its top just under the floor.
  const m = WORLD.slabMargin;
  const slab = new THREE.Mesh(roundedBox(width + 2 * m, depth + 2 * m, 0.8, WORLD.slabThickness), mat({ color: p.slab }));
  slab.position.y = -WORLD.slabThickness;
  slab.receiveShadow = true;
  slab.name = "slab";
  group.add(slab);

  // Painted floor.
  const canvas = paintFloor(width, depth, valid, p, input.fonts, input.software ? 1536 : 2048);
  const floorMat = mat({ color: canvas ? 0xffffff : p.floor, roughness: 0.9 });
  if (canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = input.software ? 1 : 8;
    floorMat.map = tex;
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = WORLD.floorY;
  floor.receiveShadow = true;
  floor.name = "floor";
  group.add(floor);

  // Room tiles (tinted live by the scene).
  const tiles = new RoomTiles(valid.filter((z) => z.kind === "room"), toWorld);
  if (tiles.mesh) group.add(tiles.mesh);

  // Walls, desks and chairs: one merged mesh.
  const bake = new Baker();
  const walls = planWalls({ width, depth, zones: valid, entrances, doorWidth: WORLD.doorWidth });
  for (const s of walls.inner) wallPiece(bake, s, WORLD.wallHeight, p.wall, p.wallTop, toWorld);
  for (const s of walls.outer) wallPiece(bake, s, WORLD.outerWallHeight, p.wall, p.outerWallTop, toWorld);
  for (const z of valid) {
    if (isNurseStation(z)) nurseDesk(bake, z, p, toWorld);
    else if (z.kind === "waiting") chairs(bake, z, p, toWorld);
  }
  const geo = bake.build();
  if (geo) {
    const statics = new THREE.Mesh(geo, mat({ vertexColors: true }));
    statics.castShadow = true;
    statics.receiveShadow = true;
    statics.name = "statics";
    group.add(statics);
  }
  return { group, tiles, wallCount: walls.inner.length + walls.outer.length };
}

function wallPiece(bake: Baker, s: Seg, h: number, side: string, top: string, toWorld: (x: number, y: number) => THREE.Vector3) {
  const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  if (len < 0.05) return;
  const T = WORLD.wallThickness;
  const c = toWorld((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2);
  const geo = new THREE.BoxGeometry(len + T, h, T); // + T closes the corners
  bake.add(geo, side, m4(c.x, h / 2, c.z, -Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0])), top);
}

function nurseDesk(bake: Baker, z: Zone, p: ScenePalette, toWorld: (x: number, y: number) => THREE.Vector3) {
  const b = polygonBounds(z.polygon);
  const along = b.w >= b.h;
  const L = Math.max(1.6, (along ? b.w : b.h) * 0.85);
  const D = Math.max(0.8, Math.min((along ? b.h : b.w) * 0.55, 1.6));
  const c = toWorld(b.x + b.w / 2, b.y + b.h / 2);
  const rot = along ? 0 : Math.PI / 2;
  bake.add(roundedBox(L, D, Math.min(0.7, D / 2), 0.95), p.desk, m4(c.x, 0, c.z, rot));
  bake.add(roundedBox(L + 0.4, D + 0.4, Math.min(0.8, D / 2 + 0.2), 0.08), p.deskTop, m4(c.x, 0.95, c.z, rot));
  const n = Math.max(1, Math.min(4, Math.round(L / 2.2)));
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * (L / n);
    const local = new THREE.Vector3(off, 0, -0.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    bake.add(new THREE.BoxGeometry(0.9, 0.55, 0.06), p.screen, m4(c.x + local.x, 1.33, c.z + local.z, rot, -0.15));
  }
}

/** Seats laid out in rows inside a waiting area (kept clear of its doors). */
export function chairSpots(z: Zone, max = 80): Pt[] {
  const b = polygonBounds(z.polygon);
  const out: Pt[] = [];
  const doors = (z.doors ?? []).filter((d) => Array.isArray(d));
  for (let y = b.y + 1.4; y <= b.y + b.h - 1.1 && out.length < max; y += 2.6) {
    for (let x = b.x + 1.2; x <= b.x + b.w - 1.0 && out.length < max; x += 1.5) {
      if (!pointInPolygon(x, y, z.polygon)) continue;
      if (doors.some((d) => Math.hypot(d[0] - x, d[1] - y) < 2)) continue;
      out.push([x, y]);
    }
  }
  return out;
}

function chairs(bake: Baker, z: Zone, p: ScenePalette, toWorld: (x: number, y: number) => THREE.Vector3) {
  for (const [x, y] of chairSpots(z)) {
    const c = toWorld(x, y);
    bake.add(new THREE.BoxGeometry(1.1, 0.45, 0.9), p.chair, m4(c.x, 0.3, c.z));
    bake.add(new THREE.BoxGeometry(1.1, 0.7, 0.16), p.chair, m4(c.x, 0.75, c.z + 0.45));
  }
}

/** Grass, a road below the building, paths to the entrances, and trees. */
function buildSite(width: number, depth: number, entrances: readonly Entrance[], p: ScenePalette, mat: (o?: THREE.MeshStandardMaterialParameters) => THREE.MeshStandardMaterial): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const size = Math.max(width, depth) * 4 + 200;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat({ color: p.ground, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -WORLD.slabThickness - 0.01;
  ground.receiveShadow = true;
  ground.name = "ground";
  out.push(ground);

  const roadZ = depth / 2 + 10;
  const bake = new Baker();
  const y0 = -WORLD.slabThickness;
  bake.add(new THREE.BoxGeometry(size * 0.6, 0.04, 6), p.road, m4(0, y0, roadZ));
  for (let x = -size * 0.3; x < size * 0.3; x += 6) bake.add(new THREE.BoxGeometry(2.6, 0.02, 0.22), p.roadLine, m4(x, y0 + 0.03, roadZ));
  // Paths from bottom-edge entrances down to the road.
  const bottom = entrances.filter((e) => Array.isArray(e.point) && Math.abs(e.point[1] - depth) < 1.5);
  for (const e of bottom) {
    const x = e.point[0] - width / 2;
    const w = e.kind === "ambulance" ? 5 : 3;
    bake.add(new THREE.BoxGeometry(w, 0.03, 10 - 3 + 0.6), e.kind === "ambulance" ? p.road : p.slab, m4(x, y0, depth / 2 + 0.6 + (10 - 3) / 2));
  }
  // Trees around the building, kept clear of entrance paths.
  const crown = new THREE.IcosahedronGeometry(1.4, 0);
  const trunk = new THREE.CylinderGeometry(0.16, 0.2, 1.2, 6);
  const spots: [number, number][] = [];
  for (let z = -depth / 2 + 2; z <= depth / 2 + 4; z += 9) { spots.push([-width / 2 - 6, z], [width / 2 + 6, z]); }
  for (let x = -width / 2 + 4; x <= width / 2 - 2; x += 11) spots.push([x, depth / 2 + 4.5]);
  spots.forEach(([x, z], i) => {
    if (bottom.some((e) => Math.abs(e.point[0] - width / 2 - x) < 5) && z > depth / 2) return;
    const s = 0.8 + (i % 3) * 0.15;
    bake.add(trunk.clone(), p.trunk, m4(x, y0 + 0.6, z));
    const g = crown.clone();
    g.scale(s, s, s);
    bake.add(g, p.tree, m4(x, y0 + 1.9 * s + 0.3, z));
  });
  crown.dispose();
  trunk.dispose();
  const geo = bake.build();
  if (geo) {
    const site = new THREE.Mesh(geo, mat({ vertexColors: true, flatShading: true }));
    site.castShadow = true;
    site.receiveShadow = true;
    site.name = "site";
    out.push(site);
  }
  return out;
}
