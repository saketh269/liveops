import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HealthPage, { HEALTH_POLL_MS } from "../../pages/HealthPage";
import { mockApi, SITE, SOURCE } from "./mockApi";

const NOW = 1791350000;
const MAPPINGS = [
  { id: "m1", site_id: "site1", source_id: "src1", dataset: "public.beds", config: { id_field: "bed_id", fields: {} }, options: {}, active: true, running: true, created_ts: 1, updated_ts: 1 },
  { id: "m2", site_id: "site1", source_id: "src1", dataset: "public.rooms", config: { id_field: "room_id", fields: {} }, options: {}, active: true, running: false, created_ts: 1, updated_ts: 1 },
  { id: "m3", site_id: "site1", source_id: "src1", dataset: "public.carts", config: { id_field: "cart_id", fields: {} }, options: {}, active: false, running: false, created_ts: 1, updated_ts: 1 },
];
const HEALTH = [
  { mapping_id: "m1", source_id: "src1", status: "running", last_event_ts: NOW - 30, events_total: 120, events_per_min: 42, lag_ms_p95: 1234.5, skipped_records: 3, last_error: null, last_error_hint: null, last_error_ts: null },
  { mapping_id: "m2", source_id: "src1", status: "error", last_event_ts: null, events_total: 0, events_per_min: 0, lag_ms_p95: null, skipped_records: 0, last_error: "password authentication failed", last_error_hint: "Check the user name and password.", last_error_ts: NOW - 120 },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("shows app version and per-mapping health, and polls every 5 seconds", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW * 1000);
  const api = mockApi({
    "GET /api/health": { ok: true, version: "0.1.0", portal_db: "ok" },
    "GET /api/health/mappings": HEALTH,
    "GET /api/mappings": MAPPINGS,
    "GET /api/sources": [SOURCE],
    "GET /api/sites": [SITE],
  });
  render(<MemoryRouter><HealthPage /></MemoryRouter>);

  const app = await screen.findByLabelText("App health");
  expect(app.textContent).toContain("v0.1.0");
  expect(app.textContent).toContain("Portal database: ok");

  const beds = screen.getByRole("listitem", { name: "Health of public.beds" });
  expect(within(beds).getByText("Running")).toBeTruthy();
  expect(within(beds).getByText("42")).toBeTruthy(); // events/min
  expect(within(beds).getByText("1.2 s")).toBeTruthy(); // lag p95
  expect(within(beds).getByText("3")).toBeTruthy(); // skipped
  expect(beds.textContent).toContain("Last event 30 s ago");
  expect(beds.textContent).toContain("Hospital EHR");
  expect(beds.textContent).toContain("St Mary's");

  const rooms = screen.getByRole("listitem", { name: "Health of public.rooms" });
  expect(within(rooms).getByText("Error")).toBeTruthy();
  expect(rooms.textContent).toContain("Error 2 min ago: password authentication failed");
  expect(rooms.textContent).toContain("Check the user name and password.");

  // A paused mapping the runner doesn't track still shows up.
  const carts = screen.getByRole("listitem", { name: "Health of public.carts" });
  expect(within(carts).getByText("Paused")).toBeTruthy();

  expect(api.find("GET", "/api/health/mappings")).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS); });
  expect(api.find("GET", "/api/health/mappings")).toHaveLength(2);
});

test("keeps the last state and explains when the server stops answering", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let fail = false;
  mockApi({
    "GET /api/health": () => { if (fail) throw new TypeError("Failed to fetch"); return { ok: true, version: "0.1.0" }; },
    "GET /api/health/mappings": [],
    "GET /api/mappings": [],
    "GET /api/sources": [],
    "GET /api/sites": [],
  });
  render(<MemoryRouter><HealthPage /></MemoryRouter>);
  expect(await screen.findByText("No mappings yet")).toBeTruthy();
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS); });
  expect(await screen.findByText(/Lost contact with the server/)).toBeTruthy();
  expect(screen.getByText("Can't reach the Live Ops server.")).toBeTruthy();
  expect(screen.getByText("No mappings yet")).toBeTruthy();
});
