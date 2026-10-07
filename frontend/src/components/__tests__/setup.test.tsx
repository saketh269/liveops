import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SitesPage from "../../pages/SitesPage";
import { mockApi, Reply, SITE, SOURCE } from "./mockApi";

const col = (name: string, type = "text", nullable = true) => ({ name, type, nullable });
const DATASETS = [
  { name: "epic.adt_beds", primary_key: ["bed_id"], supports_cdc: true, columns: [col("bed_id"), col("unit"), col("status")] },
  { name: "epic.encounters", primary_key: ["encounter_id"], supports_cdc: true,
    columns: [col("encounter_id", "integer"), col("bed_id"), col("patient_ref"), col("discharged_at", "timestamp with time zone")] },
  { name: "gps.ambulances", primary_key: ["unit_id"], supports_cdc: true, columns: [col("unit_id"), col("status"), col("dest_unit")] },
  { name: "epic.triage_queue", primary_key: ["id"], supports_cdc: true, columns: [col("id", "integer"), col("status")] },
];
const SUGGESTIONS = [
  {
    dataset: "epic.adt_beds", confidence: 0.9, attach_to: null, filter: null,
    reason: "Each row is a bed with a place on the map (unit) and a status (status).",
    config: { id_field: "bed_id", match_key: null, fields: { zone: "unit", state: "status" }, state_map: { occupied: "in_use" }, attributes: [], kind: "bed", filter: [] },
  },
  {
    dataset: "gps.ambulances", confidence: 0.5, attach_to: null, filter: null,
    reason: "Each row is an ambulance with a place on the map (dest_unit) and a status (status).",
    config: { id_field: "unit_id", match_key: null, fields: { zone: "dest_unit", state: "status" }, state_map: {}, attributes: [], kind: "ambulance", filter: [] },
  },
  {
    dataset: "epic.encounters", confidence: 0.85,
    attach_to: { dataset: "epic.adt_beds", mapping_id: null, match_key: "bed_id" },
    filter: [{ column: "discharged_at", op: "is_null", value: null }],
    reason: "Rows refer to beds in epic.adt_beds by bed_id, so they add details to those beds instead of new things on the map.",
    config: { id_field: "encounter_id", match_key: "bed_id", fields: {}, state_map: {}, attributes: ["patient_ref"], kind: null,
      filter: [{ column: "discharged_at", op: "is_null", value: null }] },
  },
  { dataset: "epic.triage_queue", config: null, confidence: 0, reason: "A queue or log with no location: counts, not things on the map. Use live counts instead." },
];
const ROWS = [
  { encounter_id: 1, bed_id: "B01", patient_ref: "P-1", discharged_at: null },
  { encounter_id: 2, bed_id: "B01", patient_ref: "P-0", discharged_at: "2026-10-06T10:00:00Z" },
];

function renderSetup(extra: Record<string, unknown> = {}, path = "/sites/site1/setup") {
  const api = mockApi({
    "GET /api/sites/site1": SITE,
    "GET /api/sources": [SOURCE],
    "GET /api/mappings": [],
    "GET /api/sources/src1/suggestions": SUGGESTIONS,
    "GET /api/sources/src1/datasets": DATASETS,
    "GET /api/sources/src1/preview": ROWS,
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/sites/*" element={<SitesPage />} /></Routes>
    </MemoryRouter>,
  );
  return api;
}

afterEach(() => vi.unstubAllGlobals());

test("Sites page links each site to Set up from a source", async () => {
  mockApi({ "GET /api/sites": [SITE], "GET /api/mappings": [] });
  render(<MemoryRouter initialEntries={["/sites"]}><Routes><Route path="/sites/*" element={<SitesPage />} /></Routes></MemoryRouter>);
  const link = await screen.findByRole("link", { name: "Set up from a source" });
  expect(link.getAttribute("href")).toBe("/sites/site1/setup");
});

test("checklist of suggestions with reasons, preview, skipped tables, and creating the selected ones in order", async () => {
  let n = 0;
  const api = renderSetup({
    "POST /api/mappings": (c: { body: { dataset: string } }) => new Reply(201, { id: `m${++n}`, ...c.body }),
  });
  const beds = await screen.findByRole("listitem", { name: "epic.adt_beds" });
  // Single source: chosen automatically, asked with the site id.
  expect(api.find("GET", "/api/sources/src1/suggestions")[0].search).toBe("?site_id=site1");
  expect(within(beds).getByText(/Each row is a bed/)).toBeTruthy();
  expect(within(beds).getByText("Strong match")).toBeTruthy();
  expect(within(beds).getByText(/occupied → In use/)).toBeTruthy();
  expect((within(beds).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);

  // Low confidence starts unticked.
  const amb = screen.getByRole("listitem", { name: "gps.ambulances" });
  expect((within(amb).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(within(amb).getByText("Possible match")).toBeTruthy();

  const visits = screen.getByRole("listitem", { name: "epic.encounters" });
  expect(within(visits).getByText("Adds details to epic.adt_beds")).toBeTruthy();
  expect(within(visits).getByText("Only rows where discharged_at is empty.")).toBeTruthy();

  // Preview shows sample rows and which ones the filter leaves out.
  fireEvent.click(within(visits).getByRole("button", { name: "Preview rows" }));
  const region = await within(visits).findByRole("region", { name: "Preview of epic.encounters" });
  expect(within(region).getAllByRole("row")).toHaveLength(3);
  expect(within(visits).getByText(/1 would be shown/)).toBeTruthy();
  expect(within(region).getByText("(left out)")).toBeTruthy();

  // Not suggested, with the reason.
  expect(screen.getByText("Not suggested (1)")).toBeTruthy();
  expect(screen.getByText(/counts, not things on the map/)).toBeTruthy();

  // Unticking the beds warns that the visits have nowhere to go.
  fireEvent.click(within(beds).getByRole("checkbox"));
  expect(within(visits).getByText(/which isn't selected/)).toBeTruthy();
  fireEvent.click(within(beds).getByRole("checkbox"));
  expect(within(visits).queryByText(/which isn't selected/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Create 2 mappings" }));
  await screen.findByText("Created 2 mappings.");
  const posts = api.find("POST", "/api/mappings").map((c) => c.body as { dataset: string; site_id: string; source_id: string; config: { filter: unknown } });
  // The beds first, then the details that attach to them.
  expect(posts.map((p) => p.dataset)).toEqual(["epic.adt_beds", "epic.encounters"]);
  expect(posts[1]).toMatchObject({ site_id: "site1", source_id: "src1", config: { match_key: "bed_id", filter: [{ column: "discharged_at", op: "is_null" }] } });
  expect(within(beds).getByText("Created")).toBeTruthy();
  expect((within(beds).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("link", { name: "Open live map" }).getAttribute("href")).toBe("/map/site1");
});

test("edit before create, and per-item errors keep failed ones for a retry", async () => {
  const api = renderSetup({
    "POST /api/mappings": (c: { body: { dataset: string } }) =>
      c.body.dataset === "gps.ambulances"
        ? new Reply(422, { detail: { message: "Mapping doesn't match the table", problems: ["Column 'dest' isn't in this table"] } })
        : new Reply(201, { id: "m1", ...c.body }),
  });
  const amb = await screen.findByRole("listitem", { name: "gps.ambulances" });
  fireEvent.click(within(amb).getByRole("checkbox"));
  fireEvent.click(within(amb).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(amb).getByLabelText("Label"), { target: { value: "unit_id" } });
  fireEvent.change(within(amb).getByLabelText("Kind"), { target: { value: "vehicle" } });
  // Add a filter condition and leave it unfinished: creating is blocked with a clear message.
  fireEvent.click(within(amb).getByRole("button", { name: "Add a condition" }));
  fireEvent.click(screen.getByRole("button", { name: "Create 3 mappings" }));
  expect(await screen.findByText("Fix 1 suggestion before creating.")).toBeTruthy();
  expect(api.find("POST", "/api/mappings")).toHaveLength(0);
  fireEvent.change(within(amb).getByLabelText("Column for condition 1"), { target: { value: "status" } });
  fireEvent.change(within(amb).getByLabelText("Value for condition 1"), { target: { value: "idle" } });

  fireEvent.click(screen.getByRole("button", { name: "Create 3 mappings" }));
  await screen.findByText(/Created 2 of 3\. 1 mapping wasn't created/);
  const sent = api.find("POST", "/api/mappings").find((c) => (c.body as { dataset: string }).dataset === "gps.ambulances")!.body;
  expect(sent).toMatchObject({ config: { fields: { zone: "dest_unit", state: "status", label: "unit_id" }, kind: "vehicle", filter: [{ column: "status", op: "eq", value: "idle" }] } });
  expect(within(amb).getByText("Not created")).toBeTruthy();
  expect(within(amb).getByText("Column 'dest' isn't in this table")).toBeTruthy();
  // Only the failed one is left to create.
  await waitFor(() => expect(screen.getByRole("button", { name: "Create 1 mapping" })).toBeTruthy());
});

test("asks for a source when there are several, and explains errors", async () => {
  const other = { ...SOURCE, id: "src2", name: "Fleet API" };
  renderSetup({
    "GET /api/sources": [SOURCE, other],
    "GET /api/sources/src2/suggestions": new Reply(400, { detail: { message: "Couldn't sign in", hint: "Check the password." } }),
    "GET /api/sources/src2/datasets": [],
  });
  const pick = (await screen.findByLabelText("Read from")) as HTMLSelectElement;
  expect(pick.value).toBe("");
  fireEvent.change(pick, { target: { value: "src2" } });
  expect(await screen.findByText("Couldn't look at this source")).toBeTruthy();
  expect(screen.getByText("Check the password.")).toBeTruthy();
});

test("no sources yet: link to connect one", async () => {
  renderSetup({ "GET /api/sources": [] });
  expect(await screen.findByRole("link", { name: "Connect a source" })).toBeTruthy();
});
