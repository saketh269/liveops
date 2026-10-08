import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Site, StreamMessage } from "../api/types";

const site: Site = {
  id: "s1", name: "General Hospital", template: "hospital", created_ts: 0, updated_ts: 0,
  layout: { width: 100, depth: 60, zones: [{ id: "icu", name: "ICU", polygon: [[0, 0], [30, 0], [30, 20], [0, 20]] }] },
};
let push: ((m: StreamMessage) => void) | null = null;
let status: ((s: "open" | "closed") => void) | undefined;
const updateSite = vi.fn();
let mappingsList: unknown[] = [];

vi.mock("../api/client", () => ({
  ApiError: class extends Error { status = 500; },
  api: {
    sites: () => Promise.resolve([site]),
    site: () => Promise.resolve(site),
    sources: () => Promise.resolve([{ id: "src", name: "Hospital EHR" }]),
    mappings: () => Promise.resolve(mappingsList),
    updateSite: (...args: unknown[]) => updateSite(...args),
    assetHistory: (siteId: string, assetId: string) => Promise.resolve({
      site_id: siteId, asset_id: assetId, present: true, current: null, history_since: 1, retention_days: 30, truncated: false,
      entries: [], milestones: [], now: 2,
    }),
  },
  openSiteStream: (_id: string, onMessage: (m: StreamMessage) => void, onStatus?: (s: "open" | "closed") => void) => {
    push = onMessage;
    status = onStatus;
    return () => { push = null; };
  },
}));
// jsdom has no WebGL: the page must fall back to the 2D view.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

import LiveMapPage from "../pages/LiveMapPage";

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/map/:siteId?" element={<LiveMapPage />} /></Routes>
    </MemoryRouter>,
  );

const bed = (id: string, state: string, zone = "ICU") =>
  ({ site_id: "s1", asset_id: id, updated_ts: 1, state, zone, kind: "bed", _sources: { state: "ehr" } });

async function send(m: StreamMessage) {
  await act(async () => {
    push!(m);
    await new Promise((r) => setTimeout(r, 400)); // batching + 250 ms UI throttle
  });
}

test("site picker lists sites when no id is given", async () => {
  renderAt("/map");
  expect((await screen.findByRole("link", { name: /General Hospital/ })).getAttribute("href")).toBe("/map/s1");
});

test("stream drives the 2D fallback, KPI tiles, the side card and its events", async () => {
  renderAt("/map/s1");
  expect(await screen.findByRole("heading", { level: 1, name: "General Hospital" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Connecting");
  act(() => status?.("open"));
  expect(screen.getByRole("status").textContent).toBe("Live");
  expect(screen.getByText(/2D view: .*WebGL is not available/)).toBeTruthy();

  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [bed("B1", "free"), bed("B2", "occupied"), bed("B3", "free", "Mars")] });
  const kpis = screen.getByRole("group", { name: "Key figures" });
  const tile = (id: string) => kpis.querySelector(`[data-kpi="${id}"]`)!;
  expect(tile("beds").textContent).toContain("Beds used1/ 3");
  expect(tile("alerts").querySelector("[data-value]")!.textContent).toBe("0");
  expect(document.querySelector('[data-asset="B1"]')!.getAttribute("class")).toContain("lm-s-free");
  // Overview card: one chip per bed on the floor
  const side = screen.getByRole("complementary", { name: "Main floor" });
  expect(within(side).getAllByRole("button", { name: /^B\d: / }).map((b) => b.textContent)).toEqual(["B1Free", "B2In use", "B3Free"]);

  await send({ type: "upsert", site_id: "s1", ts: 2, event: null, assets: [bed("B1", "alert")] });
  expect(document.querySelector('[data-asset="B1"]')!.getAttribute("class")).toContain("lm-s-alert");
  expect(tile("alerts").querySelector("[data-value]")!.textContent).toBe("1");
  expect(tile("alerts").className).toContain("lm-hud-kpi--alert");
  expect(within(within(side).getByRole("log")).getByText(/is alert \(was free\)/)).toBeTruthy();

  // The tile selects the worst record; the card shows it with the source that set each field.
  fireEvent.click(tile("alerts"));
  const card = screen.getByRole("complementary", { name: "B1" });
  expect(card.querySelector(".lm-hud-chip--alert")!.textContent).toBe("Alert");
  expect(within(within(card).getByRole("region", { name: "From ehr" })).getByText("Location")).toBeTruthy();
  expect(await within(screen.getByRole("region", { name: /Journey/ })).findByText("No state changes recorded yet.")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Back" }));
  expect(screen.getByRole("complementary", { name: "Main floor" })).toBeTruthy();
  act(() => status?.("closed"));
  expect(screen.getByRole("status").textContent).toBe("Reconnecting");
});

test("demo mode hides setup notices and editing chrome but keeps the live cards", async () => {
  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  // Two records in a zone the layout lacks: a place worth adding (one record there for a moment would be a passage).
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [bed("B1", "free"), bed("B3", "free", "Mars"), bed("B4", "free", "Mars")] });
  expect(await screen.findByRole("region", { name: "Setup" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit layout" })).toBeTruthy();
  cleanup();

  renderAt("/map/s1?demo=1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [bed("B1", "free"), bed("B3", "free", "Mars")] });
  expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();
  expect(screen.queryByText(/zones that aren't on the map yet/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit layout" })).toBeNull();
  expect(screen.getByRole("region", { name: /Live map of/ }).className).toContain("lm-live--demo");
  expect(document.body.classList.contains("lm-demo")).toBe(true);
  expect(screen.getByRole("group", { name: "Key figures" })).toBeTruthy();
  cleanup();
  expect(document.body.classList.contains("lm-demo")).toBe(false);
});

test("layout editor adds a zone and saves via updateSite; validation blocks bad layouts", async () => {
  updateSite.mockImplementation((_id: string, b: { layout: Site["layout"] }) => Promise.resolve({ ...site, layout: b.layout }));
  renderAt("/map/s1?edit=1");
  fireEvent.click(await screen.findByRole("button", { name: "Add zone" }));
  const name = screen.getByLabelText("Name");
  fireEvent.change(name, { target: { value: "Ward B" } });
  fireEvent.click(screen.getByRole("button", { name: "Save layout" }));
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  const [, body] = updateSite.mock.calls[0];
  expect(body.layout.zones.map((z: { name: string }) => z.name)).toEqual(["ICU", "Ward B"]);
  expect(body.layout.width).toBe(100);
  expect(await screen.findByText(/Layout saved: 2 zones/)).toBeTruthy();

  fireEvent.change(name, { target: { value: "icu" } });
  fireEvent.click(screen.getByRole("button", { name: "Save layout" }));
  expect(await screen.findByText(/2 zones are named "icu"/)).toBeTruthy();
  expect(updateSite).toHaveBeenCalledTimes(1);
});

test("zones are created from the data when the layout matches none of it", async () => {
  updateSite.mockReset();
  updateSite.mockImplementation((_id: string, b: { layout: Site["layout"] }) => Promise.resolve({ ...site, layout: b.layout }));
  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", assets: [bed("B1", "free", "ER"), bed("B2", "occupied", "General")], event: null, ts: 1 });
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  const zones = updateSite.mock.calls[0][1].layout.zones.map((z: { name: string }) => z.name);
  expect(zones).toEqual(["ER", "General"]);
  expect(await screen.findByText(/Created 2 zones from your data: ER, General/)).toBeTruthy();
});

test("records with no zone or state point at the mapping that needs fixing", async () => {
  mappingsList = [{ id: "m9", site_id: "s1", source_id: "src", dataset: "epic.triage_queue", active: true, config: { id_field: "id", fields: {} } }];
  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", assets: [{ site_id: "s1", asset_id: "1", updated_ts: 1, _sources: {} }], event: null, ts: 1 });
  expect(await screen.findByText(/epic\.triage_queue/)).toBeTruthy();
  expect(screen.getByText(/Zone and State not set/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Fix this mapping" }).getAttribute("href")).toBe("/mapping/m9/edit");
  mappingsList = [];
});

// --- polish fix ---
const walker = (id: string, zone: string) => ({ site_id: "s1", asset_id: id, updated_ts: 1, state: "in_use", zone, kind: "patient", _sources: { state: "ehr" } });

test("people in transit are never offered as zones; with nothing to act on there is no setup card", async () => {
  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [bed("B1", "free"), walker("P1", "En route ED-07 → 4E-405A"), walker("P2", "Discharged"), walker("P3", "Cath Lab")] });
  expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();

  await send({ type: "upsert", site_id: "s1", ts: 2, event: null, assets: [bed("B3", "free", "Mars"), bed("B4", "free", "Mars")] });
  const card = await screen.findByRole("region", { name: "Setup" });
  expect(within(card).getByRole("button", { name: "Add this zone" })).toBeTruthy();
  expect(card.textContent).toContain("Mars (2)");
  expect(card.textContent).not.toMatch(/En route|Discharged|Cath Lab/);
  expect(card.textContent).toContain("3 people in transit");
});

test("a dismissed setup card stays away for that site until its notices change", async () => {
  try { window.localStorage.clear(); } catch { /* storage unavailable */ }
  const assets = [bed("B1", "free"), bed("B3", "free", "Mars"), bed("B4", "free", "Mars")];
  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets });
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss setup notices" }));
  expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();
  cleanup();

  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets });
  expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();
  await send({ type: "upsert", site_id: "s1", ts: 2, event: null, assets: [bed("B5", "free", "Venus"), bed("B6", "free", "Venus")] });
  expect(await screen.findByRole("region", { name: "Setup" })).toBeTruthy();
  try { window.localStorage.clear(); } catch { /* storage unavailable */ }
});
// --- end polish fix ---
