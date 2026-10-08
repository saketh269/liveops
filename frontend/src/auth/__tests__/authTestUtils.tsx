import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../../App";
import type { AuthState, Me, Role } from "../../api/types";
import { mockApi } from "../../components/__tests__/mockApi";

export const STATE: AuthState = { setup_required: false, signup_open: false, sso: [] };

export function me(role: Role = "admin", extra: Partial<Me> = {}): Me {
  return { id: "u1", email: "ana@riverside.org", name: "Ana Diaz", role, org: { id: "o1", name: "Riverside General" }, email_verified: true, ...extra };
}

export const SIGNED_OUT = { detail: { message: "Sign in to continue." } };

/** Shows the router location so tests can assert redirects. */
function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

/** Renders the whole app at `path` with the given API routes (auth routes default to a signed-in admin). */
export function renderApp(path: string, routes: Record<string, unknown> = {}) {
  const api = mockApi({
    "GET /api/auth/state": STATE,
    "GET /api/auth/me": me(),
    // Pages behind the guard load these; keep them empty so tests stay focused.
    "GET /api/sources": [], "GET /api/sites": [], "GET /api/connectors": [], "GET /api/mappings": [],
    "GET /api/health": { status: "ok", version: "test", uptime_s: 1, mappings: { total: 0, running: 0, error: 0 } },
    "GET /api/health/mappings": [],
    ...routes,
  });
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Where />
    </MemoryRouter>,
  );
  return { api, ...view };
}

export function where(): string {
  return document.querySelector('[data-testid="where"]')?.textContent ?? "";
}
