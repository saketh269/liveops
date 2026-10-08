import type { Asset } from "../../api/types";
import type { FeedEntry } from "../reducer";
import { floorShort } from "./FloorRail";
import { headline, isBoarding, shortLabels } from "./model";
import { ageOf, fmtDur, parseTs } from "./time";

const entry = (text: string, kind: FeedEntry["kind"] = "change"): FeedEntry => ({ id: 1, ts: 1, kind, text, assetId: "P1" }) as FeedEntry;

test("small cards say what happened in words and drop location pings", () => {
  expect(headline(entry("P1: status waiting_room → in_treatment, latitude 1 → 2"))).toEqual({ name: "P1", what: "is in treatment" });
  expect(headline(entry("Medic 1: latitude 1 → 2, longitude 3 → 4"))).toBeNull();
  expect(headline(entry("P1: anchor — → —, status — → waiting_room"))).toEqual({ name: "P1", what: "is now waiting room" });
  expect(headline(entry("P1 added", "added"))).toEqual({ name: "P1", what: "was added to the map" });
});

test("server entries with changes become one sentence; the record's label and role name it", () => {
  const nurse = { site_id: "s", asset_id: "S1", updated_ts: 0, label: "Daniel Wagner", kind: "staff", role: "Registered Nurse", zone: "3W-305A", _sources: { zone: "staff", label: "staff" } } as Asset;
  const e = { ...entry("S1 zone 3W-NS → 3W-305A", "event"), assetId: "S1", source: "staff", changes: { zone: ["3W-NS", "3W-305A"], "attributes.badge_last_seen": ["a", "b"] } } as FeedEntry;
  expect(headline(e, { assets: new Map([["S1", nurse]]) })).toEqual({ name: "Nurse Daniel Wagner", what: "went to 3W-305A" });
  const ping = { ...e, changes: { "attributes.badge_last_seen": ["a", "b"] } } as FeedEntry;
  expect(headline(ping, { assets: new Map([["S1", nurse]]) })).toBeNull();
  const gone = { ...entry("P9 left the map", "event"), assetId: "P9", removed: true, changes: { label: ["P7401859", null], "attributes.status": ["pending_discharge", null] } } as FeedEntry;
  expect(headline(gone)).toEqual({ name: "P7401859", what: "left the map (discharged)" });
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
