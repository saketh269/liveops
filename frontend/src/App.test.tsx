import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { mockApi } from "./components/__tests__/mockApi";

test("shell renders navigation in product order", async () => {
  mockApi({
    "GET /api/auth/state": { setup_required: false, signup_open: false, sso: [] },
    "GET /api/auth/me": { id: "u1", email: "ana@riverside.org", name: "Ana Diaz", role: "admin", org: { id: "o1", name: "Riverside" }, email_verified: true },
  });
  vi.stubGlobal("fetch", ((orig) => (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("/api/auth/") ? orig(input, init) : new Promise(() => {}))(globalThis.fetch));
  render(
    <MemoryRouter initialEntries={["/sources"]}>
      <App />
    </MemoryRouter>,
  );
  const nav = await screen.findByRole("navigation");
  const links = within(nav).getAllByRole("link").map((a) => a.textContent);
  expect(links).toEqual(["Sources", "Sites", "Mapping studio", "Live map", "Health"]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sources");
  vi.unstubAllGlobals();
});
