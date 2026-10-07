import type { ConnectorSpec } from "../../api/types";

/** A canned HTTP reply for mockApi. Plain values are sent as 200 JSON. */
export class Reply {
  constructor(public status: number, public body?: unknown) {}
}

type Call = { method: string; path: string; search: string; body: unknown };
type Route = unknown | ((call: Call) => unknown);

/**
 * Stubs global fetch with a route table keyed "METHOD /path".
 * Returns the recorded calls so tests can assert on request bodies.
 */
export function mockApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test.local");
    const method = init?.method ?? "GET";
    const call: Call = {
      method, path: url.pathname, search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ detail: { message: `No mock for ${method} ${url.pathname}` } }), { status: 500 });
    }
    const out = typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
    const reply = out instanceof Reply ? out : new Reply(200, out);
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

export const POSTGRES_SPEC: ConnectorSpec = {
  type: "postgres",
  display_name: "PostgreSQL",
  category: "database",
  modes: ["poll"],
  description: "Reads tables and views from PostgreSQL 12+ with a read-only user.",
  maturity: "stable",
  settings_schema: {
    type: "object",
    required: ["host", "port", "database", "user"],
    properties: {
      host: { type: "string", title: "Host", examples: ["db.example.com"] },
      port: { type: "integer", title: "Port", default: 5432 },
      database: { type: "string", title: "Database" },
      user: { type: "string", title: "Read-only user" },
      encryption: { type: "string", title: "Encryption", enum: ["required", "verify", "off"], default: "required", description: "Use 'off' only for local testing." },
      schemas: { type: "array", items: { type: "string" }, title: "Schemas to list", default: ["public"] },
    },
  },
  secrets_schema: {
    type: "object",
    required: ["password"],
    properties: { password: { type: "string", title: "Password", format: "password" } },
  },
};

export const OTHER_SPECS: ConnectorSpec[] = [
  {
    type: "rest", display_name: "REST API", category: "api", modes: ["poll"], description: "Polls a JSON endpoint.",
    maturity: "beta", settings_schema: { type: "object", properties: { url: { type: "string", title: "URL" } } },
    secrets_schema: { type: "object", properties: { token: { type: "string", title: "Token" } } },
  },
  {
    type: "oracle", display_name: "Oracle", category: "database", modes: ["poll"], description: "Oracle Database.",
    maturity: "needs_real_test", settings_schema: { type: "object", properties: {} }, secrets_schema: { type: "object", properties: {} },
  },
];

export const SOURCE = {
  id: "src1", name: "Hospital EHR", type: "postgres",
  settings: { host: "db.local", port: 5432, database: "ehr", user: "liveops_ro", encryption: "required", schemas: ["public"] },
  secrets_set: { password: true }, warnings: [], created_ts: 1791350000, updated_ts: 1791350000,
};

export const SITE = { id: "site1", name: "St Mary's", template: "hospital", layout: { zones: [] }, created_ts: 1791350000, updated_ts: 1791350000 };
