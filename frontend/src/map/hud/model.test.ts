import type { Asset } from "../../api/types";
import type { FeedEntry } from "../reducer";
import { floorShort } from "./FloorRail";
import { headline, isBoarding, shortLabels } from "./model";
import { ageOf, fmtDur, parseTs } from "./time";

const entry = (text: string, kind: FeedEntry["kind"] = "change"): FeedEntry => ({ id: 1, ts: 1, kind, text, assetId: "P1" }) as FeedEntry;

test("small cards keep state, zone and status changes and drop location pings", () => {
  expect(headline(entry("P1: status waiting_room → in_treatment, latitude 1 → 2"))).toEqual({ name: "P1", what: "status waiting_room → in_treatment" });
  expect(headline(entry("Medic 1: latitude 1 → 2, longitude 3 → 4"))).toBeNull();
  expect(headline(entry("P1: anchor — → —, status — → waiting_room"))).toEqual({ name: "P1", what: "status — → waiting_room" });
  expect(headline(entry("P1 added", "added"))).toEqual({ name: null, what: "P1 added" });
});

test("bed chips drop the shared prefix only when names stay unique", () => {
  expect(shortLabels(["ED-01", "ED-02", "ED-10"])).toEqual(["01", "02", "10"]);
  expect(shortLabels(["ED-01", "3W-01"])).toEqual(["ED-01", "3W-01"]);
  expect(shortLabels(["ED-1"])).toEqual(["ED-1"]);
});

test("boarding comes from the source's own status, whatever state it maps to", () => {
  const p = (status: string, state = "in_use") => ({ site_id: "s", asset_id: "p", updated_ts: 0, state, attributes: { status }, _sources: {} }) as Asset;
  expect(isBoarding(p("boarding"))).toBe(true);
  expect(isBoarding(p("ED_BOARDER"))).toBe(true);
  expect(isBoarding(p("onboarding_call"))).toBe(false);
  expect(isBoarding(p("admitted"))).toBe(false);
});

test("ages need a real since-timestamp; durations read short", () => {
  expect(parseTs("2026-10-07T10:00:00Z")).toBe(Date.parse("2026-10-07T10:00:00Z") / 1000);
  expect(parseTs(1_800_000_000_000)).toBe(1_800_000_000);
  expect(parseTs("soon")).toBeNull();
  const a = { site_id: "s", asset_id: "b", updated_ts: 0, attributes: { status_since: 1000 }, _sources: {} } as Asset;
  expect(ageOf(a, 4000)).toBe(3000);
  expect(ageOf({ ...a, attributes: {} }, 4000)).toBeNull();
  expect([42, 2520, 11100, 200000].map(fmtDur)).toEqual(["<1m", "42m", "3h 05m", "2d 7h"]);
});

test("floor rail labels read like a lift panel", () => {
  expect(["Floor 2", "Basement B1", "Ground", "Mezzanine"].map((name) => floorShort({ id: name, name }))).toEqual(["2", "B1", "G", "Mez"]);
});
