// Anchored placement and motion (LIVEOPS-102): patients in beds, staff at bedsides.
import type { Asset, SiteLayout, Zone } from "../api/types";
import { MAX_TRAVEL_S, Motion } from "./motion";
import { corridorEnds, navFloorOf, nearestExit } from "./navigation";
import { PlacementCache, placeAssets, placementKey, pointInPolygon, type Placement, type Pt } from "./placement";

// Synthetic records for tests only.
const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const room = (id: string, x: number, top: boolean): Zone => ({
  id, name: id, kind: "room", polygon: rect(x, top ? 0 : 16, 4, 7), doors: [[x + 2, top ? 7 : 16]],
});
// Two rooms on top, one below, a corridor between; no entrances (an upper floor).
const layout: SiteLayout = {
  width: 20, depth: 25,
  zones: [
    room("R1", 0, true), room("R2", 6, true), room("R3", 0, false),
    { id: "C", name: "Corridor", kind: "corridor", polygon: rect(0, 7, 20, 9) },
    { id: "U", name: "Unit", kind: "unit", polygon: rect(10, 17, 10, 7) },
    { id: "WARD", name: "Ward", kind: "room", polygon: rect(14, 0, 6, 7), doors: [[17, 7]] },
  ],
};
const zone = (id: string) => layout.zones!.find((z) => z.id === id)!;
const A = (id: string, kind: string, zoneV?: string, extra: Partial<Asset> = {}): Asset =>
  ({ site_id: "s", asset_id: id, updated_ts: 1, zone: zoneV, kind, state: "in_use", _sources: {}, ...extra });
const bed = (id: string, extra: Partial<Asset> = {}) => A(id, "bed", id, extra);
const patient = (id: string, bedId: string | null, extra: Partial<Asset> = {}) => A(id, "patient", bedId ?? "C", { anchor: bedId, ...extra });
const nurse = (id: string, zoneV: string, extra: Partial<Asset> = {}) => A(id, "staff", zoneV, { role: "nurse", ...extra });
const BEDS = [bed("R1"), bed("R2"), bed("R3")];
const place = (list: Asset[]) => placeAssets(layout, list).positions;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const inZone = (p: { x: number; y: number }, id: string) => pointInPolygon(p.x, p.y, zone(id).polygon);

describe("anchored placement", () => {
  test("a bed alone in its room sits in the middle, back from the door, foot towards the door", () => {
    const b = place(BEDS).get("R1")!;
    expect(inZone(b, "R1")).toBe(true);
    expect(b.x).toBeCloseTo(2);
    expect(b.y).toBeLessThan(3.5); // pushed back from the door at y = 7
    expect(b.heading).toBeCloseTo(Math.PI / 2); // towards +y, the door
    expect(place(BEDS).get("R3")!.heading).toBeCloseTo(-Math.PI / 2);
    expect(b.pose).toBe("standing");
  });

  test("a patient anchored to a bed lies in it", () => {
    const pos = place([...BEDS, patient("P1", "R1")]);
    const b = pos.get("R1")!, p = pos.get("P1")!;
    expect(p).toMatchObject({ x: b.x, y: b.y, heading: b.heading, pose: "lying", anchorId: "R1", zoneId: "R1", level: 0, size: b.size });
    expect(p.approach).toBeDefined();
    expect(inZone({ x: p.approach![0], y: p.approach![1] }, "R1")).toBe(true);
    expect(Math.hypot(p.approach![0] - b.x, p.approach![1] - b.y)).toBeGreaterThan(b.size * 0.3); // beside, not on, the bed
  });

  test("the anchor wins over the zone, and a numeric anchor matches by id", () => {
    const pos = place([...BEDS, bed("12", { zone: "R2" }), patient("P1", null, { zone: "R1", anchor: 12 })]);
    // "12" shares R2 with bed R2, so both are packed there; the patient lies on "12" wherever it is.
    expect(pos.get("P1")).toMatchObject({ pose: "lying", anchorId: "12", x: pos.get("12")!.x, y: pos.get("12")!.y });
  });

  test("a patient whose state is not in_use stands at the bedside instead", () => {
    const pos = place([...BEDS, patient("P1", "R1", { state: "free" })]);
    const p = pos.get("P1")!;
    expect(p.pose).toBe("standing");
    expect(p.anchorId).toBe("R1");
    expect(dist(p, pos.get("R1")!)).toBeGreaterThan(0.3);
    // No mapped state at all: in bed.
    expect(place([...BEDS, patient("P2", "R1", { state: undefined })]).get("P2")!.pose).toBe("lying");
  });

  test("several patients on one bed (a data glitch): the first lies in it, the others stand beside", () => {
    const pos = place([...BEDS, patient("P2", "R1"), patient("P1", "R1"), patient("P3", "R1")]);
    expect(pos.get("P1")!.pose).toBe("lying");
    for (const id of ["P2", "P3"]) {
      const p = pos.get(id)!;
      expect(p.pose).toBe("standing");
      expect(inZone(p, "R1")).toBe(true);
      expect(dist(p, pos.get("R1")!)).toBeGreaterThan(0.3);
    }
    expect(dist(pos.get("P2")!, pos.get("P3")!)).toBeGreaterThan(0.3);
  });

  test("staff whose location is a bed stand at the bedside facing it, fanned out inside the room", () => {
    const staff = ["N1", "N2", "N3", "N4"].map((id) => nurse(id, "R1"));
    const pos = place([...BEDS, patient("P1", "R1"), ...staff]);
    const b = pos.get("R1")!;
    const spots: Placement[] = staff.map((s) => pos.get(s.asset_id)!);
    for (const s of spots) {
      expect(s.pose).toBe("standing");
      expect(s.anchorId).toBe("R1");
      expect(inZone(s, "R1")).toBe(true);
      expect(dist(s, b)).toBeGreaterThan(b.size * 0.3);
      // Facing the bed.
      expect(Math.cos(s.heading! - Math.atan2(b.y - s.y, b.x - s.x))).toBeCloseTo(1, 6);
    }
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) expect(dist(spots[i], spots[j])).toBeGreaterThan(0.3);
  });

  test("staff anchored to a bed by the anchor field stand at the bedside too", () => {
    const pos = place([...BEDS, nurse("N1", "C", { anchor: "R3" })]);
    expect(pos.get("N1")).toMatchObject({ pose: "standing", anchorId: "R3", zoneId: "R3" });
  });

  test("an anchor to a missing asset falls back to normal zone placement", () => {
    const pos = place([...BEDS, patient("P1", "GONE", { zone: "R2" }), patient("P2", "GONE", { zone: "nowhere" })]);
    expect(pos.get("P1")).toMatchObject({ zoneId: "R2", pose: "standing", anchorId: null });
    expect(pos.get("P2")).toMatchObject({ unassigned: true, anchorId: null });
  });

  test("a patient in a zone with exactly one bed is in that bed; with two beds, packed as usual", () => {
    const one = place([bed("W1", { zone: "Ward" }), patient("P1", null, { zone: "Ward" })]);
    expect(one.get("P1")).toMatchObject({ pose: "lying", anchorId: "W1" });
    const two = place([bed("W1", { zone: "Ward" }), bed("W2", { zone: "Ward" }), patient("P1", null, { zone: "Ward" })]);
    expect(two.get("P1")).toMatchObject({ pose: "standing", anchorId: null, zoneId: "WARD" });
  });

  test("staff in a unit (not a room) with one bed are not drawn at it", () => {
    const pos = place([bed("U1", { zone: "U" }), nurse("N1", "U"), patient("P1", null, { zone: "U" })]);
    expect(pos.get("N1")!.anchorId).toBeNull();
    expect(pos.get("P1")!.anchorId).toBe("U1"); // the patient rule is any zone with exactly one bed
  });

  test("anchors to anchored assets (chains, cycles) fall back to zones", () => {
    const pos = place([...BEDS, patient("P1", "R1"), nurse("N1", "R2", { anchor: "P1" }), nurse("X", "R3", { anchor: "Y" }), nurse("Y", "R3", { anchor: "X" })]);
    expect(pos.get("P1")!.pose).toBe("lying");
    expect(pos.get("N1")!.anchorId).toBeNull();
    expect(pos.get("X")!.anchorId).toBeNull();
    expect(pos.get("Y")!.anchorId).toBeNull();
  });

  test("anything anchored to a non-bed stands beside it", () => {
    const pos = place([A("PUMP", "equipment", "R2", { x: 8, y: 3 }), nurse("N1", "C", { anchor: "PUMP" })]);
    const n = pos.get("N1")!;
    expect(n).toMatchObject({ pose: "standing", anchorId: "PUMP" });
    expect(dist(n, { x: 8, y: 3 })).toBeGreaterThan(0.4);
  });

  test("deterministic regardless of input order", () => {
    const list = [...BEDS, patient("P1", "R1"), patient("P2", "R1"), nurse("N1", "R1"), nurse("N2", "R1"), nurse("N3", "R3")];
    const a = place(list), b = place([...list].reverse());
    for (const x of list) expect(b.get(x.asset_id)).toEqual(a.get(x.asset_id));
  });

  test("placement key: anchor and a patient getting into or out of bed count; other state changes don't", () => {
    const base = [...BEDS, patient("P1", "R1"), nurse("N1", "R1")];
    const k = placementKey(layout, base);
    expect(placementKey(layout, [...BEDS, patient("P1", "R2"), nurse("N1", "R1")])).not.toBe(k);
    expect(placementKey(layout, [...BEDS, patient("P1", "R1", { state: "free" }), nurse("N1", "R1")])).not.toBe(k);
    expect(placementKey(layout, [...BEDS, patient("P1", "R1"), nurse("N1", "R1", { state: "free" })])).toBe(k);
    const c = new PlacementCache();
    const r = c.get(layout, base);
    expect(c.get(layout, [...BEDS, patient("P1", "R1"), nurse("N1", "R1", { state: "alert" })])).toBe(r);
  });
});

describe("navigation exits", () => {
  test("a floor without entrances leaves by the nearest open corridor end", () => {
    const f = navFloorOf(layout);
    const ends = corridorEnds(f);
    expect(ends).toHaveLength(2);
    expect(nearestExit(f, [2, 3], "walk")[0]).toBeLessThan(1);
    expect(nearestExit(f, [18, 3], "walk")[0]).toBeGreaterThan(19);
  });

  test("corridors that continue into each other have no end at the joint", () => {
    const f = navFloorOf({ width: 40, depth: 10, zones: [
      { id: "a", name: "a", kind: "corridor", polygon: rect(0, 0, 20, 4) },
      { id: "b", name: "b", kind: "corridor", polygon: rect(20, 0, 20, 4) },
    ] });
    const xs = corridorEnds(f).map((p) => Math.round(p[0]));
    expect(xs.sort((a, b) => a - b)).toEqual([0, 40]);
  });

  test("own entrances win over corridor ends", () => {
    const f = navFloorOf({ ...layout, entrances: [{ id: "e", name: "E", point: [10, 25], kind: "walk" }] });
    expect(nearestExit(f, [2, 3], "walk")).toEqual([10, 25]);
  });
});

describe("anchored motion", () => {
  class Clock { t = 0; now = () => this.t; advance(ms: number) { this.t += ms; } }
  function setup() {
    const clock = new Clock();
    const m = new Motion({ now: clock.now });
    m.setLayout(layout);
    const apply = (list: Asset[], instant = false) => {
      const assets = new Map(list.map((a) => [a.asset_id, a]));
      const pl = placeAssets(layout, assets.values());
      m.update(assets, pl, instant);
      return pl.positions;
    };
    /** Advance in small steps, recording every drawn position and pose of `id`. */
    const walk = (id: string, ms = (MAX_TRAVEL_S + 1) * 1000) => {
      const trace: { x: number; y: number; pose: string }[] = [];
      for (let t = 0; t < ms && m.get(id); t += 50) {
        clock.advance(50);
        m.step();
        const f = m.get(id);
        if (f) trace.push({ x: f.x, y: f.y, pose: f.pose });
        if (!m.isMoving(id)) break;
      }
      return trace;
    };
    return { m, apply, walk };
  }
  const wallsOk = (p: { x: number; y: number }, allowed: string[]) =>
    allowed.some((z) => pointInPolygon(p.x, p.y, zone(z).polygon)) || [7, 16].some((y) => Math.abs(p.y - y) < 0.6);

  test("the first snapshot puts patients in bed and staff at bedsides without walking", () => {
    const { m, apply } = setup();
    const pos = apply([...BEDS, patient("P1", "R1"), nurse("N1", "R1")], true);
    expect(m.walkerCount).toBe(0);
    expect(m.get("P1")).toMatchObject({ pose: "lying", x: pos.get("R1")!.x, heading: pos.get("R1")!.heading });
    expect(m.get("N1")!.heading).toBeCloseTo(pos.get("N1")!.heading!);
  });

  test("a bed change: the patient gets up, walks via doors and the corridor, and lies down in the new bed", () => {
    const { m, apply, walk } = setup();
    apply([...BEDS, patient("P1", "R1")], true);
    const to = apply([...BEDS, patient("P1", "R3", { zone: "R3" })]);
    expect(m.isMoving("P1")).toBe(true);
    expect(m.get("P1")!.pose).toBe("standing"); // got up
    const trace = walk("P1");
    expect(trace.length).toBeGreaterThan(5);
    // Through R1's door, the corridor and R3's door; never through R2 or a wall.
    const bad = trace.slice(0, -1).filter((p) => !wallsOk(p, ["R1", "C", "R3"]));
    expect(bad).toEqual([]);
    expect(trace.some((p) => p.y > 7.5 && p.y < 15.5)).toBe(true);
    expect(trace.slice(0, -1).every((p) => p.pose === "standing")).toBe(true);
    // Arrives from the bedside, then lies down in the bed facing its door.
    const bedP = to.get("R3")!;
    const f = m.get("P1")!;
    expect(m.isMoving("P1")).toBe(false);
    expect(f).toMatchObject({ pose: "lying", x: bedP.x, y: bedP.y, heading: bedP.heading });
    const approach = to.get("P1")!.approach!;
    expect(trace.some((p) => Math.hypot(p.x - approach[0], p.y - approach[1]) < 0.2)).toBe(true);
  });

  test("follow: the motion engine reports a moving anchored figure where it is drawn each frame", () => {
    const { apply, walk } = setup();
    apply([...BEDS, patient("P1", "R1")], true);
    apply([...BEDS, patient("P1", "R2", { zone: "R2" })]);
    const trace = walk("P1", 3000);
    const xs = new Set(trace.map((p) => p.x.toFixed(3)));
    expect(xs.size).toBeGreaterThan(3); // the followed position changes as it walks
  });

  test("staff walk bedside to bedside", () => {
    const { m, apply, walk } = setup();
    apply([...BEDS, nurse("N1", "R1")], true);
    const to = apply([...BEDS, nurse("N1", "R3")]);
    expect(m.isMoving("N1")).toBe(true);
    walk("N1");
    const f = m.get("N1")!, p = to.get("N1")!;
    expect(f).toMatchObject({ x: p.x, y: p.y, pose: "standing" });
    expect(f.heading).toBeCloseTo(p.heading!); // facing the new bed
  });

  test("discharge: a removed patient gets up and walks out to the nearest exit, then is gone", () => {
    const { m, apply, walk } = setup();
    const pos = apply([...BEDS, patient("P1", "R1")], true);
    apply(BEDS);
    expect(m.get("P1")).toMatchObject({ leaving: true, pose: "standing" });
    const trace = walk("P1");
    for (const p of trace) expect(wallsOk(p, ["R1", "C"])).toBe(true);
    const approach = pos.get("P1")!.approach!;
    expect(Math.hypot(trace[0].x - approach[0], trace[0].y - approach[1])).toBeLessThan(2); // first steps: out of bed to the bedside
    expect(trace[trace.length - 1].x).toBeLessThan(1); // the corridor's west end, nearest to R1
    expect(m.get("P1")).toBeUndefined();
  });

  test("getting out of bed in place (state no longer in_use) is a short walk to the bedside", () => {
    const { m, apply, walk } = setup();
    apply([...BEDS, patient("P1", "R1")], true);
    const to = apply([...BEDS, patient("P1", "R1", { state: "free" })]);
    expect(m.isMoving("P1")).toBe(true);
    walk("P1");
    expect(m.get("P1")).toMatchObject({ pose: "standing", x: to.get("P1")!.x, y: to.get("P1")!.y });
  });

  test("with motion off, a bed change jumps straight into the new bed", () => {
    const { m, apply } = setup();
    m.setEnabled(false);
    apply([...BEDS, patient("P1", "R1")], true);
    const to = apply([...BEDS, patient("P1", "R2", { zone: "R2" })]);
    expect(m.walkerCount).toBe(0);
    expect(m.get("P1")).toMatchObject({ pose: "lying", x: to.get("R2")!.x, y: to.get("R2")!.y });
  });
});
