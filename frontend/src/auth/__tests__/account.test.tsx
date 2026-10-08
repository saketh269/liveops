import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ApiToken, AuthSession } from "../../api/types";
import { Reply } from "../../components/__tests__/mockApi";
import { renderApp } from "./authTestUtils";

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date().toISOString();
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function routes() {
  let sessions: AuthSession[] = [
    { id: "s-cur", created_at: NOW, last_seen_at: NOW, user_agent: CHROME, ip: "10.0.0.5", current: true },
    { id: "s-ph", created_at: NOW, last_seen_at: NOW, user_agent: IPHONE, ip: "10.0.0.9", current: false },
    { id: "s-old", created_at: "2026-09-01T08:00:00Z", last_seen_at: "2026-09-02T08:00:00Z", user_agent: "python-httpx/0.27", ip: null, current: false },
  ];
  let tokens: ApiToken[] = [{ id: "t1", name: "Layout import", created_at: NOW, last_used_at: null }];
  return {
    "GET /api/auth/me/sessions": () => sessions,
    "DELETE /api/auth/me/sessions/s-ph": () => { sessions = sessions.filter((s) => s.id !== "s-ph"); return new Reply(204); },
    "DELETE /api/auth/me/sessions": () => { sessions = sessions.filter((s) => s.current); return new Reply(204); },
    "GET /api/auth/tokens": () => tokens,
    "POST /api/auth/tokens": (c: { body: { name: string } }) => {
      const t = { id: "t2", name: c.body.name, created_at: NOW, last_used_at: null };
      tokens = [...tokens, t];
      return new Reply(201, { ...t, token: "lo_plain_secret" });
    },
    "DELETE /api/auth/tokens/t1": () => { tokens = tokens.filter((t) => t.id !== "t1"); return new Reply(204); },
    "POST /api/auth/me/password": (c: { body: { current_password: string } }) =>
      c.body.current_password === "right-password" ? new Reply(204) : new Reply(400, { detail: { message: "Your current password isn't right." } }),
    "PATCH /api/auth/me": (c: { body: { name: string } }) => ({ id: "u1", email: "ana@riverside.org", name: c.body.name, role: "admin", org: { id: "o1", name: "Riverside General" }, email_verified: true }),
  };
}

test("sessions: sign out one device, then all other devices", async () => {
  const { api } = renderApp("/account", routes());
  const list = await screen.findByRole("list", { name: "Sessions" });
  const items = within(list).getAllByRole("listitem");
  expect(items[0].textContent).toContain("Chrome on macOS");
  expect(items[0].textContent).toContain("This device");
  expect(within(items[0]).queryByRole("button")).toBeNull();
  expect(items[1].textContent).toContain("Safari on iOS");
  fireEvent.click(within(items[1]).getByRole("button", { name: /^Sign out Safari on iOS/ }));
  await waitFor(() => expect(api.find("DELETE", "/api/auth/me/sessions/s-ph")).toHaveLength(1));
  await screen.findByText("Signed out of that device.");
  fireEvent.click(screen.getByRole("button", { name: "Sign out of all other devices" }));
  await screen.findByText("Signed out of all other devices.");
  expect(within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Sign out of all other devices" })).toBeNull();
});

test("change password: validation, wrong current password, success", async () => {
  const { api } = renderApp("/account", routes());
  const form = await screen.findByRole("form", { name: "Change password" });
  const q = within(form);
  fireEvent.click(q.getByRole("button", { name: "Change password" }));
  expect(q.getByText("Enter your current password.")).toBeTruthy();
  fireEvent.change(q.getByLabelText(/^Current password/), { target: { value: "wrong-password" } });
  fireEvent.change(q.getByLabelText(/^New password/), { target: { value: "wrong-password" } });
  fireEvent.click(q.getByRole("button", { name: "Change password" }));
  expect(q.getByText("Choose a password different from the current one.")).toBeTruthy();
  fireEvent.change(q.getByLabelText(/^New password/), { target: { value: "evening handover 19" } });
  fireEvent.click(q.getByRole("button", { name: "Change password" }));
  await waitFor(() => expect(q.getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("current password isn't right"));
  fireEvent.change(q.getByLabelText(/^Current password/), { target: { value: "right-password" } });
  fireEvent.click(q.getByRole("button", { name: "Change password" }));
  await q.findByText("Password changed. Your other devices were signed out.");
  expect(api.find("POST", "/api/auth/me/password")[1].body).toEqual({ current_password: "right-password", new_password: "evening handover 19" });
  expect((q.getByLabelText(/^Current password/) as HTMLInputElement).value).toBe("");
});

test("API tokens: create shows the token once with Copy; revoke asks first", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { api } = renderApp("/account", routes());
  const form = await screen.findByRole("form", { name: "Create an API token" });
  fireEvent.click(within(form).getByRole("button", { name: "Create token" }));
  expect(within(form).getByText(/Name the token/)).toBeTruthy();
  fireEvent.change(within(form).getByLabelText(/^Token name/), { target: { value: "Nightly import" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create token" }));
  const tokenBox = await screen.findByLabelText("New token “Nightly import”");
  expect((tokenBox as HTMLInputElement).value).toBe("lo_plain_secret");
  expect(screen.getByText(/shown only once/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await screen.findByText("Copied to the clipboard.");
  expect(writeText).toHaveBeenCalledWith("lo_plain_secret");
  fireEvent.click(screen.getByRole("button", { name: "Done, I've copied it" }));
  expect(screen.queryByText("lo_plain_secret")).toBeNull();
  expect(screen.queryByDisplayValue("lo_plain_secret")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Revoke Layout import" }));
  expect(api.find("DELETE", "/api/auth/tokens/t1")).toHaveLength(0);
  fireEvent.click(within(screen.getByRole("group", { name: "Confirm revoke Layout import" })).getByRole("button", { name: "Yes, revoke" }));
  await screen.findByText("Revoked “Layout import”.");
  expect(api.find("DELETE", "/api/auth/tokens/t1")).toHaveLength(1);
});

test("profile: rename updates the header", async () => {
  renderApp("/account", routes());
  const form = await screen.findByRole("form", { name: "Profile" });
  fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: "Ana D. Diaz" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save name" }));
  await within(form).findByText("Name saved.");
  expect(screen.getByRole("button", { name: "Ana D. Diaz, account menu" })).toBeTruthy();
});
