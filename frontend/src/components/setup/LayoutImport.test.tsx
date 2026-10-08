import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { LayoutImportResult, Site, Source } from "../../api/types";

const sources = vi.fn();
const importLayout = vi.fn();
vi.mock("../../api/client", () => ({
  ApiError: class extends Error {
    status: number; hint?: string; problems?: string[];
    constructor(status: number, message: string, hint?: string, problems?: string[]) {
      super(message); this.status = status; this.hint = hint; this.problems = problems;
    }
  },
  api: {
    sources: (...a: unknown[]) => sources(...a),
    importLayout: (...a: unknown[]) => importLayout(...a),
  },
}));

import { ApiError } from "../../api/client";
import { LayoutImport, describeKinds } from "./LayoutImport";

const site: Site = { id: "s1", name: "hs", template: "hospital", layout: { zones: [] }, created_ts: 0, updated_ts: 0 };
const src = (id: string, type: string, name = id): Source =>
  ({ id, name, type, settings: {}, secrets_set: {}, warnings: [], created_ts: 0, updated_ts: 0 });
const sq = (x: number, y: number): [number, number][] => [[x, y], [x + 4, y], [x + 4, y + 5], [x, y + 5]];

const result = (over: Partial<LayoutImportResult["summary"]> = {}, saved = false): LayoutImportResult => ({
  saved,
  layout: {
    floors: [{ id: "1", name: "Floor 1", level: 0, width: 30, depth: 20 }, { id: "2", name: "Floor 2", level: 1, width: 30, depth: 20 }],
    zones: [
      { id: "ED-01", name: "ED-01", kind: "room", floor_id: "1", polygon: sq(0, 0) },
      { id: "ED-corridor", name: "ED corridor", kind: "corridor", floor_id: "1", polygon: sq(0, 7) },
      { id: "ICU-201", name: "ICU-201", kind: "room", floor_id: "2", polygon: sq(0, 0) },
    ],
  },
  summary: {
    format: "riverside", floors: 2, zones: 3, zones_by_kind: { corridor: 1, room: 2 }, beds: 2,
    kept_zones: 0, removed_zones: 0, warnings: [], problems: [], ...over,
  },
});

const renderIt = (props: Partial<Parameters<typeof LayoutImport>[0]> = {}) =>
  render(<MemoryRouter><LayoutImport site={site} onImported={() => {}} {...props} /></MemoryRouter>);

beforeEach(() => {
  sources.mockReset().mockResolvedValue([src("pg", "postgres", "Warehouse DB"), src("beds", "rest", "Riverside – Beds")]);
  importLayout.mockReset();
});

test("lists only API sources and previews with the default path, then imports", async () => {
  const onImported = vi.fn();
  importLayout.mockImplementation((_id: string, b: { dry_run: boolean }) => Promise.resolve(result({}, !b.dry_run)));
  renderIt({ onImported });
  const select = (await screen.findByLabelText("Source")) as HTMLSelectElement;
  expect([...select.options].map((o) => o.text)).toEqual(["Riverside – Beds"]);
  expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/api/floor-layout");
  const importBtn = screen.getByRole("button", { name: "Import" });
  expect((importBtn as HTMLButtonElement).disabled).toBe(true); // preview first

  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByRole("region", { name: "Import preview" });
  expect(importLayout).toHaveBeenLastCalledWith("s1", {
    source_id: "beds", path: "/api/floor-layout", format: "auto", mode: "merge", dry_run: true, options: undefined,
  });
  expect(screen.getByText(/2 floors, 3 zones \(2 rooms, 1 corridor\), 2 beds/)).toBeTruthy();
  expect(screen.getByRole("img", { name: "Floor 1: 2 zones" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Floor 2: 1 zone" })).toBeTruthy();
  expect(onImported).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("radio", { name: /Replace/ }));
  expect(screen.queryByRole("region", { name: "Import preview" })).toBeNull(); // a changed choice needs a new preview
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByRole("region", { name: "Import preview" });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  expect(importLayout).toHaveBeenLastCalledWith("s1", expect.objectContaining({ mode: "replace", dry_run: false }));
  expect(onImported.mock.calls[0][0].layout.floors).toHaveLength(2);
  expect(screen.getByRole("status").textContent).toMatch(/Layout imported: 2 floors, 3 zones/);
});

test("warnings are listed and problems block the import", async () => {
  importLayout.mockResolvedValue(result({
    warnings: ["Room R2 lies partly outside unit U."],
    problems: ['2 zones are named "ed-01". Zone names must be unique so assets land in the right one.'],
    kept_zones: 1,
  }));
  renderIt();
  fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
  expect(await screen.findByText("Room R2 lies partly outside unit U.")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toMatch(/can't be saved yet.*2 zones are named/);
  expect(screen.getByText(/Keeps 1 zone you added/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
});

test("errors from the source are shown in plain language with the hint", async () => {
  importLayout.mockRejectedValue(new ApiError(400, "The API refused the request (HTTP 401)",
    "Check the sign-in method and the API key or token, and that it may read this endpoint."));
  renderIt();
  fireEvent.change(await screen.findByLabelText("Path"), { target: { value: "/v2/layout" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read the layout");
  expect(alert.textContent).toContain("HTTP 401");
  expect(alert.textContent).toContain("Check the sign-in method");
  expect(importLayout.mock.calls[0][1].path).toBe("/v2/layout");
});

test("the optional root and format are sent", async () => {
  importLayout.mockResolvedValue(result());
  renderIt();
  fireEvent.change(await screen.findByLabelText("Format"), { target: { value: "geojson-lite" } });
  fireEvent.change(screen.getByLabelText("Where the layout is in the response"), { target: { value: " data.layout " } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(importLayout).toHaveBeenCalled());
  expect(importLayout.mock.calls[0][1]).toMatchObject({ format: "geojson-lite", options: { root: "data.layout" } });
});

test("import asks first when the caller says so", async () => {
  importLayout.mockResolvedValue(result());
  const confirmImport = vi.fn(() => false);
  renderIt({ confirmImport });
  fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
  await screen.findByRole("region", { name: "Import preview" });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(confirmImport).toHaveBeenCalled();
  expect(importLayout).toHaveBeenCalledTimes(1); // only the preview
});

test("without an API source it explains what to connect", async () => {
  sources.mockResolvedValue([src("pg", "postgres")]);
  renderIt();
  expect(await screen.findByText(/reads floors and rooms from an API source/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connect a source" }).getAttribute("href")).toBe("/sources/new");
  expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
});

test("describeKinds names kinds in plain words, most first", () => {
  expect(describeKinds({ corridor: 7, room: 130, waiting: 7, spaceship: 1 })).toBe("130 rooms, 7 corridors, 7 waiting areas, 1 spaceship");
});
