import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ConnectorSpec } from "../../api/types";
import SourcesPage from "../../pages/SourcesPage";
import { initialValues, toSettings, validate, valuesFrom, type FormValues } from "../forms/SchemaForm";
import { mockApi, POSTGRES_SPEC, Reply, SOURCE } from "./mockApi";
// Real specs as served by GET /api/connectors (backend/app/connectors, integration @ dcb6dfc).
import realSpecs from "./fixtures/connectors.json";

const SPECS = realSpecs as unknown as ConnectorSpec[];
const REST = SPECS.find((s) => s.type === "rest")!;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/sources/*" element={<SourcesPage />} /></Routes>
    </MemoryRouter>,
  );
}
const input = (label: RegExp | string) => screen.getByLabelText(label) as HTMLInputElement;

afterEach(() => vi.unstubAllGlobals());

describe("object and array settings (LIVEOPS-20)", () => {
  test("every real connector's defaults convert without stringifying objects", () => {
    for (const spec of SPECS) {
      const out = toSettings(spec.settings_schema, initialValues(spec.settings_schema));
      for (const [k, v] of Object.entries(out)) {
        expect(v, `${spec.type}.${k}`).not.toBe("[object Object]");
        const want = spec.settings_schema.properties?.[k]?.type;
        if (want === "object") expect(typeof v === "object" && !Array.isArray(v), `${spec.type}.${k}`).toBe(true);
        if (want === "array") expect(Array.isArray(v), `${spec.type}.${k}`).toBe(true);
      }
    }
  });

  test("REST query parameters round-trip as an object; arrays stay arrays", () => {
    const saved = { base_url: "https://api.example.com", query: { status: "active", ward: "4" } };
    const values = valuesFrom(REST.settings_schema, saved);
    expect(values.query).toEqual([{ key: "status", value: "active" }, { key: "ward", value: "4" }]);
    const out = toSettings(REST.settings_schema, values);
    expect(out.query).toEqual({ status: "active", ward: "4" });
    expect(out.page_size).toBe(100);
    expect(out.timeout_s).toBe(15);
    expect(out.allow_http).toBe(false);

    const pg = SPECS.find((s) => s.type === "postgres")!;
    expect(toSettings(pg.settings_schema, valuesFrom(pg.settings_schema, { schemas: ["public", "ops"] })).schemas).toEqual(["public", "ops"]);
  });

  test("key/value rows are checked; schema limits are enforced", () => {
    const v: FormValues = { ...initialValues(REST.settings_schema), base_url: "https://x", query: [{ key: "", value: "1" }] };
    expect(validate(REST.settings_schema, v, REST.secrets_schema, {})["settings.query"]).toBe("Every value in Query parameters needs a name.");
    v.query = [{ key: "a", value: "1" }, { key: "a", value: "2" }];
    expect(validate(REST.settings_schema, v, REST.secrets_schema, {})["settings.query"]).toBe("Query parameters has the same name twice.");
    v.query = [];
    v.max_pages = "5000";
    expect(validate(REST.settings_schema, v, REST.secrets_schema, {})["settings.max_pages"]).toBe("Max pages per poll must be at most 1000.");
    const wh = SPECS.find((s) => s.type === "webhook")!;
    expect(validate(wh.settings_schema, initialValues(wh.settings_schema), wh.secrets_schema, { signing_secret: "short" })["secrets.signing_secret"])
      .toBe("Signing secret must be at least 16 characters.");
  });

  test("connecting a REST API sends query parameters as an object", async () => {
    const api = mockApi({
      "GET /api/connectors": SPECS,
      "POST /api/sources": (c: { body: object }) => new Reply(201, { ...SOURCE, ...c.body, id: "r1", secrets_set: {} }),
      "GET /api/sources/r1": { ...SOURCE, id: "r1", type: "rest", settings: {}, secrets_set: {} },
      "POST /api/sources/r1/test": { ok: true, duration_ms: 1, steps: [] },
    });
    renderAt("/sources/new");
    fireEvent.click(await screen.findByRole("button", { name: /^REST API/ }));
    fireEvent.change(input(/^Name/), { target: { value: "Beds API" } });
    fireEvent.change(input(/^Base URL/), { target: { value: "https://api.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add query parameter" }));
    fireEvent.change(input("Query parameters: name 1"), { target: { value: "status" } });
    fireEvent.change(input("Query parameters: value 1"), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "Add query parameter" }));
    fireEvent.change(input("Query parameters: name 2"), { target: { value: "ward" } });
    fireEvent.change(input("Query parameters: value 2"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText("Allow plain HTTP"));
    expect(screen.getByText("Plain HTTP is allowed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(api.find("POST", "/api/sources")).toHaveLength(1));
    const body = api.find("POST", "/api/sources")[0].body as { settings: Record<string, unknown> };
    expect(body.settings.query).toEqual({ status: "active", ward: "4" });
    expect(body.settings.allow_http).toBe(true);
    expect(JSON.stringify(body)).not.toContain("[object Object]");
  });
});

describe("picker and edit behaviour for the integrated backend", () => {
  test("the two PostgreSQL types are told apart by a mode badge and description", async () => {
    mockApi({ "GET /api/connectors": SPECS });
    renderAt("/sources/new");
    const live = await screen.findByRole("button", { name: /^PostgreSQL \(live changes\)/ });
    expect(within(live).getByText("Live changes")).toBeTruthy();
    expect(live.textContent).toContain("logical replication");
    const poll = screen.getByRole("button", { name: /^PostgreSQL(?! \(live)/ });
    expect(within(poll).getByText("Checks every few seconds")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^Webhook/ })).getByText("Pushed live")).toBeTruthy();
  });

  test("changing the host asks for the password again before saving", async () => {
    const api = mockApi({
      "GET /api/connectors": [POSTGRES_SPEC],
      "GET /api/sources/src1": SOURCE,
      "PUT /api/sources/src1": (c: { body: object }) => ({ ...SOURCE, ...c.body, updated_ts: 2 }),
      "POST /api/sources/src1/test": { ok: true, duration_ms: 1, steps: [] },
    });
    renderAt("/sources/src1");
    fireEvent.change(await screen.findByLabelText(/^Host/), { target: { value: "db2.local" } });
    expect(screen.getByText(/Saved credentials are only sent to the server they were entered for/)).toBeTruthy();
    expect(screen.getByText(/You changed the host, so enter this again/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Password is required.")).toBeTruthy();
    expect(api.find("PUT", "/api/sources/src1")).toHaveLength(0);

    fireEvent.change(input(/^Password/), { target: { value: "new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.find("PUT", "/api/sources/src1")).toHaveLength(1));
    expect(api.find("PUT", "/api/sources/src1")[0].body).toMatchObject({ settings: { host: "db2.local" }, secrets: { password: "new-pass" } });
  });

  test("the server's re-enter 422 marks the secret field", async () => {
    mockApi({
      "GET /api/connectors": [REST],
      "GET /api/sources/r1": { ...SOURCE, id: "r1", type: "rest", settings: { base_url: "https://a.example.com" }, secrets_set: { api_key: true } },
      "PUT /api/sources/r1": new Reply(422, { detail: { message: "Re-enter the password or token when changing base_url", hint: "Saved credentials are only sent to the server they were entered for.", fields: ["api_key"] } }),
    });
    renderAt("/sources/r1");
    await screen.findByLabelText(/^Base URL/);
    fireEvent.change(input(/^Name/), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByText("Couldn't save the source");
    expect(alert.closest("[role=alert]")!.textContent).toContain("Re-enter the password or token when changing base_url");
    expect(screen.getByText("Enter it again to use the new address.")).toBeTruthy();
  });

  test("an optional saved secret can be removed (sent as null)", async () => {
    const api = mockApi({
      "GET /api/connectors": [REST],
      "GET /api/sources/r1": { ...SOURCE, id: "r1", type: "rest", settings: { base_url: "https://a.example.com", query: { a: "1" } }, secrets_set: { api_key: true } },
      "PUT /api/sources/r1": (c: { body: object }) => ({ ...SOURCE, id: "r1", type: "rest", ...c.body, secrets_set: {}, updated_ts: 2 }),
      "POST /api/sources/r1/test": { ok: true, duration_ms: 1, steps: [] },
    });
    renderAt("/sources/r1");
    expect(((await screen.findByLabelText("Query parameters: name 1")) as HTMLInputElement).value).toBe("a");
    fireEvent.click(screen.getByLabelText("Remove the saved api key"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.find("PUT", "/api/sources/r1")).toHaveLength(1));
    const body = api.find("PUT", "/api/sources/r1")[0].body as { secrets: object; settings: { query: object } };
    expect(body.secrets).toEqual({ api_key: null });
    expect(body.settings.query).toEqual({ a: "1" });
  });

  test("secrets that can't be decrypted (409) show the fix", async () => {
    mockApi({
      "GET /api/connectors": [POSTGRES_SPEC],
      "GET /api/sources": new Reply(409, { detail: { message: "Stored secrets can't be decrypted; was LIVEOPS_SECRET_KEY changed?", hint: "Open the source, enter its password or token again, and save. Then resume the mapping." } }),
    });
    renderAt("/sources");
    const box = (await screen.findByText("Couldn't load sources")).closest("[role=alert]") as HTMLElement;
    expect(box.textContent).toContain("was LIVEOPS_SECRET_KEY changed?");
    expect(box.textContent).toContain("enter its password or token again");
  });
});
