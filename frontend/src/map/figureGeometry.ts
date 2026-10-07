// Low-poly figure meshes for the 3D map (one InstancedMesh per model). Each
// model sits on y = 0 inside a unit footprint and faces +X (the direction of
// travel). The state color comes from the instance color; parts carry a
// vertex-color shade so the role reads by shape and accent, not only by color.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { FigureModel } from "./figures";

/** Shade multipliers (vertex color × instance state color). */
const MAIN = 1;
const ACCENT = 0.45;
const LIGHT = 0.75;

type Part = { geo: THREE.BufferGeometry; shade: number; at: [number, number, number] };

function part(geo: THREE.BufferGeometry, at: [number, number, number], shade = MAIN): Part {
  return { geo, shade, at };
}

function build(parts: Part[]): THREE.BufferGeometry {
  const geos = parts.map(({ geo, shade, at }) => {
    const g = (geo.index ? geo.toNonIndexed() : geo);
    if (g !== geo) geo.dispose();
    g.deleteAttribute("uv");
    g.translate(at[0], at[1], at[2]);
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n * 3).fill(shade), 3));
    return g;
  });
  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  return merged;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const head = (r: number) => new THREE.IcosahedronGeometry(r, 0);

function person(body: Part[], headY = 0.7): Part[] {
  return [...body, part(head(0.14), [0, headY, 0])];
}

/** Geometry and height (in footprint units) for a model; `kind` only matters for "other". */
export function figureGeometry(model: FigureModel, kind = ""): { geo: THREE.BufferGeometry; height: number } {
  switch (model) {
    case "bed":
      return { height: 0.5, geo: build([
        part(box(1, 0.3, 0.6), [0, 0.15, 0]),
        part(box(0.08, 0.5, 0.6), [-0.46, 0.25, 0], ACCENT), // headboard
        part(box(0.2, 0.07, 0.42), [-0.3, 0.335, 0], LIGHT), // pillow
      ]) };
    case "person":
      return { height: 0.84, geo: build(person([part(cyl(0.2, 0.24, 0.56), [0, 0.28, 0])])) };
    case "nurse":
      return { height: 0.9, geo: build(person([
        part(cyl(0.19, 0.25, 0.56), [0, 0.28, 0]),
        part(box(0.22, 0.07, 0.22), [0, 0.86, 0], ACCENT), // cap
      ])) };
    case "doctor":
      return { height: 0.84, geo: build(person([
        part(cyl(0.16, 0.3, 0.6), [0, 0.3, 0]), // long flared coat
        part(cyl(0.17, 0.17, 0.06), [0, 0.57, 0], ACCENT), // collar
      ])) };
    case "cleaner":
      return { height: 0.84, geo: build([
        part(cyl(0.2, 0.24, 0.56), [-0.12, 0.28, 0]),
        part(head(0.14), [-0.12, 0.7, 0]),
        part(box(0.3, 0.26, 0.34), [0.3, 0.13, 0], ACCENT), // cart, pushed ahead
        part(cyl(0.025, 0.025, 0.7, 4), [0.3, 0.6, 0.12], ACCENT), // mop handle
      ]) };
    case "patient":
      return { height: 0.95, geo: build(person([
        part(cyl(0.25, 0.27, 0.5), [0, 0.25, 0]), // gown
        part(cyl(0.025, 0.025, 0.95, 4), [0, 0.475, -0.36], ACCENT), // IV pole
        part(box(0.1, 0.14, 0.04), [0, 0.86, -0.36], LIGHT), // IV bag
      ], 0.64)) };
    case "ambulance":
    case "vehicle": {
      const parts = [
        part(box(0.68, 0.5, 0.5), [-0.15, 0.3, 0]), // box body
        part(box(0.3, 0.36, 0.48), [0.34, 0.23, 0]), // cab
        part(box(0.04, 0.16, 0.42), [0.5, 0.32, 0], ACCENT), // windscreen
        part(box(0.12, 0.08, 0.5), [0.2, 0.05, 0], ACCENT), // wheels (front)
        part(box(0.12, 0.08, 0.5), [-0.35, 0.05, 0], ACCENT), // wheels (rear)
      ];
      if (model === "ambulance") parts.push(part(box(0.1, 0.06, 0.36), [0.3, 0.44, 0], LIGHT)); // light bar
      return { height: 0.58, geo: build(parts) };
    }
    case "equipment":
      return { height: 0.86, geo: build([
        part(cyl(0.24, 0.24, 0.05), [0, 0.025, 0], ACCENT), // base
        part(cyl(0.03, 0.03, 0.62, 4), [0, 0.35, 0], ACCENT), // pole
        part(box(0.36, 0.26, 0.2), [0, 0.73, 0]), // device
      ]) };
    default:
      return otherGeometry(kind);
  }
}

/** Unknown kinds keep the 0.1 shapes: a box for plain assets, one of four shapes per kind otherwise. */
function otherGeometry(kind: string): { geo: THREE.BufferGeometry; height: number } {
  const H = 0.9;
  const k = kind.toLowerCase();
  if (k === "" || k === "asset") return { height: 0.45, geo: build([part(box(1, 0.45, 1), [0, 0.225, 0])]) };
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  switch (h % 4) {
    case 0: return { height: H, geo: build([part(cyl(0.5, 0.5, H, 12), [0, H / 2, 0])]) };
    case 1: return { height: H, geo: build([part(new THREE.ConeGeometry(0.55, H, 12), [0, H / 2, 0])]) };
    case 2: return { height: H, geo: build([part(box(1, H, 1), [0, H / 2, 0])]) };
    default: return { height: 1.1, geo: build([part(new THREE.OctahedronGeometry(0.55), [0, 0.55, 0])]) };
  }
}
