import * as THREE from "three";
import { FigureLayer, type LayerEntry } from "../figureLayer";
import { figureTemplate } from "../figureGeometry";
import { FIGURE_LABELS, figureModel, isPerson, type FigureModel } from "../figures";
import { PAINTS } from "./modelGeometry";
import { MODEL_PALETTE_DARK, MODEL_PALETTE_LIGHT, getModelPalette, setModelPalette } from "./palette";
import { roleModel } from "./roles";

const world = (x: number, y: number, out: THREE.Vector3) => out.set(x, 0, y);
const sphere = new THREE.Sphere(new THREE.Vector3(), 100);
const ALL = Object.keys(FIGURE_LABELS) as FigureModel[];

describe("role text → model", () => {
  test.each([
    ["Registered Nurse", "nurse"], ["Charge Nurse", "nurse"], ["Patient Care Tech", "nurse"], ["RN", "nurse"], ["CNA", "nurse"],
    ["Emergency Physician", "doctor"], ["Intensivist", "doctor"], ["Hospitalist", "doctor"], ["Cardiologist", "doctor"],
    ["Obstetrician", "doctor"], ["Pediatrician", "doctor"], ["Dr. Okafor", "doctor"], ["Surgical Resident", "doctor"],
    ["Transporter", "transporter"], ["Patient Transport", "transporter"], ["Porter", "transporter"],
    ["EVS Technician", "cleaner"], ["Environmental Services", "cleaner"], ["Housekeeping", "cleaner"],
    ["Paramedic", "paramedic"], ["EMT-B", "paramedic"],
    ["Bed Manager", "manager"], ["House Supervisor", "manager"], ["Nurse Manager", "manager"], ["Patient Flow Coordinator", "manager"],
    ["patient", "patient"], ["  REGISTERED NURSE  ", "nurse"],
  ])("%s → %s", (role, model) => {
    expect(roleModel(role)).toBe(model);
    expect(figureModel("staff", role)).toBe(model);
  });

  test("technicians and technologists are not doctors; unknown roles fall back by kind", () => {
    expect(roleModel("Radiology Technologist")).toBeNull();
    expect(roleModel("Pharmacy Technician")).toBeNull();
    expect(roleModel("Volunteer")).toBeNull();
    expect(roleModel("")).toBeNull();
    expect(roleModel(42)).toBeNull();
    expect(figureModel("staff", "Volunteer")).toBe("person");
    expect(figureModel("nurse", "Volunteer")).toBe("nurse");
    expect(figureModel("transporter")).toBe("transporter");
    expect(figureModel("vehicle", "Ambulance 7")).toBe("ambulance");
    expect(figureModel("bed", "Registered Nurse")).toBe("bed");
    expect(isPerson("transporter") && isPerson("manager") && isPerson("paramedic")).toBe(true);
  });
});

describe("model templates", () => {
  // Software renderers are vertex bound at 2,000 figures: keep every model within budget.
  const BUDGET: Partial<Record<FigureModel, number>> = { bed: 180, ambulance: 200, vehicle: 140, equipment: 90, other: 24 };
  test.each(ALL)("%s stays within its vertex budget and uses known paints", (m) => {
    const t = figureTemplate(m);
    expect(t.verts).toBeLessThanOrEqual(BUDGET[m] ?? 120); // people ≤ 120
    expect(t.index.length % 3).toBe(0);
    expect(Math.max(...t.index)).toBeLessThan(t.verts);
    for (const p of t.paint) expect(p).toBeLessThan(PAINTS.length);
    // Every model shows the record's state somewhere.
    expect(t.paint.includes(PAINTS.indexOf("state"))).toBe(true);
    expect(t.height).toBeGreaterThan(0.4);
  });

  test("people have striding legs and skin; others are rigid", () => {
    for (const m of ALL) {
      const t = figureTemplate(m);
      expect(t.walks).toBe(isPerson(m));
      if (isPerson(m)) {
        expect(t.swing.some((s) => s > 0.9) && t.swing.some((s) => s < -0.9)).toBe(true);
        expect(t.paint.includes(PAINTS.indexOf("skin"))).toBe(true);
      }
    }
  });

  test("only the ambulance has a light bar, with lamps in both phases", () => {
    for (const m of ALL) {
      const f = figureTemplate(m).flash;
      if (m === "ambulance") expect(f.includes(1) && f.includes(-1)).toBe(true);
      else expect(f.every((v) => v === 0)).toBe(true);
    }
  });

  test("a lying patient fits the bed", () => {
    const lying = figureTemplate("patient", true), bed = figureTemplate("bed");
    expect(lying).not.toBe(figureTemplate("patient"));
    expect(figureTemplate("nurse", true)).toBe(figureTemplate("nurse")); // only patients lie
    const box = (pos: Float32Array) => new THREE.Box3().setFromArray(pos);
    const lb = box(lying.pos), bb = box(bed.pos);
    expect(lb.min.x).toBeGreaterThanOrEqual(bb.min.x);
    expect(lb.max.x).toBeLessThanOrEqual(bb.max.x);
    expect(lb.min.y).toBeGreaterThan(0.25); // on the mattress, not the floor
  });
});

const entry = (id: string, key: FigureModel, x: number, extra: Partial<LayerEntry["pose"]> = {}, moving = false, color = new THREE.Color(1, 0, 0)): LayerEntry =>
  ({ id, key, pose: { x, y: 0, heading: 0, level: 0, size: 1, ...extra }, moving, color });
const meshes = (l: FigureLayer) => l.group.children as THREE.Mesh[];
const mesh = (l: FigureLayer, name: string) => meshes(l).find((m) => m.name === name);
const slotDrawn = (m: THREE.Mesh, slot: number, verts: number) => {
  const p = m.geometry.getAttribute("position").array as Float32Array;
  return p.subarray(slot * verts * 3, (slot + 1) * verts * 3).some((v) => v !== 0);
};

describe("figure layer", () => {
  test("pose 'lying' moves a patient into the bed batch and back; walkers always stand", () => {
    const l = new FigureLayer(world);
    l.rebuild([entry("p1", "patient", 0, { pose: "lying" }), entry("p2", "patient", 3), entry("n", "nurse", 6, { pose: "lying" })], sphere);
    const rest = mesh(l, "figures:patient")!, lying = mesh(l, "figures:patient:lying")!;
    const sv = figureTemplate("patient").verts, lv = figureTemplate("patient", true).verts;
    expect(l.poseOf("p1")).toBe("lying");
    expect(l.poseOf("p2")).toBe("standing");
    expect(l.poseOf("n")).toBe("standing"); // only patients lie
    expect(slotDrawn(lying, 0, lv) && !slotDrawn(rest, 0, sv)).toBe(true);
    expect(slotDrawn(rest, 1, sv) && !slotDrawn(lying, 1, lv)).toBe(true);
    expect(l.heightOf("p1")).toBeCloseTo(figureTemplate("patient", true).height);

    l.write("p1", { x: 1, y: 0, heading: 1, level: 0, size: 1, pose: "lying" }, true); // getting up and walking
    expect(l.poseOf("p1")).toBe("standing");
    expect(slotDrawn(lying, 0, lv)).toBe(false);
    l.write("p1", { x: 0, y: 0, heading: 1, level: 0, size: 1 }, false);
    expect(slotDrawn(rest, 0, sv)).toBe(true);
    l.write("p1", { x: 0, y: 0, heading: 1, level: 0, size: 1, pose: "lying" }, false);
    expect(slotDrawn(lying, 0, lv) && !slotDrawn(rest, 0, sv)).toBe(true);
  });

  test("a lying patient is picked over the bed's middle, the bed at its head", () => {
    const l = new FigureLayer(world);
    const e = [entry("bed", "bed", 0), entry("pt", "patient", 0, { pose: "lying" })];
    l.rebuild(e, sphere);
    const poses = new Map(e.map((x) => [x.id, x.pose]));
    const down = (x: number) => new THREE.Ray(new THREE.Vector3(x, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(l.pick(down(0), (id) => poses.get(id))).toBe("pt");
    expect(l.pick(down(-0.45), (id) => poses.get(id))).toBe("bed");
  });

  test("walkers carry stride data; the resting batch does not", () => {
    const l = new FigureLayer(world);
    l.rebuild([entry("a", "doctor", 0, { heading: Math.PI / 2 }, true)], sphere);
    const walkers = mesh(l, "walkers:doctor")!;
    expect(mesh(l, "figures:doctor")!.geometry.getAttribute("aWalk")).toBeUndefined();
    const w = walkers.geometry.getAttribute("aWalk").array as Float32Array;
    expect(Math.hypot(w[0], w[1])).toBeCloseTo(1); // heading direction × scale
    expect(w[1]).toBeCloseTo(1); // heading +y in layout = +z in world: the stride runs along +z
    expect((walkers.geometry.getAttribute("aSwing").array as Float32Array).some((s) => s !== 0)).toBe(true);
  });

  test("300 mixed figures draw in one call per model", () => {
    const l = new FigureLayer(world);
    const models: FigureModel[] = ["bed", "patient", "nurse", "doctor", "cleaner", "transporter", "paramedic", "manager", "ambulance", "equipment"];
    l.rebuild(Array.from({ length: 300 }, (_, i) => entry(`f${i}`, models[i % models.length], i)), sphere);
    expect(meshes(l).length).toBe(models.length);
    expect(l.count).toBe(300);
  });

  test("the light bar flashes only for in-use / alert ambulances", () => {
    document.documentElement.style.setProperty("--state-in-use", "#2f62b5");
    document.documentElement.style.setProperty("--state-free", "#1d8a4e");
    try {
      const l = new FigureLayer(world);
      const inUse = new THREE.Color().setStyle("#2f62b5"), free = new THREE.Color().setStyle("#1d8a4e");
      l.rebuild([entry("a", "ambulance", 0, {}, false, inUse), entry("b", "ambulance", 3, {}, false, free)], sphere);
      const f = mesh(l, "figures:ambulance")!.geometry.getAttribute("aFlash").array as Float32Array;
      const v = figureTemplate("ambulance").verts;
      expect(f.subarray(0, v).some((x) => x !== 0)).toBe(true);
      expect(f.subarray(v, 2 * v).every((x) => x === 0)).toBe(true);
      l.setColor("a", free);
      expect(f.subarray(0, v).every((x) => x === 0)).toBe(true);
      expect(l.colorOf("a")).toBe(`#${free.getHexString()}`); // colorOf still reports the state color
    } finally {
      document.documentElement.style.removeProperty("--state-in-use");
      document.documentElement.style.removeProperty("--state-free");
    }
  });

  test("a dirty (cleaning-state) bed shows a soiled sheet; other beds keep the clean one", () => {
    document.documentElement.style.setProperty("--state-cleaning", "#c98a1a");
    document.documentElement.style.setProperty("--state-free", "#1d8a4e");
    try {
      const l = new FigureLayer(world);
      const dirty = new THREE.Color().setStyle("#c98a1a"), free = new THREE.Color().setStyle("#1d8a4e");
      l.rebuild([entry("a", "bed", 0, {}, false, dirty), entry("b", "bed", 3, {}, false, free)], sphere);
      const col = mesh(l, "figures:bed")!.geometry.getAttribute("color").array as Float32Array;
      const t = figureTemplate("bed"), v = t.verts, at = t.paint.indexOf(PAINTS.indexOf("sheet"));
      const rgb = (slot: number) => Array.from(col.subarray((slot * v + at) * 3, (slot * v + at) * 3 + 3));
      expect(rgb(0)).not.toEqual(rgb(1));
      l.setColor("a", free);
      expect(rgb(0)).toEqual(rgb(1));
    } finally {
      document.documentElement.style.removeProperty("--state-cleaning");
      document.documentElement.style.removeProperty("--state-free");
    }
  });

  test("palette overrides repaint role colors; state parts keep the state color", () => {
    const l = new FigureLayer(world);
    l.rebuild([entry("n", "nurse", 0)], sphere);
    const col = mesh(l, "figures:nurse")!.geometry.getAttribute("color").array as Float32Array;
    const t = figureTemplate("nurse");
    const scrub = t.paint.indexOf(PAINTS.indexOf("scrubs")), state = t.paint.indexOf(PAINTS.indexOf("state"));
    const before = col[scrub * 3];
    try {
      setModelPalette("light", { scrubs: "#ff00ff" });
      l.flush(0);
      expect(col[scrub * 3]).not.toBeCloseTo(before);
      expect(col[scrub * 3 + 1]).toBeCloseTo(0);
      expect([col[state * 3], col[state * 3 + 1]]).toEqual([1, 0]);
    } finally {
      setModelPalette("light", {});
    }
    expect(getModelPalette("light").scrubs).toBe(MODEL_PALETTE_LIGHT.scrubs);
  });
});

test("both palettes define every key with a parsable color", () => {
  for (const p of [MODEL_PALETTE_LIGHT, MODEL_PALETTE_DARK]) {
    for (const k of PAINTS) {
      if (k === "state") continue;
      const v = k === "skin" ? p.skin : [p[k]];
      for (const c of v) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  }
});
