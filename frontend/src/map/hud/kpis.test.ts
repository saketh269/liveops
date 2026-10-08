import type { Asset, SiteLayout } from "../../api/types";
import { kpiDefinitions } from "./kpis";

const NOW = 1_800_000_000;
const ago = (min: number) => new Date((NOW - min * 60) * 1000).toISOString();
const sq = (x: number): [number, number][] => [[x, 0], [x + 5, 0], [x + 5, 5], [x, 5]];
const layout: SiteLayout = {
  width: 100, depth: 50,
  zones: [
    { id: "ED-01", name: "ED-01", kind: "room", polygon: sq(0) },
    { id: "ED-02", name: "ED-02", kind: "room", polygon: sq(5) },
    { id: "ED-03", name: "ED-03", kind: "room", polygon: sq(10) },
    { id: "wait", name: "ED Waiting Room", kind: "waiting", polygon: sq(20) },
  ],
};
let n = 0;
const rec = (kind: string, state: string, zone: string, attributes: Record<string, unknown> = {}): Asset =>
  ({ site_id: "hs", asset_id: `${kind}-${++n}`, updated_ts: NOW, kind, state, zone, attributes, _sources: {} });
const map = (...list: Asset[]) => new Map(list.map((a) => [a.asset_id, a]));
const byId = (tiles: ReturnType<typeof kpiDefinitions>) => Object.fromEntries(tiles.map((t) => [t.id, t]));

test("hospital data gets waiting, boarding, alerts, dirty beds, ambulances and beds-used tiles from live records only", () => {
  const dirtyOld = rec("bed", "cleaning", "ED-02", { status: "dirty", status_since: ago(50) });
  const boardOld = rec("patient", "alert", "ED-01", { status: "boarding" });
  const tiles = kpiDefinitions({ layout }, map(
    rec("bed", "in_use", "ED-01"), dirtyOld, rec("bed", "cleaning", "ED-03", { status_since: ago(10) }),
    rec("patient", "alert", "ED Waiting Room", { status: "waiting_room" }),
    rec("patient", "alert", "ED Waiting Room", { status: "waiting_for_provider", waiting_since: ago(95) }),
    boardOld,
    rec("ambulance", "in_use", "transporting", { eta_minutes: 12 }),
    rec("ambulance", "in_use", "transporting", { eta_minutes: "7" }),
    rec("ambulance", "free", "available"),
    rec("staff", "alert", "ED-01"),
  ), NOW);
  expect(tiles.map((t) => t.id)).toEqual(["waiting", "boarding", "alerts", "cleaning", "ambulances", "beds"]);
  const t = byId(tiles);
  expect(t.waiting).toMatchObject({ value: 2, sub: "longest 1h 35m", focus: { zoneId: "wait" } });
  expect(t.boarding).toMatchObject({ value: 1, tone: "warn", focus: { assetId: boardOld.asset_id } });
  // Waiting and boarding patients are not counted twice: only the staff alert is left.
  expect(t.alerts).toMatchObject({ value: 1, tone: "alert" });
  // The oldest dirty bed is the worst one; over 30 minutes turns the tile amber.
  expect(t.cleaning).toMatchObject({ label: "Dirty beds", value: 2, sub: "oldest 50m", tone: "warn", focus: { assetId: dirtyOld.asset_id } });
  expect(t.ambulances).toMatchObject({ label: "Ambulances inbound", value: 2, sub: "next ETA 7 min" });
  expect(t.beds).toMatchObject({ value: 1, total: 3, sub: "33% full · 0 free", tone: "alert", focus: null });
});

test("no ETA in the data: ambulances show how many are out; nothing to clean reads calm", () => {
  const t = byId(kpiDefinitions({ layout }, map(rec("bed", "free", "ED-01"), rec("ambulance", "in_use", "on_scene"), rec("ambulance", "free", "available")), NOW));
  expect(t.ambulances).toMatchObject({ label: "Ambulances out", value: 1, sub: "of 2 in the fleet" });
  expect(t.cleaning).toMatchObject({ value: 0, sub: "all clean", tone: "", focus: null });
  expect(t.beds).toMatchObject({ value: 0, total: 1, tone: "" });
  expect(t.waiting).toBeUndefined(); // no patients
});

test("ages appear only when records say since when", () => {
  const t = byId(kpiDefinitions({ layout }, map(rec("bed", "cleaning", "ED-01"), rec("bed", "cleaning", "ED-02")), NOW));
  expect(t.cleaning.sub).toBe("2 beds waiting");
  expect(t.cleaning.tone).toBe("");
});

test("non-hospital data gets one tile per state", () => {
  const tiles = kpiDefinitions({ layout: {} }, map(rec("forklift", "in_use", "A"), rec("forklift", "alert", "A"), rec("forklift", "free", "B")), NOW);
  expect(tiles.map((t) => [t.label, t.value])).toEqual([["In use", 1], ["Free", 1], ["Cleaning / maintenance", 0], ["Alert", 1]]);
  expect(byId(tiles)["state-alert"].tone).toBe("alert");
  expect(byId(tiles)["state-alert"].focus).toEqual({ assetId: expect.stringMatching(/^forklift-/) });
});

test("an empty site gives calm zero tiles", () => {
  const tiles = kpiDefinitions({ layout }, new Map(), NOW);
  expect(tiles.every((t) => t.value === 0 && t.tone === "")).toBe(true);
});
