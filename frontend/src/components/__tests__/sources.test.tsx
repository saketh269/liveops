import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SourcesPage from "../../pages/SourcesPage";
import { initialValues, toSettings, validate } from "../forms/SchemaForm";
import { mockApi, OTHER_SPECS, POSTGRES_SPEC, Reply, SOURCE } from "./mockApi";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/sources/*" element={<SourcesPage />} /></Routes>
    </MemoryRouter>,
  );
}
const input = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

afterEach(() => vi.unstubAllGlobals());

describe("schema form helpers", () => {
  test("defaults, typed conversion and required checks come from the schema", () => {
    const v = initialValues(POSTGRES_SPEC.settings_schema);
    expect(v).toMatchObject({ port: "5432", encryption: "required", schemas: "public", host: "" });
    expect(toSettings(POSTGRES_SPEC.settings_schema, { ...v, host: " db ", port: "6543", schemas: "public, ops ,", database: "x", user: "u" }))
      .toEqual({ host: "db", port: 6543, encryption: "required", schemas: ["public", "ops"], database: "x", user: "u" });
    const errs = validate(POSTGRES_SPEC.settings_schema, { ...v, port: "54x" }, POSTGRES_SPEC.secrets_schema, { password: "" });
    expect(errs["settings.host"]).toBe("Host is required.");
    expect(errs["settings.port"]).toBe("Port must be a whole number.");
    expect(errs["secrets.password"]).toBe("Password is required.");
    // A saved secret satisfies "required" when editing.
    expect(validate(POSTGRES_SPEC.settings_schema, v, POSTGRES_SPEC.secrets_schema, { password: "" }, { password: true })["secrets.password"]).toBeUndefined();
  });
});

describe("Sources", () => {
  test("empty list tells the user how to connect the first source", async () => {
    mockApi({ "GET /api/connectors": [POSTGRES_SPEC], "GET /api/sources": [] });
    renderAt("/sources");
    expect(await screen.findByText("No sources yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect your first source" }).getAttribute("href")).toBe("/sources/new");
  });

  test("picker groups by category, shows maturity honestly, and the form is generated from the schemas", async () => {
    const api = mockApi({
      "GET /api/connectors": [POSTGRES_SPEC, ...OTHER_SPECS],
      "POST /api/sources": (c: { body: { name: string } }) => new Reply(201, { ...SOURCE, name: c.body.name }),
      "GET /api/sources/src1": SOURCE,
      "POST /api/sources/src1/test": { ok: true, duration_ms: 42, steps: [{ name: "Reach the server", ok: true, detail: "db:5432", hint: "" }] },
    });
    renderAt("/sources/new");
    const databases = await screen.findByRole("region", { name: "Databases" });
    expect(within(databases).getByText("PostgreSQL")).toBeTruthy();
    expect(within(databases).getByText("Not yet tested on a real server")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "APIs and webhooks" })).getByText("Beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /PostgreSQL/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Connect PostgreSQL");
    expect(input(/^Port/).value).toBe("5432");
    expect(input(/^Schemas to list/).value).toBe("public");
    expect(input(/^Password/).type).toBe("password");
    expect(input(/^Host/).placeholder).toBe("e.g. db.example.com");
    const enc = screen.getByLabelText(/^Encryption/) as HTMLSelectElement;
    expect(enc.value).toBe("required");
    expect(screen.getByText("Use 'off' only for local testing.")).toBeTruthy();
    // Required marks
    expect(screen.getByText("Host").parentElement?.textContent).toContain("*");

    // Submitting empty shows field errors and does not call the API.
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    expect(screen.getByText("Host is required.")).toBeTruthy();
    expect(screen.getByText("Password is required.")).toBeTruthy();
    expect(api.find("POST", "/api/sources")).toHaveLength(0);

    // Choosing Off shows a clear warning.
    fireEvent.change(enc, { target: { value: "off" } });
    expect(screen.getByText("Encryption is off.")).toBeTruthy();
    fireEvent.change(enc, { target: { value: "required" } });
    expect(screen.queryByText("Encryption is off.")).toBeNull();

    fireEvent.change(input(/^Name/), { target: { value: "Hospital EHR" } });
    fireEvent.change(input(/^Host/), { target: { value: "db.local" } });
    fireEvent.change(input(/^Database/), { target: { value: "ehr" } });
    fireEvent.change(input(/^Read-only user/), { target: { value: "liveops_ro" } });
    fireEvent.change(input(/^Schemas to list/), { target: { value: "public, ops" } });
    fireEvent.change(input(/^Password/), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));

    await waitFor(() => expect(api.find("POST", "/api/sources")).toHaveLength(1));
    expect(api.find("POST", "/api/sources")[0].body).toEqual({
      name: "Hospital EHR", type: "postgres",
      settings: { host: "db.local", port: 5432, database: "ehr", user: "liveops_ro", encryption: "required", schemas: ["public", "ops"] },
      secrets: { password: "s3cret" },
    });
    // Lands on the source page and runs the test automatically.
    expect(await screen.findByText("Connection works.")).toBeTruthy();
    expect(api.find("POST", "/api/sources/src1/test")).toHaveLength(1);
  });

  test("server 422 for missing fields is shown and the fields are marked", async () => {
    mockApi({
      "GET /api/connectors": [POSTGRES_SPEC],
      "POST /api/sources": new Reply(422, { detail: { message: "Missing required fields", fields: ["database"] } }),
    });
    renderAt("/sources/new");
    fireEvent.click(await screen.findByRole("button", { name: /PostgreSQL/ }));
    fireEvent.change(input(/^Name/), { target: { value: "x" } });
    fireEvent.change(input(/^Host/), { target: { value: "h" } });
    fireEvent.change(input(/^Database/), { target: { value: "d" } });
    fireEvent.change(input(/^Read-only user/), { target: { value: "u" } });
    fireEvent.change(input(/^Password/), { target: { value: "p" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save the source");
    expect(alert.textContent).toContain("Missing required fields");
    expect(alert.textContent).toContain("database");
    expect(input(/^Database/).getAttribute("aria-invalid")).toBe("true");
  });

  test("test connection shows each step with a mark, detail and plain-words hint", async () => {
    mockApi({
      "GET /api/connectors": [POSTGRES_SPEC],
      "GET /api/sources/src1": SOURCE,
      "POST /api/sources/src1/test": {
        ok: false, duration_ms: 120, steps: [
          { name: "Reach the server", ok: true, detail: "db.local:5432", hint: "" },
          { name: "Sign in", ok: false, detail: "password authentication failed", hint: "Check the user name and password." },
          { name: "List tables", ok: false, detail: "0 tables or views readable", hint: "" },
        ],
      },
    });
    renderAt("/sources/src1");
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    const list = await screen.findByRole("list", { name: "Connection checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("✓");
    expect(items[0].textContent).toContain("passed");
    expect(items[1].textContent).toContain("✗");
    expect(items[1].textContent).toContain("password authentication failed");
    expect(items[1].textContent).toContain("How to fix: Check the user name and password.");
    // A failed step without a hint still tells the user what to do.
    expect(items[2].textContent).toContain("How to fix: Check the settings for this step");
    expect(screen.getByText("Connection needs attention.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test again" })).toBeTruthy();
  });

  test("edit never pre-fills secrets, blank keeps them, delete confirms in-page", async () => {
    const api = mockApi({
      "GET /api/connectors": [POSTGRES_SPEC],
      "GET /api/sources/src1": SOURCE,
      "PUT /api/sources/src1": (c: { body: { name: string } }) => ({ ...SOURCE, name: c.body.name, updated_ts: SOURCE.updated_ts + 1 }),
      "POST /api/sources/src1/test": { ok: true, duration_ms: 5, steps: [] },
      "DELETE /api/sources/src1": new Reply(204),
      "GET /api/sources": [],
    });
    renderAt("/sources/src1");
    const pw = (await screen.findByLabelText(/^Password/)) as HTMLInputElement;
    expect(pw.value).toBe("");
    expect(screen.getByText(/A value is saved\. Leave this blank to keep it/)).toBeTruthy();
    expect(input(/^Host/).value).toBe("db.local");

    fireEvent.change(input(/^Name/), { target: { value: "EHR (prod)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.find("PUT", "/api/sources/src1")).toHaveLength(1));
    expect(api.find("PUT", "/api/sources/src1")[0].body).toMatchObject({ name: "EHR (prod)", secrets: {} });
    expect(await screen.findByText(/Changes saved/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    const confirm = screen.getByRole("group", { name: /Confirm delete/ });
    expect(confirm.textContent).toContain("Every mapping that uses this source will stop");
    expect(api.find("DELETE", "/api/sources/src1")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(api.find("DELETE", "/api/sources/src1")).toHaveLength(1));
  });

  test("list shows warnings and a useful error when the server is unreachable", async () => {
    mockApi({
      "GET /api/connectors": [POSTGRES_SPEC],
      "GET /api/sources": [{ ...SOURCE, warnings: ["Encryption is off. Use this only for local testing."] }],
    });
    renderAt("/sources");
    expect(await screen.findByText("1 warning")).toBeTruthy();
    expect(screen.getByText(/Encryption is off\. Use this only/)).toBeTruthy();
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    renderAt("/sources");
    expect(await screen.findByText("Can't reach the Live Ops server.")).toBeTruthy();
  });
});
