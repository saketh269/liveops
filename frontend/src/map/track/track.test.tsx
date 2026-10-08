import { fireEvent, render, screen } from "@testing-library/react";
import type { Asset, AssetHistory, HistoryEntry, SiteLayout, Zone } from "../../api/types";
import HistoryPanel, { matchesFilter, sinceText } from "./HistoryPanel";
import { bedJourney, patientJourney, patientStage, staffJourney, startOfDay } from "./journey";
import JourneyView from "./JourneyView";
import { buildRoute, walkPath } from "./route";
import { GONE_AFTER_S, pushTrail, startTracking, trackStep } from "./tracking";

const T0 = 1_791_400_000; // a fixed day
const at = (min: number) => T0 + min * 60;

function entry(min: number, kind: HistoryEntry["kind"], over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: at(min), kind, text: `${kind} at ${min}`, source: "Patients", status: null, status_raw: null, changes: {},
    zone_id: null, zone: null, bed: null, floor_id: "1", floor: "Floor 1", ...over,
  };
}
function history(entries: HistoryEntry[], over: Partial<AssetHistory> = {}): AssetHistory {
  return {
    site_id: "hs", asset_id: "P1", present: true, current: null, history_since: at(-1), retention_days: 30, truncated: false,
    entries, milestones: [], now: at(600), ...over,
  };
}
const st = (raw: string) => ({ status_raw: raw, status: raw.replace(/_/g, " ") });
const asset = (kind: string, id = "P1"): Asset => ({ site_id: "hs", asset_id: id, updated_ts: 0, kind, _sources: {} });

describe("patient journey", () => {
  test("follows the care steps and highlights a long boarding", () => {
    const h = history(
      [
        entry(0, "arrived", { ...st("waiting_room"), zone: "ED Waiting Room", zone_id: "ED-WR" }),
        entry(40, "move", { ...st("in_treatment"), zone: "ED-02", zone_id: "ED-02", bed: "ED-02" }),
        entry(90, "status", { ...st("boarding"), zone: "ED-02", bed: "ED-02" }),
      ],
      { milestones: [{ key: "admit_time", label: "Admitted", ts: at(-12), value: "", status: null, seen_ts: at(0) }] },
    );
    const j = patientJourney(h, at(90 + 312)); // boarding 5h 12m
    expect(j.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "stuck", "todo", "todo"]);
    expect(j.steps[0].at).toBe(at(-12)); // the source's own arrival time
    expect(j.steps[1].atLeast).toBe(true); // already waiting when Live Ops started watching
    expect(j.steps[2].at).toBe(at(40));
    expect(j.stuck?.key).toBe("boarding");
    expect(j.stuck?.elapsed).toBe(312 * 60);
  });

  test("an inpatient bed after boarding, then discharge and leaving the map", () => {
    const h = history([
      entry(0, "arrived", { ...st("in_treatment"), zone: "ED-02", bed: "ED-02" }),
      entry(30, "status", { ...st("boarding"), bed: "ED-02" }),
      entry(200, "move", { ...st("admitted"), zone: "3W-305A", bed: "3W-305A", floor_id: "3" }),
      entry(900, "status", { ...st("discharge_ordered"), bed: "3W-305A" }),
      entry(960, "left"),
    ], { present: false });
    const j = patientJourney(h, at(1000));
    expect(j.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "done"]);
    expect(j.steps[1].at).toBeNull(); // waiting happened before Live Ops watched
    expect(j.steps[5].at).toBe(at(200));
    expect(j.left).toBe(true);
  });

  test("an ED patient discharged home skips admission", () => {
    const h = history([
      entry(0, "arrived", { ...st("waiting_room") }),
      entry(20, "move", { ...st("in_treatment"), bed: "ED-04" }),
      entry(80, "status", { ...st("ready_for_discharge"), bed: "ED-04" }),
    ]);
    const j = patientJourney(h, at(85));
    expect(j.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "skipped", "skipped", "now"]);
    expect(patientStage("Waiting for provider")).toBe("waiting");
    expect(patientStage("unknown_thing")).toBeNull();
  });

  test("renders steps with times and the stuck step for screen readers", () => {
    const h = history([entry(0, "arrived", { ...st("boarding"), bed: "ED-02" })]);
    render(<JourneyView asset={asset("patient")} history={h} now={at(200)} />);
    expect(screen.getByText("Admit decision / boarding")).toBeTruthy();
    expect(screen.getByText("boarding 3h 20m")).toBeTruthy();
    expect(screen.getByText(/stuck for 3 hours 20 minutes/)).toBeTruthy();
  });
});

describe("staff and bed journeys", () => {
  test("staff: today's rooms in order, the current one open", () => {
    const day = startOfDay(at(600));
    const h = history([
      { ...entry(0, "arrived", { zone: "3W-NS" }), ts: day - 7200 }, // yesterday, ended yesterday
      { ...entry(0, "move", { zone: "3W-301A" }), ts: day - 600 }, // still there after midnight
      { ...entry(0, "move", { zone: "3W-NS" }), ts: day + 3600 },
      { ...entry(0, "move", { zone: "3W-305A" }), ts: day + 5400 },
    ]);
    const j = staffJourney(h, day + 6000);
    expect(j.visits.map((v) => [v.place, v.ongoing])).toEqual([["3W-301A", false], ["3W-NS", false], ["3W-305A", true]]);
    expect(j.visits[1].to).toBe(day + 5400);
  });

  test("bed: states and the dirty-to-clean time", () => {
    const h = history([
      entry(0, "arrived", st("occupied")),
      entry(100, "status", st("dirty")),
      entry(101, "task", { text: "Cleaning task opened" }),
      entry(120, "status", st("cleaning")),
      entry(146, "status", st("available")),
      entry(300, "status", st("occupied")),
    ]);
    const j = bedJourney(h, at(400));
    expect(j.spans.map((s) => s.raw)).toEqual(["occupied", "dirty", "cleaning", "available", "occupied"]);
    expect(j.turnaround).toEqual({ dirtyAt: at(100), cleanAt: at(146), seconds: 46 * 60 });
    const dirtyNow = bedJourney(history([entry(0, "arrived", st("occupied")), entry(10, "status", st("dirty"))]), at(40));
    expect(dirtyNow.turnaround).toEqual({ dirtyAt: at(10), cleanAt: null, seconds: 30 * 60 });
  });
});

describe("tracking", () => {
  const floorOf = (a: Asset) => String(a.floor);
  const name = (id: string) => `Floor ${id}`;

  test("switches floor when the record's floor changes, with a notice", () => {
    let s = startTracking("P7401887", "1");
    const same = trackStep(s, { ...asset("patient", "P7401887"), floor: "1" }, T0, floorOf, name, "P7401887");
    expect(same.switchTo).toBeUndefined();
    expect(same.next).toBe(s); // nothing changed
    const moved = trackStep(s, { ...asset("patient", "P7401887"), floor: "3" }, T0, floorOf, name, "P7401887");
    expect(moved.switchTo).toBe("3");
    expect(moved.notice).toBe("P7401887 moved to Floor 3, following");
    s = moved.next;
    expect(s.floorId).toBe("3");
  });

  test("survives a short gap, then says when the record left the site", () => {
    const s = startTracking("P1", "1");
    const gap = trackStep(s, undefined, T0, floorOf, name, "P1");
    expect(gap.notice).toBeUndefined();
    expect(gap.next.missingSince).toBe(T0);
    const back = trackStep(gap.next, { ...asset("patient"), floor: "1" }, T0 + 5, floorOf, name, "P1");
    expect(back.notice).toBeUndefined();
    expect(back.next.missingSince).toBeNull();
    const still = trackStep(gap.next, undefined, T0 + GONE_AFTER_S - 1, floorOf, name, "P1");
    expect(still.next.gone).toBe(false);
    const gone = trackStep(still.next, undefined, T0 + GONE_AFTER_S, floorOf, name, "P1");
    expect(gone.next.gone).toBe(true);
    expect(gone.notice).toMatch(/no longer reported.*history stays open/);
    const again = trackStep(gone.next, { ...asset("patient"), floor: "2" }, T0 + 99, floorOf, name, "P1");
    expect(again.switchTo).toBe("2");
  });

  test("the trail keeps the last minutes and merges tiny steps", () => {
    let t = pushTrail([], { x: 0, y: 0, t: 0 });
    t = pushTrail(t, { x: 0.1, y: 0, t: 1 });
    expect(t).toHaveLength(1);
    t = pushTrail(t, { x: 2, y: 0, t: 2 });
    t = pushTrail(t, { x: 4, y: 0, t: 400 });
    expect(t.map((p) => p.x)).toEqual([4]);
  });
});

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Zone> = {}): Zone =>
  ({ id, name: id, floor_id: "1", polygon: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], ...extra });
const LAYOUT: SiteLayout = {
  floors: [{ id: "1", name: "Floor 1", level: 0, width: 40, depth: 20 }, { id: "3", name: "Floor 3", level: 2, width: 40, depth: 20 }],
  zones: [
    rect("A", 0, 0, 10, 6, { kind: "room", doors: [[5, 6]] }),
    rect("B", 30, 0, 10, 6, { kind: "room", doors: [[35, 6]] }),
    rect("corr", 0, 6, 40, 4, { kind: "corridor" }),
    rect("C", 0, 0, 10, 6, { kind: "room", floor_id: "3" }),
  ],
};

describe("route", () => {
  test("goes through doors and the corridor, not through walls", () => {
    // Freeze the clock so a busy test runner can't hit the search time cap (that would give a straight line).
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const pts = walkPath(LAYOUT, "1", [5, 3], [35, 3]);
    clock.mockRestore();
    expect(pts.length).toBeGreaterThan(2);
    // Between the two rooms the path runs in the corridor (y 6..10), never along the room row.
    for (const [x, y] of pts) if (x > 11 && x < 29) expect(y).toBeGreaterThanOrEqual(6);
  });

  test("legs on this floor, a marker where the person changed floors", () => {
    const entries = [
      entry(0, "arrived", { zone: "A", zone_id: "A" }),
      entry(10, "move", { zone: "B", zone_id: "B" }),
      entry(20, "move", { zone: "C", zone_id: "C", floor_id: "3", floor: "Floor 3" }),
    ];
    const r = buildRoute(LAYOUT, "1", entries);
    expect(r.stops.map((s) => s.zoneId)).toEqual(["A", "B"]);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].fade).toBe(1);
    expect(r.marks).toEqual([expect.objectContaining({ text: "To Floor 3", dir: "up" })]);
    const up = buildRoute(LAYOUT, "3", entries);
    expect(up.stops.map((s) => s.zoneId)).toEqual(["C"]);
    expect(up.marks).toEqual([expect.objectContaining({ text: "From Floor 1", dir: "up" })]);
  });
});

describe("history panel", () => {
  const h = history([
    entry(0, "arrived", { text: "In ED Waiting Room when Live Ops started watching", zone: "ED Waiting Room" }),
    entry(40, "move", { text: "Moved from ED Waiting Room to ED-02 · now In treatment", zone: "ED-02", duration_text: "in ED-02 for 42 min" }),
    entry(60, "task", { text: "Transport request opened: Requested" }),
    entry(82, "status", { text: "In treatment → Boarding" }),
  ]);

  test("says since when Live Ops knows, filters, and toggles the route", () => {
    const onFilter = vi.fn();
    const onShowRoute = vi.fn();
    const { rerender } = render(
      <HistoryPanel history={{ data: h, error: null, loading: false }} filter="all" onFilter={onFilter} showRoute={false}
        onShowRoute={onShowRoute} floorName="Floor 1" canRoute now={at(100)} />,
    );
    expect(screen.getByText(/^History since /)).toBeTruthy();
    const items = screen.getAllByRole("listitem").filter((li) => li.closest(".lm-track-timeline"));
    expect(items[0].textContent).toContain("In treatment → Boarding"); // newest first
    expect(screen.getByText("in ED-02 for 42 min")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Moves" }));
    expect(onFilter).toHaveBeenCalledWith("moves");
    fireEvent.click(screen.getByRole("button", { name: "Show route" }));
    expect(onShowRoute).toHaveBeenCalledWith(true);
    rerender(
      <HistoryPanel history={{ data: h, error: null, loading: false }} filter="moves" onFilter={onFilter} showRoute
        onShowRoute={onShowRoute} floorName="Floor 1" canRoute={false} now={at(100)} />,
    );
    expect(screen.queryByText("Transport request opened: Requested")).toBeNull();
    expect(screen.queryByRole("button", { name: /route/ })).toBeNull(); // 2D view: no route
  });

  test("filters and the since line", () => {
    expect(matchesFilter(h.entries[2], "status")).toBe(true);
    expect(matchesFilter(h.entries[2], "moves")).toBe(false);
    expect(matchesFilter(h.entries[1], "status")).toBe(true); // a move that also changed status
    expect(sinceText(history([], { history_since: null }))).toMatch(/first change/);
  });

  test("empty and error states", () => {
    render(<HistoryPanel history={{ data: history([]), error: null, loading: false }} filter="all" onFilter={() => {}} showRoute={false}
      onShowRoute={() => {}} floorName="Floor 1" canRoute now={at(1)} />);
    expect(screen.getByText(/No changes recorded yet/)).toBeTruthy();
  });
});
