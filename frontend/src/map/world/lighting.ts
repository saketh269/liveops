// Soft daylight: hemisphere fill + warm directional sun with soft PCF shadows sized
// to the floor, and the renderer settings that go with it (ACES, sRGB, exposure).
import * as THREE from "three";
import type { ScenePalette } from "./style";

export type Lights = { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight; group: THREE.Group };

/**
 * Sun direction (from the target): high and from the left, a little in front, so the
 * soft shadows fall to the right where the default camera can see them (from the
 * camera's side they would hide behind the walls that cast them).
 */
const SUN_DIR = new THREE.Vector3(-60, 50, 8).normalize();

export function createLights(software: boolean): Lights {
  const group = new THREE.Group();
  group.name = "lights";
  const hemi = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  // Software renderers (SwiftShader/llvmpipe) pay per shadow texel: a smaller, cheaper map there.
  const size = software ? 1024 : 2048;
  sun.shadow.mapSize.set(size, size);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  group.add(hemi, sun, sun.target);
  return { hemi, sun, group };
}

export function applyLightPalette(l: Lights, p: ScenePalette) {
  l.hemi.color.setStyle(p.hemiSky);
  l.hemi.groundColor.setStyle(p.hemiGround);
  l.hemi.intensity = p.hemiIntensity;
  l.sun.color.setStyle(p.sunColor);
  l.sun.intensity = p.sunIntensity;
}

/** Shadow camera bounds that cover a `width` × `depth` floor (centred on the origin) plus `pad` metres. */
export function shadowBounds(width: number, depth: number, pad = 6): { half: number; distance: number } {
  const half = Math.hypot(width, depth) / 2 + pad;
  return { half, distance: half * 2.5 };
}

/** Aim the sun at the floor and fit its shadow camera to it. */
export function fitSun(l: Lights, width: number, depth: number) {
  const { half, distance } = shadowBounds(width, depth);
  l.sun.position.copy(SUN_DIR).multiplyScalar(distance);
  l.sun.target.position.set(0, 0, 0);
  const cam = l.sun.shadow.camera;
  cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
  cam.near = 1; cam.far = distance * 2;
  cam.updateProjectionMatrix();
  l.sun.shadow.needsUpdate = true;
}

/**
 * Renderer settings. On software renderers (SwiftShader/llvmpipe) every shadow texel
 * and filter tap costs CPU: plain PCF instead of soft PCF, and the shadow map is only
 * redrawn when the static world changes (figures cast no shadows there), not every frame.
 */
export function configureRenderer(r: THREE.WebGLRenderer, p: ScenePalette, software = false) {
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = p.exposure;
  r.shadowMap.enabled = !software;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.shadowMap.autoUpdate = !software;
  r.shadowMap.needsUpdate = true;
}
