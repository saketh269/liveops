import type { Asset, Zone } from "../../api/types";
import { PALETTES } from "./style";
import { GLOW_MS, glowAt, newlyFree, roomStates, statesChanged, tintFor } from "./tint";

const sq = (x: number, y: number, w = 4, h = 5): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const zones: Zone[] = [
  { id: "ED-01", name: "ED-01", kind: "room", polygon: sq(0, 0) },
  { id: "ED-02", name: "Bay Two", kind: "room", polygon: sq(5, 0) },
  { id: "ED-03", name: "ED-03", kind: "room", polygon: sq(10, 0) },
  { id: "ED-corridor", name: "ED corridor", kind: "corridor", polygon: sq(0, 6, 20, 4) },
];
let n = 0;
const asset = (o: Partial<Asset>): Asset => ({ site_id: "s", asset_id: `a${n++}`, updated_ts: 0, _sources: {}, ...o });

describe("roomStates", () => {
  test("a room takes the state of the bed whose zone is that room", () => {
    const m = roomStates(zones, [asset({ kind: "bed", zone: "ED-01", state: "free" }), asset({ kind: "Bed", zone: "bay two", state: "in_use" })]);
    expect(m.get("ED-01")).toBe("free");
    expect(m.get("ED-02")).toBe("in-use"); // matched by zone name, kind case-insensitive
    expect(m.has("ED-03")).toBe(false); // no bed: neutral tile
  });

  test("only beds count, and only in room zones", () => {
    const m = roomStates(zones, [
      asset({ kind: "patient", zone: "ED-01", state: "alert" }),
      asset({ kind: "bed", zone: "ED-corridor", state: "alert" }),
      asset({ kind: "bed", zone: "nowhere", state: "alert" }),
    ]);
    expect(m.size).toBe(0);
  });

  test("with two beds in one room the most urgent state wins", () => {
    const m = roomStates(zones, [asset({ kind: "bed", zone: "ED-01", state: "free" }), asset({ kind: "bed", zone: "ED-01", state: "dirty" })]);
    expect(m.get("ED-01")).toBe("cleaning");
  });

  test("unrecognised states are unknown, and layouts without rooms give nothing", () => {
    expect(roomStates(zones, [asset({ kind: "bed", zone: "ED-01", state: "weird" })]).get("ED-01")).toBe("unknown");
    expect(roomStates([zones[3]], [asset({ kind: "bed", zone: "ED-corridor", state: "free" })]).size).toBe(0);
  });
});

describe("tintFor", () => {
  test("problems are strong, normal use is muted, no bed is neutral", () => {
    for (const p of Object.values(PALETTES)) {
      expect(tintFor("alert", p).strength).toBeGreaterThan(tintFor("in-use", p).strength);
      expect(tintFor("cleaning", p).strength).toBeGreaterThan(tintFor("in-use", p).strength);
      expect(tintFor("free", p).strength).toBeGreaterThan(tintFor("in-use", p).strength);
      expect(tintFor(undefined, p)).toEqual(p.tint.unknown);
    }
  });
});

describe("changes and glow", () => {
  test("newlyFree lists rooms that changed to free (not ones seen for the first time)", () => {
    const a = new Map([["ED-01", "cleaning"], ["ED-02", "free"]] as const);
    const b = new Map([["ED-01", "free"], ["ED-02", "free"], ["ED-03", "free"]] as const);
    expect(newlyFree(a, b)).toEqual(["ED-01"]);
    expect(statesChanged(a, b)).toBe(true);
    expect(statesChanged(b, new Map(b))).toBe(false);
  });

  test("the glow rises and fades out within GLOW_MS", () => {
    expect(glowAt(0)).toBe(0);
    expect(glowAt(GLOW_MS / 4)).toBeGreaterThan(0.5);
    expect(glowAt(GLOW_MS)).toBe(0);
    expect(glowAt(-1)).toBe(0);
  });
});
