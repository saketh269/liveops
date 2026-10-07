import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Site, StreamMessage } from "../api/types";

const site: Site = {
  id: "s1", name: "General Hospital", template: "hospital", created_ts: 0, updated_ts: 0,
  layout: { width: 100, depth: 60, zones: [{ id: "icu", name: "ICU", polygon: [[0, 0], [30, 0], [30, 20], [0, 20]] }] },
};
let push: ((m: StreamMessage) => void) | null = null;
let status: ((s: "open" | "closed") => void) | undefined;
const updateSite = vi.fn();

vi.mock("../api/client", () => ({
  ApiError: class extends Error { status = 500; },
  api: {
    sites: () => Promise.resolve([site]),
    site: () => Promise.resolve(site),
    sources: () => Promise.resolve([{ id: "src", name: "Hospital EHR" }]),
    updateSite: (...args: unknown[]) => updateSite(...args),
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

test("stream drives the 2D fallback, KPIs, and the event feed", async () => {
  renderAt("/map/s1");
  expect(await screen.findByRole("heading", { level: 1, name: "General Hospital" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Connecting");
  act(() => status?.("open"));
  expect(screen.getByRole("status").textContent).toBe("Live");
  expect(screen.getByText(/2D view: .*WebGL is not available/)).toBeTruthy();

  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [bed("B1", "free"), bed("B2", "occupied"), bed("B3", "free", "Mars")] });
  const kpi = screen.getByRole("region", { name: /Status/ });
  expect(within(kpi).getByText("3 assets")).toBeTruthy();
  expect(kpi.querySelector('[data-state="free"]')!.textContent).toBe("2");
  expect(kpi.querySelector('[data-state="in-use"]')!.textContent).toBe("1");
  expect(within(kpi).getByRole("rowheader", { name: "Unassigned" })).toBeTruthy();
  expect(document.querySelector('[data-asset="B1"]')!.getAttribute("class")).toContain("lm-s-free");

  await send({ type: "upsert", site_id: "s1", ts: 2, event: null, assets: [bed("B1", "alert")] });
  expect(document.querySelector('[data-asset="B1"]')!.getAttribute("class")).toContain("lm-s-alert");
  const feed = screen.getByRole("log");
  expect(within(feed).getByText(/B1: state free → alert/)).toBeTruthy();
  expect(within(feed).getByText("ehr")).toBeTruthy();

  fireEvent.click(document.querySelector('[data-asset="B1"]')!);
  const details = screen.getByRole("region", { name: /B1/ });
  expect(within(details).getByText("alert")).toBeTruthy();
  act(() => status?.("closed"));
  expect(screen.getByRole("status").textContent).toBe("Reconnecting");
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
