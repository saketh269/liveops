import type { Zone } from "../../api/types";
import { groundLabel, labelSpot, paintScale } from "./floorPaint";

const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

describe("labelSpot", () => {
  test("a door facing the camera (bottom edge) puts the name just outside, on the corridor", () => {
    const z: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 0, 4, 5), doors: [[2, 5]] };
    const [x, y] = labelSpot(z, { width: 20, depth: 20 });
    expect(x).toBeCloseTo(2);
    expect(y).toBeGreaterThan(5);
    expect(y).toBeLessThan(6);
  });

  test("a door facing away (top edge) puts the name just inside, where the front wall cannot hide it", () => {
    const z: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 10, 4, 5), doors: [[2, 10]] };
    const [x, y] = labelSpot(z, { width: 20, depth: 20 });
    expect(x).toBeCloseTo(2);
    expect(y).toBeGreaterThan(10);
    expect(y).toBeLessThanOrEqual(11.3 + 1e-9);
  });

  test("an outside name never leaves the floor; no door means the centre", () => {
    const edge: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 15, 4, 5), doors: [[2, 20]] };
    expect(labelSpot(edge, { width: 20, depth: 20 })[1]).toBeLessThan(20);
    expect(labelSpot({ id: "c", name: "c", kind: "room", polygon: rect(0, 0, 4, 6) })).toEqual([2, 3]);
  });
});

describe("paintScale", () => {
  test("keeps the canvas within the limit and the resolution within 4..32 px/m", () => {
    expect(paintScale(64, 30, 2048)).toBe(32);
    expect(paintScale(200, 50, 2048)).toBeCloseTo(10.24);
    expect(paintScale(5000, 10, 2048)).toBe(4);
  });
});

// --- polish fix ---
describe("groundLabel", () => {
  const measure = (t: string) => t.length * 0.6; // width at a 1 px font
  test("machine names are humanized; real names stay", () => {
    expect(groundLabel({ id: "fleet-a", name: "at_hospital_offloading", kind: "bay" }, 500, 10, measure)).toBe("At hospital · offloading");
    expect(groundLabel({ id: "x", name: "ED Waiting Room", kind: "waiting" }, 500, 10, measure)).toBe("ED Waiting Room");
  });
  test("a half room too narrow for its full id gets the short form, so neighbours never run together", () => {
    expect(groundLabel({ id: "3W-305A", name: "3W-305A", kind: "room" }, 100, 20, measure)).toBe("3W-305A");
    expect(groundLabel({ id: "3W-305A", name: "3W-305A", kind: "room" }, 30, 20, measure)).toBe("305A");
  });
});
