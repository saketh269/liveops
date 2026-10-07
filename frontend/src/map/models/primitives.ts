// Tiny indexed primitives for the figure models. Vertex counts are what the
// software renderers (SwiftShader, llvmpipe) pay for at 2,000 figures, so every
// shape is the fewest vertices that still reads at map scale:
//   cuboid 20 (no bottom face), frustum 2·seg (+1 per cap), gem seg+2, disc seg+1.
import * as THREE from "three";

function make(pos: number[], nrm: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** Box centred on x/z, standing on y = 0; the bottom face is left out (it faces the floor). */
export function cuboid(w: number, h: number, d: number): THREE.BufferGeometry {
  const x = w / 2, z = d / 2;
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], e: number[], n: number[]) => {
    const o = pos.length / 3;
    pos.push(...a, ...b, ...c, ...e);
    for (let i = 0; i < 4; i++) nrm.push(...n);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad([-x, h, -z], [-x, h, z], [x, h, z], [x, h, -z], [0, 1, 0]); // top
  quad([x, 0, z], [x, 0, -z], [x, h, -z], [x, h, z], [1, 0, 0]); // +x
  quad([-x, 0, -z], [-x, 0, z], [-x, h, z], [-x, h, -z], [-1, 0, 0]); // -x
  quad([-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z], [0, 0, 1]); // +z
  quad([x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z], [0, 0, -1]); // -z
  return make(pos, nrm, idx);
}

/**
 * Tapered column on y = 0 with smooth sides (bodies, legs, arms, poles).
 * `top`/`bottom` close the ends with a centre vertex each.
 */
export function frustum(rBottom: number, rTop: number, h: number, seg: number, caps: { top?: boolean; bottom?: boolean } = {}): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const slope = (rBottom - rTop) / h;
  for (const [y, r] of [[0, rBottom], [h, rTop]] as const) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + Math.PI / seg;
      const cx = Math.cos(a), sz = Math.sin(a);
      pos.push(cx * r, y, sz * r);
      // Side normal; the top ring leans up a little so a capped top reads as rounded shoulders.
      const up = y > 0 && caps.top ? 0.7 : y === 0 && caps.bottom ? -0.7 : 0;
      const n = new THREE.Vector3(cx, slope + up, sz).normalize();
      nrm.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    idx.push(i, seg + i, seg + j, i, seg + j, j);
  }
  if (caps.top) {
    const c = pos.length / 3;
    pos.push(0, h, 0); nrm.push(0, 1, 0);
    for (let i = 0; i < seg; i++) idx.push(c, seg + (i + 1) % seg, seg + i);
  }
  if (caps.bottom) {
    const c = pos.length / 3;
    pos.push(0, 0, 0); nrm.push(0, -1, 0);
    for (let i = 0; i < seg; i++) idx.push(c, i, (i + 1) % seg);
  }
  return make(pos, nrm, idx);
}

/** Smooth rounded blob centred on y = 0 (heads, lights): two poles and one ring. */
export function gem(r: number, seg = 6, stretch = 1.1): THREE.BufferGeometry {
  const pos: number[] = [0, r * stretch, 0], nrm: number[] = [0, 1, 0], idx: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    nrm.push(Math.cos(a), 0, Math.sin(a));
  }
  pos.push(0, -r * stretch, 0); nrm.push(0, -1, 0);
  const bottom = seg + 1;
  for (let i = 0; i < seg; i++) {
    const a = 1 + i, b = 1 + (i + 1) % seg;
    idx.push(0, b, a, bottom, a, b);
  }
  return make(pos, nrm, idx);
}

/** Flat disc on y = 0 facing up (status ring under a person). */
export function disc(r: number, seg = 6): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0], nrm: number[] = [0, 1, 0], idx: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    nrm.push(0, 1, 0);
    idx.push(0, 1 + (i + 1) % seg, 1 + i);
  }
  return make(pos, nrm, idx);
}

/** Wheel with its axle along z, centred on y = 0. */
export function wheel(r: number, width: number, seg = 6): THREE.BufferGeometry {
  const g = frustum(r, r, width, seg, { top: true, bottom: true });
  g.translate(0, -width / 2, 0);
  g.rotateX(Math.PI / 2);
  return g;
}
