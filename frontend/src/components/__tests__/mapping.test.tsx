import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import MappingPage from "../../pages/MappingPage";
import { mockApi, POSTGRES_SPEC, Reply, SITE, SOURCE } from "./mockApi";

const DATASETS = [
  {
    name: "public.beds", primary_key: ["bed_id"], supports_cdc: false,
    columns: [
      { name: "bed_id", type: "text", nullable: false },
      { name: "unit", type: "text", nullable: true },
      { name: "status", type: "text", nullable: true },
      { name: "bed_label", type: "text", nullable: true },
      { name: "patient_count", type: "integer", nullable: true },
    ],
  },
];
const ROWS = [
  { bed_id: "B01", unit: "ICU", status: "occupied", bed_label: "Bed 01", patient_count: 1 },
  { bed_id: "B02", unit: "ICU", status: "vacant", bed_label: "Bed 02", patient_count: 0 },
  { bed_id: "B03", unit: "Ward 4", status: "occupied", bed_label: "Bed 03", patient_count: 1 },
];
const MAPPING = {
  id: "m1", site_id: "site1", source_id: "src1", dataset: "public.beds",
  config: { id_field: "bed_id", match_key: null, fields: { state: "status" }, state_map: {}, attributes: [], kind: "bed" },
  options: { poll_interval_s: 3 }, active: true, running: true, created_ts: 1, updated_ts: 1,
};

function routes(extra: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/sites": [SITE],
    "GET /api/sources": [SOURCE],
    "GET /api/connectors": [POSTGRES_SPEC],
    "GET /api/mappings": [],
    "GET /api/health/mappings": [],
    "GET /api/sources/src1/datasets": DATASETS,
    "GET /api/sources/src1/preview": ROWS,
    ...extra,
  });
}
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/mapping/*" element={<MappingPage />} /></Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

test("guided steps: preview, guessed fields, state translation, match key, and the saved config", async () => {
  const api = routes({ "POST /api/mappings": (c: { body: object }) => new Reply(201, { ...MAPPING, ...c.body, id: "m2" }) });
  renderAt("/mapping/new?site=site1&source=src1");
  const ds = (await screen.findByLabelText("Table or dataset")) as HTMLSelectElement;
  fireEvent.change(ds, { target: { value: "public.beds" } });

  // Preview table
  const table = await screen.findByRole("region", { name: "Preview of records" });
  expect(within(table).getAllByRole("row")).toHaveLength(4);
  expect(within(table).getByText("Ward 4")).toBeTruthy();

  // ID from the primary key, other fields guessed from column names
  expect((screen.getByLabelText(/^ID column/) as HTMLSelectElement).value).toBe("bed_id");
  expect((screen.getByLabelText(/^Zone/) as HTMLSelectElement).value).toBe("unit");
  expect((screen.getByLabelText(/^State$/) as HTMLSelectElement).value).toBe("status");
  expect((screen.getByLabelText(/^Label/) as HTMLSelectElement).value).toBe("bed_label");

  // Distinct state values seen in the preview
  const group = screen.getByRole("group", { name: "State value translation" });
  expect(within(group).getByText("occupied")).toBeTruthy();
  expect(within(group).getByText("vacant")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Show “occupied” as"), { target: { value: "in_use" } });
  fireEvent.change(screen.getByLabelText("Show “vacant” as"), { target: { value: "free" } });

  fireEvent.click(screen.getByLabelText("patient_count"));
  fireEvent.change(screen.getByLabelText(/^Kind/), { target: { value: "bed" } });
  expect(screen.getByText("Use the same key on two sources to combine them into one asset.")).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/Use another column/));
  fireEvent.change(screen.getByLabelText("Shared key column"), { target: { value: "bed_label" } });
  fireEvent.change(screen.getByLabelText(/Check for changes every/), { target: { value: "5" } });

  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  await waitFor(() => expect(api.find("POST", "/api/mappings")).toHaveLength(1));
  expect(api.find("POST", "/api/mappings")[0].body).toEqual({
    site_id: "site1", source_id: "src1", dataset: "public.beds", active: true,
    options: { poll_interval_s: 5 },
    config: {
      id_field: "bed_id", match_key: "bed_label",
      fields: { zone: "unit", state: "status", label: "bed_label" },
      state_map: { occupied: "in_use", vacant: "free" },
      attributes: ["patient_count"], kind: "bed",
    },
  });
});

test("client-side checks and API 422 problems are shown inline", async () => {
  routes({
    "POST /api/mappings": new Reply(422, { detail: { message: "Mapping doesn't match the table", problems: ["Column 'wardx' isn't in this table"] } }),
  });
  renderAt("/mapping/new?site=site1&source=src1");
  fireEvent.change(await screen.findByLabelText("Table or dataset"), { target: { value: "public.beds" } });
  await screen.findByRole("region", { name: "Preview of records" });

  fireEvent.change(screen.getByLabelText(/^ID column/), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText(/Check for changes every/), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  expect(screen.getByText(/Choose the column that identifies each asset/)).toBeTruthy();
  expect(screen.getByText("Enter a number of seconds between 1 and 3600.")).toBeTruthy();

  fireEvent.change(screen.getByLabelText(/^ID column/), { target: { value: "bed_id" } });
  fireEvent.change(screen.getByLabelText(/Check for changes every/), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  const alert = await screen.findByText("Couldn't save the mapping");
  const box = alert.closest("[role=alert]") as HTMLElement;
  expect(box.textContent).toContain("Mapping doesn't match the table");
  expect(within(box).getByText("Column 'wardx' isn't in this table")).toBeTruthy();
});

test("FastAPI body validation errors are readable", async () => {
  routes({
    "POST /api/mappings": new Reply(422, { detail: [{ loc: ["body", "config", "id_field"], msg: "Field required", type: "missing" }] }),
  });
  renderAt("/mapping/new?site=site1&source=src1");
  fireEvent.change(await screen.findByLabelText("Table or dataset"), { target: { value: "public.beds" } });
  await screen.findByRole("region", { name: "Preview of records" });
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  expect(await screen.findByText("config.id_field: Field required")).toBeTruthy();
});

test("list shows status per site with Pause, Resume and in-page delete", async () => {
  const api = routes({
    "GET /api/mappings": [MAPPING, { ...MAPPING, id: "m3", dataset: "public.rooms", active: false, running: false }],
    "PUT /api/mappings/m1": { ...MAPPING, active: false, running: false },
    "DELETE /api/mappings/m3": new Reply(204),
  });
  renderAt("/mapping");
  const beds = await screen.findByRole("listitem", { name: "Mapping public.beds" });
  expect(within(beds).getByText("Running")).toBeTruthy();
  const rooms = screen.getByRole("listitem", { name: "Mapping public.rooms" });
  expect(within(rooms).getByText("Paused")).toBeTruthy();
  expect(within(rooms).getByRole("button", { name: "Resume" })).toBeTruthy();

  fireEvent.click(within(beds).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(api.find("PUT", "/api/mappings/m1")[0]?.body).toEqual({ active: false }));

  fireEvent.click(within(rooms).getByRole("button", { name: "Delete mapping" }));
  expect(within(rooms).getByText(/Its assets disappear from the live map/)).toBeTruthy();
  fireEvent.click(within(rooms).getByRole("button", { name: "Yes, delete" }));
  await waitFor(() => expect(api.find("DELETE", "/api/mappings/m3")).toHaveLength(1));
});

test("editing keeps site and source fixed and sends an update", async () => {
  const api = routes({ "GET /api/mappings": [MAPPING], "PUT /api/mappings/m1": MAPPING });
  renderAt("/mapping/m1/edit");
  expect(((await screen.findByLabelText("Show the assets on")) as HTMLSelectElement).disabled).toBe(true);
  await screen.findByRole("region", { name: "Preview of records" });
  expect((screen.getByLabelText(/^Kind/) as HTMLInputElement).value).toBe("bed");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.find("PUT", "/api/mappings/m1")).toHaveLength(1));
  expect(api.find("PUT", "/api/mappings/m1")[0].body).toMatchObject({ dataset: "public.beds", options: { poll_interval_s: 3 } });
});
