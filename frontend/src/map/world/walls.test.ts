import type { Zone } from "../../api/types";
import type { Pt } from "../placement";
import { doorGaps, isNurseStation, isWalled, planWalls, type Seg } from "./walls";

const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const len = (s: Seg) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
const total = (segs: Seg[]) => segs.reduce((t, s) => t + len(s), 0);
/** Segments lying on the horizontal line y = v. */
const onY = (segs: Seg[], v: number) => segs.filter((s) => Math.abs(s.a[1] - v) < 1e-6 && Math.abs(s.b[1] - v) < 1e-6);

describe("which zones get walls", () => {
  test("rooms and waiting areas do; nurse stations, corridors and unknown kinds do not", () => {
    expect(isWalled({ id: "r", name: "r", kind: "room", polygon: rect(0, 0, 1, 1) })).toBe(true);
    expect(isWalled({ id: "w", name: "ED Waiting Room", kind: "waiting", polygon: rect(0, 0, 1, 1) })).toBe(true);
    const ns: Zone = { id: "ED-NS", name: "ED-NS", kind: "waiting", polygon: rect(0, 0, 1, 1) };
    expect(isNurseStation(ns)).toBe(true);
    expect(isWalled(ns)).toBe(false);
    expect(isWalled({ id: "c", name: "c", kind: "corridor", polygon: rect(0, 0, 1, 1) })).toBe(false);
    expect(isWalled({ id: "z", name: "z", polygon: rect(0, 0, 1, 1) })).toBe(false);
  });
});

describe("doorGaps", () => {
  const corridor: Zone = { id: "c", name: "c", kind: "corridor", polygon: rect(0, 5, 20, 4) };

  test("a door point opens a gap of the door width centred on it, on its edge", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 0, 4, 5), doors: [[2, 5]] };
    const [g] = doorGaps(room, [corridor], [10, 10], 1.4);
    expect(g.a[1]).toBeCloseTo(5);
    expect(g.b[1]).toBeCloseTo(5);
    expect(len(g)).toBeCloseTo(1.4);
    expect((g.a[0] + g.b[0]) / 2).toBeCloseTo(2);
  });

  test("a door near a corner is clamped inside the edge", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 0, 4, 5), doors: [[3.9, 5]] };
    const [g] = doorGaps(room, [], [10, 10], 1.4);
    expect(Math.max(g.a[0], g.b[0])).toBeCloseTo(4);
    expect(len(g)).toBeCloseTo(1.4);
  });

  test("without doors the gap goes on the edge nearest a corridor", () => {
    const top: Zone = { id: "t", name: "t", kind: "room", polygon: rect(0, 0, 4, 5) };
    const bottom: Zone = { id: "b", name: "b", kind: "room", polygon: rect(6, 9, 4, 5) };
    expect(doorGaps(top, [corridor], [0, 0], 1.4)[0].a[1]).toBeCloseTo(5); // bottom edge faces the corridor
    expect(doorGaps(bottom, [corridor], [0, 0], 1.4)[0].a[1]).toBeCloseTo(9); // top edge faces it
  });

  test("without doors or corridors the gap faces the floor centre", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 0, 4, 4) };
    const [g] = doorGaps(room, [], [2, 30], 1);
    expect(g.a[1]).toBeCloseTo(4);
  });

  test("a narrow door edge never takes more than 70 % of it", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 0, 1, 5), doors: [[0.5, 5]] };
    expect(len(doorGaps(room, [], [0, 0], 1.4)[0])).toBeCloseTo(0.7);
  });
});

describe("planWalls", () => {
  test("a room gets all four walls minus its door gap", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(2, 2, 4, 5), doors: [[4, 7]] };
    const { inner } = planWalls({ width: 20, depth: 20, zones: [room], entrances: [], doorWidth: 1.4 });
    expect(total(inner)).toBeCloseTo(2 * (4 + 5) - 1.4);
    expect(onY(inner, 7)).toHaveLength(2); // front wall split by the door
  });

  test("an edge shared by two rooms is one wall, not two", () => {
    const a: Zone = { id: "a", name: "a", kind: "room", polygon: rect(2, 2, 4, 5), doors: [[4, 7]] };
    const b: Zone = { id: "b", name: "b", kind: "room", polygon: rect(6, 2, 4, 5), doors: [[8, 7]] };
    const { inner } = planWalls({ width: 20, depth: 20, zones: [a, b], entrances: [], doorWidth: 1.4 });
    // back 8 + front 8 - two doors + three side walls of 5 (the middle one shared)
    expect(total(inner)).toBeCloseTo(8 + 8 - 2.8 + 15);
  });

  test("outer walls run around the floor with an opening at each entrance", () => {
    const { outer } = planWalls({
      width: 30, depth: 20, zones: [], doorWidth: 1.4,
      entrances: [{ id: "m", name: "Main", point: [15, 20], kind: "walk" }, { id: "a", name: "Amb", point: [0, 10], kind: "ambulance" }],
    });
    expect(total(outer)).toBeCloseTo(2 * (30 + 20) - 3 - 4.5);
    expect(onY(outer, 20)).toHaveLength(2);
  });

  test("room walls on the floor's edge are left to the outer wall", () => {
    const room: Zone = { id: "r", name: "r", kind: "room", polygon: rect(0, 0, 4, 5), doors: [[2, 5]] };
    const { inner } = planWalls({ width: 20, depth: 20, zones: [room], entrances: [], doorWidth: 1.4 });
    expect(onY(inner, 0)).toHaveLength(0);
    expect(total(inner)).toBeCloseTo(5 + (4 - 1.4)); // right wall + front wall pieces
  });

  test("bad polygons are ignored", () => {
    const bad = { id: "x", name: "x", kind: "room", polygon: [[0, 0]] } as Zone;
    expect(planWalls({ width: 10, depth: 10, zones: [bad], entrances: [], doorWidth: 1 }).inner).toEqual([]);
  });
});
