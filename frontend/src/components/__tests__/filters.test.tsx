import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Column } from "../../api/types";
import { describeFilter, draftProblem, fromDraft, rowMatches, toDraft } from "../mapping/filters";
import MappingPage from "../../pages/MappingPage";
import { mockApi, POSTGRES_SPEC, Reply, SITE, SOURCE } from "./mockApi";

const COLS: Column[] = [
  { name: "task_id", type: "integer", nullable: false },
  { name: "bed_id", type: "text", nullable: false },
  { name: "status", type: "text", nullable: false },
  { name: "done_at", type: "timestamp with time zone", nullable: true },
  { name: "urgent", type: "boolean", nullable: true },
];

test("plain-language summaries", () => {
  expect(describeFilter([])).toBe("All rows");
  expect(describeFilter([{ column: "discharged_at", op: "is_null" }])).toBe("Only rows where discharged_at is empty");
  expect(describeFilter([
    { column: "status", op: "ne", value: "done" },
    { column: "unit", op: "in", value: ["ER", "ICU"] },
    { column: "eta_min", op: "lte", value: 10 },
  ])).toBe("Only rows where status is not “done” and unit is one of “ER”, “ICU” and eta_min is at most 10");
});

test("drafts become typed filters, and problems are explained", () => {
  expect(fromDraft({ column: "task_id", op: "in", text: "1, 2,3" }, COLS)).toEqual({ column: "task_id", op: "in", value: [1, 2, 3] });
  expect(fromDraft({ column: "urgent", op: "eq", text: "true" }, COLS)).toEqual({ column: "urgent", op: "eq", value: true });
  expect(fromDraft({ column: "done_at", op: "is_null", text: "ignored" }, COLS)).toEqual({ column: "done_at", op: "is_null" });
  expect(fromDraft({ column: "status", op: "eq", text: " open " }, COLS)).toEqual({ column: "status", op: "eq", value: "open" });
  expect(toDraft({ column: "unit", op: "in", value: ["ER", "ICU"] })).toEqual({ column: "unit", op: "in", text: "ER, ICU" });

  expect(draftProblem({ column: "", op: "eq", text: "x" }, COLS)).toMatch(/Choose a column/);
  expect(draftProblem({ column: "gone", op: "eq", text: "x" }, COLS)).toMatch(/isn't in this table/);
  expect(draftProblem({ column: "status", op: "eq", text: " " }, COLS)).toMatch(/Enter a value/);
  expect(draftProblem({ column: "status", op: "in", text: ", ," }, COLS)).toMatch(/separated by commas/);
  expect(draftProblem({ column: "task_id", op: "gt", text: "ten" }, COLS)).toMatch(/number/);
  expect(draftProblem({ column: "done_at", op: "gt", text: "soon" }, COLS)).toMatch(/date/);
  expect(draftProblem({ column: "urgent", op: "eq", text: "maybe" }, COLS)).toMatch(/true or false/);
  expect(draftProblem({ column: "done_at", op: "is_null", text: "" }, COLS)).toBeUndefined();
});

test("preview estimate matches rows like the backend", () => {
  const rows = [
    { status: "open", done_at: null, n: 5, t: "2026-10-07T10:00:00+00:00", ok: true },
    { status: "done", done_at: "2026-10-07T11:00:00+00:00", n: "7", t: "2026-10-06", ok: false },
  ];
  const count = (f: Parameters<typeof rowMatches>[1]) => rows.filter((r) => rowMatches(r, f)).length;
  expect(count([{ column: "done_at", op: "is_null" }])).toBe(1);
  expect(count([{ column: "status", op: "not_in", value: ["done"] }])).toBe(1);
  expect(count([{ column: "n", op: "gte", value: "5" }])).toBe(2); // "7" is numeric text: ordered as a number
  expect(rowMatches({ code: "10" }, [{ column: "code", op: "gt", value: "9" }])).toBe(true);
  expect(rowMatches({ code: "007" }, [{ column: "code", op: "eq", value: "7" }])).toBe(false);
  expect(count([{ column: "t", op: "gt", value: "2026-10-07" }])).toBe(1);
  expect(count([{ column: "ok", op: "eq", value: "true" }])).toBe(1);
  expect(count([{ column: "status", op: "contains", value: "OP" }])).toBe(1);
  expect(count([])).toBe(2);
});

const DATASETS = [{ name: "evs.tasks", primary_key: ["task_id"], supports_cdc: true, columns: COLS }];
const ROWS = [
  { task_id: 1, bed_id: "B1", status: "open", done_at: null, urgent: true },
  { task_id: 2, bed_id: "B2", status: "done", done_at: "2026-10-07T10:00:00Z", urgent: false },
];

function renderWizard(path: string, extra: Record<string, unknown> = {}) {
  const api = mockApi({
    "GET /api/sites": [SITE], "GET /api/sources": [SOURCE], "GET /api/connectors": [POSTGRES_SPEC],
    "GET /api/mappings": [], "GET /api/health/mappings": [],
    "GET /api/sources/src1/datasets": DATASETS, "GET /api/sources/src1/preview": ROWS,
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/mapping/*" element={<MappingPage />} /></Routes>
    </MemoryRouter>,
  );
  return api;
}

afterEach(() => vi.unstubAllGlobals());

test("wizard: add, check and save a row filter with a plain-language summary", async () => {
  const api = renderWizard("/mapping/new?site=site1&source=src1", {
    "POST /api/mappings": (c: { body: object }) => new Reply(201, { id: "m9", active: true, site_id: "site1", ...c.body }),
  });
  fireEvent.change(await screen.findByLabelText("Table or dataset"), { target: { value: "evs.tasks" } });
  await screen.findByRole("region", { name: "Preview of records" });
  expect(screen.getByText(/Every row is shown/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Add a condition" }));
  // An unfinished condition blocks saving and says why.
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  expect(await screen.findByText("Choose a column.")).toBeTruthy();
  expect(api.find("POST", "/api/mappings")).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Column for condition 1"), { target: { value: "done_at" } });
  fireEvent.change(screen.getByLabelText("Comparison for condition 1"), { target: { value: "is_null" } });
  expect(screen.queryByLabelText("Value for condition 1")).toBeNull();
  expect(screen.getByText("Only rows where done_at is empty.")).toBeTruthy();
  expect(screen.getByText(/1 of the 2 sample rows match/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Add a condition" }));
  fireEvent.change(screen.getByLabelText("Column for condition 2"), { target: { value: "urgent" } });
  fireEvent.change(screen.getByLabelText("Value for condition 2"), { target: { value: "true" } });
  expect(screen.getByText("Only rows where done_at is empty and urgent is true.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove condition 2" }));

  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  await waitFor(() => expect(api.find("POST", "/api/mappings")).toHaveLength(1));
  const body = api.find("POST", "/api/mappings")[0].body as { config: { filter: unknown } };
  expect(body.config.filter).toEqual([{ column: "done_at", op: "is_null" }]);
});

test("wizard: a saved filter loads for editing and can be cleared", async () => {
  const mapping = {
    id: "m1", site_id: "site1", source_id: "src1", dataset: "evs.tasks",
    config: { id_field: "task_id", match_key: "bed_id", fields: {}, state_map: {}, attributes: [], kind: null,
      filter: [{ column: "status", op: "in", value: ["open", "queued"] }] },
    options: { poll_interval_s: 3 }, active: true, running: true, created_ts: 1, updated_ts: 1,
  };
  const api = renderWizard("/mapping/m1/edit", {
    "GET /api/mappings": [mapping],
    "PUT /api/mappings/m1": (c: { body: object }) => ({ ...mapping, ...c.body }),
  });
  expect(((await screen.findByLabelText("Value for condition 1")) as HTMLInputElement).value).toBe("open, queued");
  expect(screen.getByText("Only rows where status is one of “open”, “queued”.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove condition 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.find("PUT", "/api/mappings/m1")).toHaveLength(1));
  expect((api.find("PUT", "/api/mappings/m1")[0].body as { config: { filter: unknown } }).config.filter).toEqual([]);
});
