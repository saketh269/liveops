import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Site, SiteLayout } from "../api/types";

const updateSite = vi.fn();
const uploadPlan = vi.fn();
const deletePlan = vi.fn();
const sources = vi.fn();
const importLayout = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {
    status: number; hint?: string;
    constructor(status: number, message: string, hint?: string) { super(message); this.status = status; this.hint = hint; }
  },
  api: {
    updateSite: (...a: unknown[]) => updateSite(...a),
    uploadPlan: (...a: unknown[]) => uploadPlan(...a),
    deletePlan: (...a: unknown[]) => deletePlan(...a),
    sources: (...a: unknown[]) => sources(...a),
    importLayout: (...a: unknown[]) => importLayout(...a),
  },
}));

import { ApiError } from "../api/client";
import LayoutEditor from "./LayoutEditor";

const sq = (x: number, y: number, s = 10): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const mk = (layout: SiteLayout): Site => ({ id: "s1", name: "General", template: "hospital", created_ts: 0, updated_ts: 0, layout });
const oldSite = mk({ width: 100, depth: 60, zones: [{ id: "icu", name: "ICU", polygon: sq(0, 0) }] });

beforeEach(() => {
  updateSite.mockReset().mockImplementation((_id: string, b: { layout: SiteLayout }) => Promise.resolve(mk(b.layout)));
  uploadPlan.mockReset();
  deletePlan.mockReset().mockResolvedValue(undefined);
});

const saved = () => updateSite.mock.calls.at(-1)![1].layout as SiteLayout;
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save layout" }));

test("an old layout saves back in the old shape when only zones change", async () => {
  render(<LayoutEditor site={oldSite} onSaved={() => {}} onClose={() => {}} />);
  fireEvent.focus(screen.getByRole("button", { name: "Zone ICU" }));
  fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "unit" } });
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  expect(saved()).toEqual({ width: 100, depth: 60, zones: [{ id: "icu", name: "ICU", polygon: sq(0, 0), kind: "unit" }] });
});

test("floors: add, rename, switch, reorder and draw zones on the chosen floor", async () => {
  render(<LayoutEditor site={oldSite} onSaved={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add floor" }));
  // the new floor is selected and empty
  expect(screen.getByText(/No zones on this floor yet/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Floor name"), { target: { value: "Level 2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add zone" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ward 2A" } });
  // switching floors shows that floor's zones only
  fireEvent.click(within(screen.getByRole("list", { name: /Floors/ })).getByRole("button", { name: "Main floor" }));
  expect(screen.getByRole("button", { name: "Zone ICU" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Zone Ward 2A" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Move Level 2 down" }));
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  const l = saved();
  expect(l.floors!.map((f) => [f.id, f.name, f.level])).toEqual([["floor-2", "Level 2", 0], ["main", "Main floor", 1]]);
  expect(l.zones!.map((z) => [z.name, z.floor_id])).toEqual([["ICU", "main"], ["Ward 2A", "floor-2"]]);
  expect(await screen.findByText(/Layout saved: 2 zones on 2 floors/)).toBeTruthy();
});

test("deleting a floor asks first and removes its zones", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const site = mk({
    floors: [{ id: "g", name: "Ground", level: 0, width: 50, depth: 40 }, { id: "l1", name: "Level 1", level: 1, width: 50, depth: 40 }],
    zones: [{ id: "a", name: "A", polygon: sq(0, 0), floor_id: "g" }, { id: "b", name: "B", polygon: sq(0, 0), floor_id: "l1" }],
  });
  render(<LayoutEditor site={site} onSaved={() => {}} onClose={() => {}} initialFloorId="l1" />);
  expect(screen.getByRole("button", { name: "Zone B" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete Level 1" }));
  expect(confirm.mock.calls[0][0]).toMatch(/Delete Level 1 with 1 zone\?/);
  expect(screen.getByRole("button", { name: "Zone A" })).toBeTruthy();
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  expect(saved().zones!.map((z) => z.id)).toEqual(["a"]);
  confirm.mockRestore();
});

test("doors are added on a chosen edge and removed from the list", async () => {
  render(<LayoutEditor site={oldSite} onSaved={() => {}} onClose={() => {}} />);
  fireEvent.focus(screen.getByRole("button", { name: "Zone ICU" }));
  fireEvent.change(screen.getByLabelText("Edge for the new door"), { target: { value: "1" } }); // right
  fireEvent.click(screen.getByRole("button", { name: "Add door" }));
  expect(screen.getByText(/Door on the right edge/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Zone ICU, 1 door" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add door" })); // same spot: not added twice
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  expect(saved().zones![0].doors).toEqual([[10, 5]]);
  fireEvent.click(screen.getByRole("button", { name: "Remove door at 10, 5" }));
  expect(screen.getByText(/No doors: people enter/)).toBeTruthy();
});

test("zones move with the keyboard and carry their doors", async () => {
  const site = mk({ width: 100, depth: 60, zones: [{ id: "icu", name: "ICU", polygon: sq(0, 0), doors: [[10, 5]] }] });
  render(<LayoutEditor site={site} onSaved={() => {}} onClose={() => {}} />);
  const zone = screen.getByRole("button", { name: "Zone ICU, 1 door" });
  fireEvent.keyDown(zone, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(zone, { key: "ArrowDown" });
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  expect(saved().zones![0]).toMatchObject({ polygon: sq(5, 1), doors: [[15, 6]] });
});

test("entrances: add, rename, move, and validation in plain language", async () => {
  render(<LayoutEditor site={oldSite} onSaved={() => {}} onClose={() => {}} />);
  expect(screen.getByText(/People walk in at the middle of the bottom edge/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add ambulance bay" }));
  fireEvent.change(screen.getByLabelText("Entrance name"), { target: { value: "" } });
  save();
  expect(await screen.findByText(/An entrance has no name/)).toBeTruthy();
  expect(updateSite).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Entrance name"), { target: { value: "East ambulance bay" } });
  const marker = screen.getByRole("button", { name: "Ambulance bay East ambulance bay" });
  fireEvent.keyDown(marker, { key: "ArrowRight" });
  fireEvent.keyDown(marker, { key: "ArrowDown" }); // already on the bottom edge: stays on the floor
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  expect(saved().entrances).toEqual([{ id: "entrance-1", name: "East ambulance bay", floor_id: "main", point: [1, 60], kind: "ambulance" }]);
  expect(saved().floors).toHaveLength(1);
});

test("plan upload fits the image to the floor, can be adjusted, and replaced images are cleaned up on save", async () => {
  uploadPlan.mockResolvedValueOnce({ asset_id: "p1", width_px: 2000, height_px: 600, content_type: "image/png" });
  const site = mk({ floors: [{ id: "g", name: "Ground", level: 0, width: 100, depth: 60, plan: { asset_id: "old", x: 0, y: 0, w: 100, h: 60 } }] });
  const { container } = render(<LayoutEditor site={site} onSaved={() => {}} onClose={() => {}} />);
  expect(container.querySelector("image.lm-plan")!.getAttribute("href")).toBe("/api/sites/s1/plans/old");
  const file = new File(["x"], "level-0.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Floor plan file"), { target: { files: [file] } });
  await waitFor(() => expect(container.querySelector("image.lm-plan")!.getAttribute("href")).toBe("/api/sites/s1/plans/p1"));
  expect(uploadPlan).toHaveBeenCalledWith("s1", file);
  // 2000×600 into 100×60: full width, 30 deep, centred
  expect((screen.getByLabelText("Depth", { selector: "[id$='-h2']" }) as HTMLInputElement).value).toBe("30");
  expect((screen.getByLabelText("Y", { selector: "[id*='-y']" }) as HTMLInputElement).value).toBe("15");
  fireEvent.change(screen.getByLabelText(/Opacity/), { target: { value: "0.5" } });
  save();
  await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
  expect(saved().floors![0].plan).toEqual({ asset_id: "p1", x: 0, y: 15, w: 100, h: 30, opacity: 0.5 });
  expect(deletePlan).toHaveBeenCalledWith("s1", "old");
  expect(deletePlan).not.toHaveBeenCalledWith("s1", "p1");
});

test("a failed upload explains what to do; leaving without saving deletes uploaded images", async () => {
  uploadPlan.mockRejectedValueOnce(new ApiError(415, "This PDF could not be read", "Export the floor plan as PNG and upload that."));
  uploadPlan.mockResolvedValueOnce({ asset_id: "p2", width_px: 100, height_px: 60, content_type: "image/png" });
  const { unmount } = render(<LayoutEditor site={oldSite} onSaved={() => {}} onClose={() => {}} />);
  const input = screen.getByLabelText("Floor plan file");
  fireEvent.change(input, { target: { files: [new File(["%PDF"], "plan.pdf")] } });
  expect((await screen.findByRole("alert")).textContent).toMatch(/Could not upload plan.pdf: This PDF could not be read\. Export the floor plan as PNG/);
  fireEvent.change(input, { target: { files: [new File(["x"], "plan.png")] } });
  await screen.findByRole("button", { name: "Remove plan" });
  unmount();
  expect(deletePlan).toHaveBeenCalledWith("s1", "p2");
});

test("import layout from a source: the editor shows the saved import and tells the map", async () => {
  sources.mockResolvedValue([{ id: "beds", name: "Beds API", type: "rest", settings: {}, secrets_set: {}, warnings: [], created_ts: 0, updated_ts: 0 }]);
  const imported: SiteLayout = {
    floors: [{ id: "1", name: "Floor 1", level: 0, width: 40, depth: 30 }],
    zones: [{ id: "ED-01", name: "ED-01", kind: "room", floor_id: "1", polygon: sq(0, 0) }],
  };
  importLayout.mockImplementation((_id: string, b: { dry_run: boolean }) => Promise.resolve({
    layout: imported, saved: !b.dry_run,
    summary: { format: "riverside", floors: 1, zones: 1, zones_by_kind: { room: 1 }, beds: 1, kept_zones: 0, removed_zones: 1, warnings: [], problems: [] },
  }));
  const onSaved = vi.fn();
  render(<MemoryRouter><LayoutEditor site={oldSite} onSaved={onSaved} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Import layout from a source" }));
  fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
  await screen.findByRole("region", { name: "Import preview" });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(onSaved.mock.calls[0][0].layout).toEqual(imported);
  expect(screen.getByRole("button", { name: "Zone ED-01" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Zone ICU" })).toBeNull();
  expect(updateSite).not.toHaveBeenCalled(); // the import endpoint saved it
});
