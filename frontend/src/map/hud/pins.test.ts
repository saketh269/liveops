import type { Asset, SiteLayout } from "../../api/types";
import { resetOwnStatus } from "../labels";
import { MAX_PINS, problemPins, problemsByFloor } from "./pins";

const NOW = 1_800_000_000;
const ago = (min: number) => new Date((NOW - min * 60) * 1000).toISOString();
const sq = (x: number): [number, number][] => [[x, 0], [x + 5, 0], [x + 5, 5], [x, 5]];
const layout: SiteLayout = { width: 100, depth: 50, zones: [{ id: "wait", name: "ED Waiting Room", kind: "waiting", polygon: sq(0) }, { id: "r1", name: "ED-01", kind: "room", polygon: sq(10) }] };
const rec = (asset_id: string, kind: string, state: string, zone: string, attributes: Record<string, unknown> = {}): Asset =>
  ({ site_id: "hs", asset_id, updated_ts: NOW, kind, state, zone, attributes, _sources: {} });

test("pins stand on alert, boarding and long-cleaning records; worst first; a click target per pin", () => {
  const pins = problemPins(layout, [
    rec("B1", "bed", "cleaning", "ED-01", { status: "dirty", status_since: ago(45) }),
    rec("B2", "bed", "cleaning", "ED-01", { status: "dirty", status_since: ago(5) }), // not yet late
    rec("P1", "patient", "alert", "ED Waiting Room", { status: "waiting_room", waiting_since: ago(20) }),
    rec("P2", "patient", "alert", "ED Waiting Room", { status: "waiting_room", waiting_since: ago(60) }),
    rec("P3", "patient", "in_use", "ED-01", { status: "boarding" }), // boarding-like even when mapped to In use
    rec("P4", "patient", "in_use", "ED-01", { status: "admitted" }),
    rec("N1", "nurse", "free", "ED-01"),
  ], NOW);
  expect(pins.map((p) => [p.key, p.assetId, p.tone, p.count])).toEqual([
    ["zone:wait", "P2", "bad", 2], // two alerts in one room are one pin, standing on the longest-waiting
    ["zone:r1", "P3", "bad", 1],
    ["B1", "B1", "warn", 1],
  ]);
  expect(pins[0].text).toBe("ED Waiting Room · 2 alerts");
  expect(pins[1].text).toBe("P3 · Boarding");
  expect(pins[2].text).toBe("B1 · Dirty 45 min");
});

test("a pin says the record's own status, never an attached source's (a transport request's \"in progress\")", () => {
  resetOwnStatus();
  const own = { state: "pat", zone: "pat", label: "pat", kind: "pat" };
  const patient = (status: string, statusSrc: string): Asset => ({
    site_id: "hs", asset_id: "P7401859", updated_ts: NOW, kind: "patient", state: "alert", zone: "ED Waiting Room",
    attributes: { status, waiting_since: ago(12), to: "Radiology – MRI" },
    _sources: { ...own, "attributes.status": statusSrc, "attributes.waiting_since": "pat", "attributes.to": "transport" },
  });
  // Seen first with its own status, then the transport request's status overwrote the shared key.
  expect(problemPins(layout, [patient("waiting_for_provider", "pat")], NOW)[0].text).toBe("P7401859 · Waiting for provider 12 min");
  expect(problemPins(layout, [patient("in_progress", "transport")], NOW)[0].text).toBe("P7401859 · Waiting for provider 12 min");
  // Never seen with its own status: the mapped state, not the attached value.
  resetOwnStatus();
  expect(problemPins(layout, [patient("in_progress", "transport")], NOW)[0].text).toBe("P7401859 · Alert 12 min");
});

test("at most MAX_PINS pins, alerts before warnings", () => {
  const many = Array.from({ length: MAX_PINS + 5 }, (_, i) => rec(`X${i}`, "bed", i % 2 ? "alert" : "cleaning", `Z${i}`, { status_since: ago(90) }));
  const pins = problemPins(layout, many, NOW);
  expect(pins).toHaveLength(MAX_PINS);
  const firstWarn = pins.findIndex((p) => p.tone === "warn");
  expect(pins.slice(firstWarn).every((p) => p.tone === "warn")).toBe(true);
});

test("no problems, no pins; floors count their problems", () => {
  expect(problemPins(layout, [rec("B1", "bed", "free", "ED-01")], NOW)).toEqual([]);
  const by = problemsByFloor([rec("A", "bed", "alert", "x"), rec("B", "bed", "alert", "y"), rec("C", "bed", "free", "y")], (a) => (a.zone === "x" ? "1" : "2"), NOW);
  expect([...by]).toEqual([["1", 1], ["2", 1]]);
});
