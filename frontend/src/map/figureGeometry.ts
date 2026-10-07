// Figure templates for the 3D map (built once per model and pose, then baked
// into merged batches by figureLayer). The models themselves live in
// map/models/modelGeometry.ts; colors in map/models/palette.ts.
import * as THREE from "three";
import type { FigureModel } from "./figures";
import { modelTemplate, type ModelTemplate } from "./models/modelGeometry";

const cache = new Map<string, ModelTemplate>();

/** Shared, read-only template for a model (lying only applies to models that can lie). */
export function figureTemplate(model: FigureModel, lying = false): ModelTemplate {
  const key = `${model}${lying ? ":lying" : ""}`;
  let t = cache.get(key);
  if (!t) { t = modelTemplate(model, lying); cache.set(key, t); }
  return t;
}

/** A standalone geometry of a model (tests, tools). Colors are not applied. */
export function figureGeometry(model: FigureModel, lying = false): { geo: THREE.BufferGeometry; height: number } {
  const t = figureTemplate(model, lying);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(t.pos.slice(), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(t.nrm.slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(t.index.slice(), 1));
  return { geo, height: t.height };
}
