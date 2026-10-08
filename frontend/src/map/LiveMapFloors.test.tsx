import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Site, StreamMessage } from "../api/types";

const sq = (x: number, y: number, s = 10): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const site: Site = {
  id: "s1", name: "General Hospital", template: "hospital", created_ts: 0, updated_ts: 0,
  layout: {
    width: 100, depth: 60,
    floors: [
      { id: "g", name: "Ground", level: 0, width: 100, depth: 60, plan: { asset_id: "pg", x: 0, y: 0, w: 100, h: 60, opacity: 0.6 } },
      { id: "l2", name: "Level 2", level: 2, width: 80, depth: 40 },
    ],
    zones: [
      { id: "er", name: "ER", polygon: sq(0, 0), floor_id: "g" },
      { id: "w2", name: "Ward 2", polygon: sq(0, 0), floor_id: "l2" },
    ],
  },
};
let push: ((m: StreamMessage) => void) | null = null;

vi.mock("../api/client", () => ({
  ApiError: class extends Error { status = 500; },
  api: {
    sites: () => Promise.resolve([site]),
    site: () => Promise.resolve(site),
    sources: () => Promise.resolve([]),
    mappings: () => Promise.resolve([]),
    updateSite: vi.fn(),
  },
  openSiteStream: (_id: string, onMessage: (m: StreamMessage) => void) => {
    push = onMessage;
    return () => { push = null; };
  },
}));
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

import LiveMapPage from "../pages/LiveMapPage";

let search = "";
function Loc() {
  search = useLocation().search;
  return null;
}
const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/map/:siteId?" element={<><LiveMapPage /><Loc /></>} /></Routes>
    </MemoryRouter>,
  );

const a = (id: string, zone: string, floor?: string) =>
  ({ site_id: "s1", asset_id: id, updated_ts: 1, state: "free", zone, kind: "bed", ...(floor ? { floor } : {}), _sources: {} });

async function send(m: StreamMessage) {
  await act(async () => {
    push!(m);
    await new Promise((r) => setTimeout(r, 400));
  });
}

test("a site with floors shows one floor at a time with its plan, zones and assets", async () => {
  renderAt("/map/s1");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  // zone ER has its asset; B3 names its floor explicitly ("level 2", by name)
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [a("B1", "ER"), a("B2", "Ward 2"), a("B3", "ER", "level 2")] });

  const switcher = screen.getByRole("navigation", { name: "Floors" });
  const buttons = within(switcher).getAllByRole("button");
  // top floor first, like a lift panel, with counts
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Level 2: 2 assets", "Ground: 1 asset"]);
  expect(buttons.map((b) => b.textContent)).toEqual(["22", "G1"]);
  expect(within(switcher).getByRole("button", { name: /Ground/ }).getAttribute("aria-pressed")).toBe("true");

  const plan = document.querySelector("image.lm-plan")!;
  expect(plan.getAttribute("href")).toBe("/api/sites/s1/plans/pg");
  expect(plan.getAttribute("opacity")).toBe("0.6");
  expect(document.querySelector('[data-asset="B1"]')).toBeTruthy();
  expect(document.querySelector('[data-asset="B2"]')).toBeNull();

  fireEvent.click(within(switcher).getByRole("button", { name: /Level 2/ }));
  expect(search).toBe("?floor=l2");
  expect(document.querySelector("image.lm-plan")).toBeNull();
  expect(document.querySelector('[data-asset="B2"]')).toBeTruthy();
  expect(document.querySelector('[data-asset="B3"]')).toBeTruthy();
  expect(document.querySelector('[data-asset="B1"]')).toBeNull();
  expect(document.querySelector("svg.lm-svg")!.getAttribute("viewBox")).toMatch(/^-2 -2 84 /); // the 80-wide floor
});

test("selecting an asset on another floor moves the map to that floor", async () => {
  renderAt("/map/s1?floor=l2");
  await screen.findByRole("heading", { level: 1, name: "General Hospital" });
  await send({ type: "snapshot", site_id: "s1", ts: 1, event: null, assets: [a("B1", "ER"), a("B2", "Ward 2")] });
  expect(document.querySelector('[data-asset="B1"]')).toBeNull();
  fireEvent.change(screen.getByLabelText(/Find/), { target: { value: "B1" } });
  expect(search).toBe("");
  expect(document.querySelector('[data-asset="B1"]')).toBeTruthy();
});
