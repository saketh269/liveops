// Materials for the figure batches. Animation runs on the GPU from one shared
// clock uniform, so a striding walker or a flashing light bar costs no CPU
// work and no buffer upload per frame:
//  - `aFlash` (per vertex, ±1 on an active lamp) blinks the ambulance light bar;
//  - walkers' batches add `aSwing` (template stride weight) and `aWalk`
//    (heading·scale, phase, bob) and swing legs and arms about hip and shoulder.
import * as THREE from "three";

/** Stride: radians of the swing per second, and how far a foot travels (footprint units at weight 1). */
export const STRIDE_RATE = 9;
export const STRIDE_REACH = 0.16;
/** Light bar flashes per second (radians). */
export const FLASH_RATE = 14;

/** Shared uniforms: time in seconds (wrapped so sin() keeps float precision) and steady lamps (reduced motion). */
export type FigureUniforms = { uTime: { value: number }; uSteady: { value: number } };

/** 200π: a whole number of periods for both rates above, so wrapping never jumps. */
const WRAP = 200 * Math.PI;

export function figureUniforms(): FigureUniforms {
  return { uTime: { value: 0 }, uSteady: { value: 0 } };
}

export function tickUniforms(u: FigureUniforms, nowMs: number, steady: boolean) {
  u.uTime.value = (nowMs / 1000) % WRAP;
  u.uSteady.value = steady ? 1 : 0;
}

export function figureMaterial(u: FigureUniforms, walking: boolean): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uSteady = u.uSteady;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
uniform float uTime;
uniform float uSteady;
attribute float aFlash;
varying float vGlow;
${walking ? "attribute float aSwing;\nattribute vec4 aWalk;" : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vGlow = aFlash == 0.0 ? 0.0 : (uSteady > 0.5 ? 1.0 : step(0.0, aFlash * sin(uTime * ${FLASH_RATE.toFixed(1)})));
${walking ? `float stride = sin(uTime * ${STRIDE_RATE.toFixed(1)} + aWalk.z);
transformed.xz += aWalk.xy * (aSwing * ${STRIDE_REACH.toFixed(3)} * stride);
transformed.y += aWalk.w * abs(stride);` : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * 1.8;");
  };
  m.customProgramCacheKey = () => (walking ? "figures-walk" : "figures-rest");
  return m;
}
