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
  // Indexed throughout so the GPU's vertex cache can reuse shared corners (matters on software renderers).
  const geos = parts.map(({ geo: g, shade, at }) => {
    if (!g.index) g.setIndex([...Array(g.getAttribute("position").count).keys()]);
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
/** Open-ended tapered body: the head covers the open top, the floor the bottom (fewest vertices). */
const body = (rt: number, rb: number, h: number) => new THREE.CylinderGeometry(rt, rb, h, 6, 1, true);
/** Thin pole (IV stand, mop handle). */
const pole = (h: number) => new THREE.CylinderGeometry(0.025, 0.025, h, 3, 1, true);
const head = () => new THREE.OctahedronGeometry(0.15);

/**
 * Geometry and height (in footprint units) for a model.
 * Vertex counts are kept low (≈ 40–100 per figure): software renderers are vertex bound at 2,000 figures.
 */
export function figureGeometry(model: FigureModel): { geo: THREE.BufferGeometry; height: number } {
  switch (model) {
    case "bed":
      return { height: 0.5, geo: build([
        part(box(1, 0.3, 0.6), [0, 0.15, 0]),
        part(box(0.08, 0.5, 0.6), [-0.46, 0.25, 0], ACCENT), // headboard
        part(box(0.2, 0.07, 0.42), [-0.3, 0.335, 0], LIGHT), // pillow
      ]) };
    case "person":
      return { height: 0.86, geo: build([part(body(0.12, 0.24, 0.6), [0, 0.3, 0]), part(head(), [0, 0.71, 0])]) };
    case "nurse":
      return { height: 0.92, geo: build([
        part(body(0.12, 0.25, 0.6), [0, 0.3, 0]),
        part(head(), [0, 0.71, 0]),
        part(box(0.24, 0.07, 0.24), [0, 0.86, 0], ACCENT), // cap
      ]) };
    case "doctor":
      return { height: 0.86, geo: build([
        part(body(0.12, 0.32, 0.62), [0, 0.31, 0]), // long flared coat
        part(head(), [0, 0.72, 0]),
        part(box(0.06, 0.22, 0.26), [0.13, 0.45, 0], ACCENT), // chest panel (stethoscope, badge)
      ]) };
    case "cleaner":
      return { height: 0.86, geo: build([
        part(body(0.12, 0.24, 0.6), [-0.12, 0.3, 0]),
        part(head(), [-0.12, 0.71, 0]),
        part(box(0.3, 0.26, 0.34), [0.3, 0.13, 0], ACCENT), // cart, pushed ahead
        part(pole(0.7), [0.3, 0.6, 0.12], ACCENT), // mop handle
      ]) };
    case "patient":
      return { height: 0.95, geo: build([
        part(body(0.12, 0.28, 0.52), [0, 0.26, 0]), // gown
        part(head(), [0, 0.63, 0]),
        part(pole(0.95), [0, 0.475, -0.36], ACCENT), // IV pole
        part(box(0.1, 0.14, 0.04), [0, 0.86, -0.36], LIGHT), // IV bag
      ]) };
    case "ambulance":
    case "vehicle": {
      const parts = [
        part(box(0.68, 0.5, 0.5), [-0.15, 0.27, 0]), // box body
        part(box(0.3, 0.36, 0.48), [0.34, 0.2, 0]), // cab
        part(box(0.04, 0.16, 0.42), [0.5, 0.29, 0], ACCENT), // windscreen
      ];
      if (model === "ambulance") parts.push(part(box(0.1, 0.06, 0.36), [0.3, 0.41, 0], LIGHT)); // light bar
      return { height: 0.55, geo: build(parts) };
    }
    case "equipment":
      return { height: 0.86, geo: build([
        part(box(0.4, 0.05, 0.4), [0, 0.025, 0], ACCENT), // base
        part(pole(0.62), [0, 0.35, 0], ACCENT), // pole
        part(box(0.36, 0.26, 0.2), [0, 0.73, 0]), // device
      ]) };
    default:
      return otherGeometry();
  }
}

/** Unknown kinds (and records without a kind) fall back to the box shape (ADR 0006). */
function otherGeometry(): { geo: THREE.BufferGeometry; height: number } {
  return { height: 0.45, geo: build([part(box(1, 0.45, 1), [0, 0.225, 0])]) };
}
