// LIVEOPS-112: tracking a patient who changes floor, goes somewhere off the floor plan,
// is discharged, or while the user looks at another floor. Page level (2D view in jsdom).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Asset, Site, StreamMessage } from "../../api/types";

const rect = (x: number, y: number, w = 4, h = 4): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
// Synthetic site shaped like the user's hospital: a basement below Floor 1, one room zone per bed.
const site: Site = {
  id: "hs", name: "Riverside", template: "hospital", created_ts: 0, updated_ts: 0,
  layout: {
    floors: [
      { id: "B1", name: "Basement B1", level: -1, width: 40, depth: 20 },
      { id: "1", name: "Floor 1", level: 0, width: 40, depth: 20 },
      { id: "3", name: "Floor 3", level: 2, width: 40, depth: 20 },
      { id: "4", name: "Floor 4", level: 3, width: 40, depth: 20 },
    ],
    zones: [
      { id: "B1-corridor", name: "B1 corridor", kind: "corridor", floor_id: "B1", polygon: rect(0, 10, 40, 4) },
      { id: "ED-01", name: "ED-01", kind: "room", floor_id: "1", polygon: rect(0, 0) },
      { id: "3W-305A", name: "3W-305A", kind: "room", floor_id: "3", polygon: rect(0, 0) },
      { id: "4E-401A", name: "4E-401A", kind: "room", floor_id: "4", polygon: rect(10, 0) },
      { id: "4E-402A", name: "4E-402A", kind: "room", floor_id: "4", polygon: rect(20, 0) },
    ],
  },
};
let push: ((m: StreamMessage) => void) | null = null;

vi.mock("../../api/client", () => ({
  ApiError: class extends Error { status = 500; },
  api: {
    sites: () => Promise.resolve([site]),
    site: () => Promise.resolve(site),
    sources: () => Promise.resolve([]),
    mappings: () => Promise.resolve([]),
    updateSite: vi.fn(),
    assetHistory: () => new Promise(() => {}),
  },
  openSiteStream: (_id: string, onMessage: (m: StreamMessage) => void) => {
    push = onMessage;
    return () => { push = null; };
  },
}));
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

import LiveMapPage from "../../pages/LiveMapPage";

let search = "";
function Loc() {
  search = useLocation().search;
  return null;
}
const patient = (zone: string, ts: number): Asset =>
  ({ site_id: "hs", asset_id: "P7400136", label: "P7400136", kind: "patient", state: "in_use", zone, updated_ts: ts, _sources: {} });
const other: Asset = { site_id: "hs", asset_id: "S1", label: "S1", kind: "staff", zone: "ED-01", updated_ts: 1, _sources: {} };

async function send(m: Omit<StreamMessage, "site_id" | "event" | "ts">) {
  await act(async () => {
    push!({ site_id: "hs", event: null, ts: 1, ...m });
    await new Promise((r) => setTimeout(r, 400));
  });
}
const floorShown = () => document.querySelector(".lm-hud-floorname")?.textContent;
const notice = () => document.querySelector(".lm-track-notice")?.textContent ?? "";
const railPressed = () =>
  within(screen.getByRole("navigation", { name: "Floors" })).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));

async function trackPatient() {
  render(
    <MemoryRouter initialEntries={["/map/hs"]}>
      <Routes><Route path="/map/:siteId?" element={<><LiveMapPage /><Loc /></>} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { level: 1, name: "Riverside" });
  await send({ type: "snapshot", assets: [patient("3W-305A", 1), other] });
  fireEvent.change(screen.getByLabelText(/Find/), { target: { value: "P7400136" } });
  expect(floorShown()).toBe("Floor 3");
  fireEvent.click(screen.getByRole("button", { name: "Track" }));
  expect(screen.getByRole("button", { name: "Stop tracking" }).getAttribute("aria-pressed")).toBe("true");
}

test("follows the patient to a bed on another floor: the map and floor rail switch, with a 'moved to' hint", async () => {
  await trackPatient();
  await send({ type: "upsert", assets: [patient("4E-401A", 2)] });
  expect(search).toBe("?floor=4");
  expect(floorShown()).toBe("Floor 4");
  expect(railPressed()).toEqual([expect.stringMatching(/^Floor 4/)]);
  expect(notice()).toMatch(/moved to Floor 4/);
  expect(document.querySelector('[data-asset="P7400136"]')).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop tracking" })).toBeTruthy();
});

test("en route between floors: keeps tracking and says where the patient is, never jumps to the basement", async () => {
  await trackPatient();
  await send({ type: "upsert", assets: [patient("En route 3W-305A → 4E-401A", 2)] });
  expect(floorShown()).not.toBe("Basement B1");
  expect(notice()).toMatch(/on the way from 3W-305A to 4E-401A/);
  expect(screen.getByText(/on the way from 3W-305A to 4E-401A/i, { selector: ".lm-track-where" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop tracking" })).toBeTruthy();
  // ...and arrives
  await send({ type: "upsert", assets: [patient("4E-401A", 3)] });
  expect(floorShown()).toBe("Floor 4");
  expect(document.querySelector(".lm-track-where")).toBeNull();
});

test("a place that is not on the floor plan (Radiology – MRI): still tracking, says where", async () => {
  await trackPatient();
  await send({ type: "upsert", assets: [patient("Radiology – MRI", 2)] });
  expect(floorShown()).toBe("Floor 3"); // stays: no idea which floor the MRI is on
  expect(notice()).toMatch(/at Radiology – MRI/);
  expect(screen.getByRole("button", { name: "Stop tracking" })).toBeTruthy();
});

test("picking another floor while tracking pauses following; 'Return to patient' brings it back", async () => {
  await trackPatient();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Floors" })).getByRole("button", { name: /^Floor 1/ }));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(floorShown()).toBe("Floor 1");
  const back = screen.getByRole("button", { name: "Return to patient" });
  // the patient moves while the user looks elsewhere: the map does not yank them away
  await send({ type: "upsert", assets: [patient("4E-402A", 2)] });
  expect(floorShown()).toBe("Floor 1");
  expect(notice()).toMatch(/moved to Floor 4/);
  fireEvent.click(back);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(floorShown()).toBe("Floor 4");
  expect(screen.queryByRole("button", { name: "Return to patient" })).toBeNull();
  // following again: the next move switches floors by itself
  await send({ type: "upsert", assets: [patient("3W-305A", 3)] });
  expect(floorShown()).toBe("Floor 3");
});
