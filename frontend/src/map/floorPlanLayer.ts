// A floor plan image drawn on the 3D floor, under assets and over the zone fills.
// Light theme: the plan multiplies onto the floor (white paper vanishes, lines
// darken). Dark theme (`--plan-invert: 1`): the image is inverted and added, so
// a dark floor shows light lines. Zone colors stay visible either way.
import * as THREE from "three";
import type { PlanView } from "./floors";
import { readToken } from "./stateColors";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Output is written as is (no colour space conversion), like the rest of the
// scene after its own encoding, so blending happens in display space.
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
uniform float invert;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(map, vUv);
  vec3 c = mix(t.rgb, vec3(1.0) - t.rgb, invert);
  vec3 neutral = vec3(1.0 - invert); // multiply by white / add black = no change
  gl_FragColor = vec4(mix(neutral, c, opacity * t.a), 1.0);
}`;

const PLAN_Y = 0.03; // above zone fills (0.02), below zone outlines (0.04)

export class FloorPlanLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private texture: THREE.Texture | null = null;
  private url = "";
  private plan: PlanView | null = null;
  private width = 0;
  private depth = 0;
  private uniforms = { map: { value: null as THREE.Texture | null }, opacity: { value: 1 }, invert: { value: 0 } };
  private loader = new THREE.TextureLoader();
  private disposed = false;

  constructor() {
    this.group.name = "floor-plan";
    this.refreshTheme();
  }

  /** Size of the floor the plan sits on (layout units). */
  setFloor(width: number, depth: number) {
    this.width = width;
    this.depth = depth;
    this.place();
  }

  setPlan(plan: PlanView | null) {
    this.plan = plan;
    if (!plan) {
      this.clear();
      return;
    }
    this.uniforms.opacity.value = plan.opacity;
    if (plan.url !== this.url) {
      this.clear();
      this.url = plan.url;
      const url = plan.url;
      this.loader.load(
        url,
        (tex) => {
          if (this.disposed || url !== this.url) { tex.dispose(); return; }
          tex.anisotropy = 4;
          this.texture = tex;
          this.uniforms.map.value = tex;
          this.build();
        },
        undefined,
        () => { /* unreadable image: the floor is drawn without it; the editor reports upload problems */ },
      );
    }
    this.place();
  }

  /** True while a plan image is loaded and shown (for tests and debugging). */
  get visible(): boolean {
    return !!this.mesh && this.mesh.visible;
  }

  refreshTheme() {
    const v = Number(readToken("--plan-invert"));
    const invert = v > 0 ? 1 : 0;
    this.uniforms.invert.value = invert;
    if (this.mesh) this.applyBlending(this.mesh.material, invert);
  }

  private applyBlending(m: THREE.ShaderMaterial, invert: number) {
    if (invert) {
      m.blending = THREE.AdditiveBlending;
    } else {
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.DstColorFactor;
      m.blendDst = THREE.ZeroFactor;
    }
    m.needsUpdate = true;
  }

  private build() {
    if (this.mesh || !this.texture) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    });
    this.applyBlending(mat, this.uniforms.invert.value);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.rotation.x = -Math.PI / 2; // image top → far side (layout y = 0), as in the 2D view
    mesh.renderOrder = 1; // after the transparent zone fills
    this.mesh = mesh;
    this.group.add(mesh);
    this.place();
  }

  private place() {
    const p = this.plan;
    if (!this.mesh || !p) return;
    this.mesh.position.set(p.x + p.w / 2 - this.width / 2, PLAN_Y, p.y + p.h / 2 - this.depth / 2);
    this.mesh.scale.set(p.w, p.h, 1);
    this.mesh.visible = p.w > 0 && p.h > 0;
  }

  private clear() {
    this.url = "";
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.texture?.dispose();
    this.texture = null;
    this.uniforms.map.value = null;
  }

  dispose() {
    this.disposed = true;
    this.clear();
  }
}
