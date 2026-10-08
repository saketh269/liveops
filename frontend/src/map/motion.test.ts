import type { Asset, SiteLayout } from "../api/types";
import { APPROACH_DISTANCE, DRIVE_SPEED, MAX_TRAVEL_S, Motion, WALK_SPEED, motionKey } from "./motion";
import { placeAssets } from "./placement";

// Synthetic records for tests only.
const layout: SiteLayout = {
  width: 40, depth: 20,
  zones: [
    { id: "A", name: "A", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { id: "B", name: "B", polygon: [[30, 0], [40, 0], [40, 10], [30, 10]] },
  ],
  entrances: [
    { id: "w", name: "Main", point: [20, 20], kind: "walk" },
    { id: "amb", name: "Ambulance", point: [40, 20], kind: "ambulance" },
  ],
};
const rec = (id: string, zone: string, extra: Partial<Asset> = {}): Asset =>
  ({ site_id: "s", asset_id: id, updated_ts: 1, zone, state: "free", kind: "nurse", _sources: {}, ...extra });

class Clock { t = 0; now = () => this.t; advance(ms: number) { this.t += ms; } }

function setup(opts: { maxWalkers?: number; budgetMs?: number } = {}) {
  const clock = new Clock();
  const m = new Motion({ now: clock.now, ...opts });
  m.setLayout(layout);
  let assets = new Map<string, Asset>();
  const apply = (list: Asset[], instant = false) => {
    assets = new Map(list.map((a) => [a.asset_id, a]));
    const pl = placeAssets(layout, assets.values());
    m.update(assets, pl, instant);
    return pl;
  };
  return { clock, m, apply };
}
const pos = (m: Motion, id: string) => { const f = m.get(id)!; return [f.x, f.y]; };

test("the first snapshot places everyone instantly", () => {
  const { m, apply } = setup();
  const pl = apply([rec("n1", "A"), rec("n2", "B")], true);
  expect(m.walkerCount).toBe(0);
  expect(pos(m, "n1")).toEqual([pl.positions.get("n1")!.x, pl.positions.get("n1")!.y]);
});

test("a state change never moves a figure; a zone change walks there, time-based", () => {
  const { m, apply, clock } = setup();
  const start = apply([rec("n1", "A")], true).positions.get("n1")!;
  apply([rec("n1", "A", { state: "busy" })]);
  expect(m.walkerCount).toBe(0);

  const end = apply([rec("n1", "B")]).positions.get("n1")!;
  expect(m.isMoving("n1")).toBe(true);
  m.step(); // path planned at t=0
  expect(pos(m, "n1")).toEqual([start.x, start.y]);
  clock.advance(1000);
  m.step();
  const [x1, y1] = pos(m, "n1");
  expect(Math.hypot(x1 - start.x, y1 - start.y)).toBeGreaterThan(WALK_SPEED); // 30 units: sped up to fit MAX_TRAVEL_S

  // Frame rate does not matter: one big step lands where many small ones would.
  const twin = setup();
  twin.apply([rec("n1", "A")], true);
  twin.apply([rec("n1", "B")]);
  twin.m.step();
  for (let i = 0; i < 60; i++) { twin.clock.advance(1000 / 60); twin.m.step(); }
  expect(pos(twin.m, "n1")[0]).toBeCloseTo(x1, 6);
  expect(pos(twin.m, "n1")[1]).toBeCloseTo(y1, 6);

  clock.advance(MAX_TRAVEL_S * 1000);
  const r = m.step();
  expect(r.moved).toContain("n1");
  expect(m.isMoving("n1")).toBe(false);
  expect(pos(m, "n1")).toEqual([end.x, end.y]);
});

test("short trips walk at WALK_SPEED", () => {
  const { m, apply, clock } = setup();
  apply([rec("t1", "", { x: 15, y: 15 })], true);
  apply([rec("t1", "", { x: 20, y: 15 })]);
  m.step();
  clock.advance(1000);
  m.step();
  expect(pos(m, "t1")[0]).toBeCloseTo(15 + WALK_SPEED, 5);
  expect(m.get("t1")!.heading).toBeCloseTo(0, 5);
});

test("long trips are sped up to at most MAX_TRAVEL_S", () => {
  const { m, apply, clock } = setup();
  apply([rec("n1", "A")], true);
  apply([rec("n1", "B")]);
  m.step();
  clock.advance(MAX_TRAVEL_S * 1000 + 1);
  m.step();
  expect(m.isMoving("n1")).toBe(false);
});

test("figures that only shift because their zone was re-packed jump, they do not walk", () => {
  const { m, apply } = setup();
  apply([rec("n1", "A"), rec("n2", "B")], true);
  const pl = apply([rec("n1", "A"), rec("n2", "B"), rec("n3", "A")]);
  expect(m.isMoving("n1")).toBe(false);
  expect(pos(m, "n1")).toEqual([pl.positions.get("n1")!.x, pl.positions.get("n1")!.y]);
  expect(m.isMoving("n3")).toBe(true);
});

test("a new record walks in from the nearest walk entrance", () => {
  const { m, apply, clock } = setup();
  apply([rec("n1", "A")], true);
  const target = apply([rec("n1", "A"), rec("n2", "B")]).positions.get("n2")!;
  // Just inside the entrance on the building wall (not out in the street).
  const [sx, sy] = pos(m, "n2");
  expect(Math.hypot(sx - 20, sy - 20)).toBeLessThan(0.8);
  expect(sy).toBeLessThan(20);
  m.step();
  clock.advance(500);
  m.step();
  expect(pos(m, "n2")).not.toEqual([sx, sy]);
  clock.advance(MAX_TRAVEL_S * 1000);
  m.step();
  expect(pos(m, "n2")).toEqual([target.x, target.y]);
});

test("an ambulance drives in on an approach road to the ambulance entrance, faster than walking", () => {
  const { m, apply, clock } = setup();
  apply([], true);
  apply([rec("amb1", "B", { kind: "ambulance" })]);
  const [sx, sy] = pos(m, "amb1");
  expect(sy).toBeGreaterThan(20); // outside the floor
  expect(Math.hypot(sx - 40, sy - 20)).toBeCloseTo(APPROACH_DISTANCE, 5);
  m.step();
  clock.advance(1000);
  m.step();
  const [x, y] = pos(m, "amb1");
  expect(Math.hypot(x - sx, y - sy)).toBeCloseTo(DRIVE_SPEED, 1);
});

test("a removed record walks to the exit, keeps its final data, then disappears", () => {
  const { m, apply, clock } = setup();
  apply([rec("n1", "A", { label: "Nurse Kim" }), rec("n2", "B")], true);
  const v0 = m.departingVersion;
  apply([rec("n2", "B")]);
  expect(m.departingVersion).toBeGreaterThan(v0);
  expect(m.departing().get("n1")?.label).toBe("Nurse Kim");
  expect(m.get("n1")?.leaving).toBe(true);
  m.step();
  clock.advance(MAX_TRAVEL_S * 1000 + 10);
  const r = m.step();
  expect(r.finished).toBe(true);
  expect(m.get("n1")).toBeUndefined();
  expect(m.departing().size).toBe(0);
});

test("a record removed and re-added mid-walk turns around from where it is", () => {
  const { m, apply, clock } = setup();
  apply([rec("n1", "A")], true);
  apply([]);
  m.step();
  clock.advance(2000);
  m.step();
  const here = pos(m, "n1");
  apply([rec("n1", "A")]);
  expect(m.get("n1")?.leaving).toBe(false);
  m.step();
  expect(pos(m, "n1")).toEqual(here);
});

test("a new change mid-walk re-paths from the current position", () => {
  const { m, apply, clock } = setup();
  apply([rec("n1", "A")], true);
  apply([rec("n1", "B")]);
  m.step();
  clock.advance(3000);
  m.step();
  const here = pos(m, "n1");
  const back = apply([rec("n1", "A")]).positions.get("n1")!;
  m.step();
  expect(pos(m, "n1")).toEqual(here); // no jump
  clock.advance(1000);
  m.step();
  const [x, y] = pos(m, "n1");
  expect(Math.hypot(x - back.x, y - back.y)).toBeLessThan(Math.hypot(here[0] - back.x, here[1] - back.y));
});

test("explicit x/y changes are real moves", () => {
  const { m, apply } = setup();
  apply([rec("t1", "A", { x: 5, y: 5 })], true);
  apply([rec("t1", "A", { x: 6, y: 5 })]);
  expect(m.isMoving("t1")).toBe(true);
  expect(motionKey(rec("t1", "A", { x: 6, y: 5 }))).not.toBe(motionKey(rec("t1", "A", { x: 5, y: 5 })));
  expect(motionKey(rec("t1", "A", { state: "x" }))).toBe(motionKey(rec("t1", "A")));
});

test("reduced motion / motion off: changes jump, and turning it off lands walkers", () => {
  const { m, apply } = setup();
  apply([rec("n1", "A"), rec("n2", "A")], true);
  apply([rec("n1", "B"), rec("n2", "A")]);
  expect(m.walkerCount).toBe(1);
  m.setEnabled(false);
  expect(m.walkerCount).toBe(0);
  const pl = apply([rec("n1", "A"), rec("n3", "B")]);
  expect(m.walkerCount).toBe(0);
  expect(pos(m, "n1")).toEqual([pl.positions.get("n1")!.x, pl.positions.get("n1")!.y]);
  expect(m.get("n2")).toBeUndefined(); // removed at once
  expect(pos(m, "n3")).toEqual([pl.positions.get("n3")!.x, pl.positions.get("n3")!.y]);
});

test("beyond the walker cap, changes jump", () => {
  const { m, apply } = setup({ maxWalkers: 2 });
  apply([rec("a", "A"), rec("b", "A"), rec("c", "A")], true);
  apply([rec("a", "B"), rec("b", "B"), rec("c", "B")]);
  expect(m.walkerCount).toBe(2);
  expect(m.isMoving("c")).toBe(false);
});

test("path finding is spread across frames by a time budget", () => {
  let t = 0;
  const m = new Motion({ now: () => (t += 1), budgetMs: 0 });
  m.setLayout(layout);
  const before = [rec("a", "A"), rec("b", "A"), rec("c", "A")];
  const m0 = new Map(before.map((a) => [a.asset_id, a]));
  m.update(m0, placeAssets(layout, m0.values()), true);
  const after = before.map((a) => ({ ...a, zone: "B" }));
  const m1 = new Map(after.map((a) => [a.asset_id, a]));
  m.update(m1, placeAssets(layout, m1.values()));
  expect(m.step().moved.length).toBe(1);
  expect(m.step().moved.length).toBe(2);
});

test("a new layout resets motion: the next update is instant", () => {
  const { m, apply } = setup();
  apply([rec("n1", "A")], true);
  m.setLayout({ ...layout });
  apply([rec("n1", "B"), rec("n2", "A")]);
  expect(m.walkerCount).toBe(0);
});
