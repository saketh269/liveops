import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AccountUser } from "../../api/types";
import { Reply } from "../../components/__tests__/mockApi";
import { renderApp } from "./authTestUtils";

afterEach(() => vi.unstubAllGlobals());

const U = (id: string, name: string, role: AccountUser["role"], status: AccountUser["status"], last: string | null = null): AccountUser =>
  ({ id, name, email: `${name.split(" ")[0].toLowerCase()}@riverside.org`, role, status, last_sign_in_at: last, created_at: "2026-09-01T08:00:00Z" });

function routes() {
  let users = [U("u1", "Ana Diaz", "admin", "active", new Date().toISOString()), U("u2", "Ben Ode", "manager", "active"), U("u3", "Cy Park", "viewer", "invited")];
  return {
    "GET /api/users": () => users,
    "GET /api/org": { name: "Riverside General", signup_open: false },
    "PATCH /api/org": (c: { body: object }) => ({ name: "Riverside General", signup_open: false, ...c.body }),
    "PATCH /api/users/u1": () => new Reply(409, { detail: { message: "Riverside General needs at least one admin.", hint: "Make someone else an admin first." } }),
    "PATCH /api/users/u2": (c: { body: Partial<AccountUser> }) => {
      users = users.map((u) => (u.id === "u2" ? { ...u, ...c.body } : u));
      return users.find((u) => u.id === "u2");
    },
    "POST /api/users/u3/resend-invite": { invite_link: "https://liveops.example/invite?token=inv-3" },
    "POST /api/users/u2/reset-password": { reset_link: "https://liveops.example/reset?token=rst-2" },
    "POST /api/users": (c: { body: { email: string; name: string; role: AccountUser["role"]; mode: string } }) => {
      const u = { ...U("u4", c.body.name, c.body.role, c.body.mode === "invite" ? "invited" : "active"), email: c.body.email };
      users = [...users, u];
      return new Reply(201, { user: u, invite_link: c.body.mode === "invite" ? "https://liveops.example/invite?token=inv-4" : null });
    },
  };
}

const row = (name: string) => within(screen.getByRole("table")).getByText(name).closest("tr") as HTMLElement;

test("table lists name, email, role, status and last sign-in", async () => {
  renderApp("/admin/users", routes());
  await screen.findByText("Ben Ode");
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(headers).toEqual(["Name", "Email", "Role", "Status", "Last sign-in", "Actions"]);
  const ana = row("Ana Diaz");
  expect(ana.textContent).toContain("(you)");
  expect(ana.textContent).toContain("ana@riverside.org");
  expect(ana.textContent).toContain("just now");
  expect(within(ana).queryByRole("button", { name: /Deactivate/ })).toBeNull(); // can't lock yourself out
  expect(row("Cy Park").textContent).toContain("Invited");
  expect(row("Ben Ode").textContent).toContain("Never");
});

test("can't demote the last admin: the API's message is shown on that row", async () => {
  renderApp("/admin/users", routes());
  await screen.findByText("Ben Ode");
  fireEvent.change(screen.getByLabelText("Role for Ana Diaz"), { target: { value: "viewer" } });
  await screen.findByText("Riverside General needs at least one admin.");
  expect(screen.getByText("Make someone else an admin first.")).toBeTruthy();
  expect((screen.getByLabelText("Role for Ana Diaz") as HTMLSelectElement).value).toBe("admin");
});

test("change role, deactivate and reactivate", async () => {
  const { api } = renderApp("/admin/users", routes());
  await screen.findByText("Ben Ode");
  fireEvent.change(screen.getByLabelText("Role for Ben Ode"), { target: { value: "viewer" } });
  await waitFor(() => expect(api.find("PATCH", "/api/users/u2")[0]?.body).toEqual({ role: "viewer" }));
  await screen.findByText("Ben Ode: Viewer, Active.");
  fireEvent.click(screen.getByRole("button", { name: "Deactivate Ben Ode" }));
  await screen.findByRole("button", { name: "Reactivate Ben Ode" });
  expect(row("Ben Ode").textContent).toContain("Deactivated");
  fireEvent.click(screen.getByRole("button", { name: "Reactivate Ben Ode" }));
  await screen.findByRole("button", { name: "Deactivate Ben Ode" });
  expect(api.find("PATCH", "/api/users/u2").map((c) => c.body)).toEqual([{ role: "viewer" }, { status: "disabled" }, { status: "active" }]);
});

test("resend invite and reset password show copyable links", async () => {
  renderApp("/admin/users", routes());
  await screen.findByText("Ben Ode");
  expect(screen.queryByRole("button", { name: "Resend invite to Ben Ode" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resend invite to Cy Park" }));
  expect(((await screen.findByLabelText("New invitation link for Cy Park")) as HTMLInputElement).value).toBe("https://liveops.example/invite?token=inv-3");
  fireEvent.click(screen.getByRole("button", { name: "Reset password for Ben Ode" }));
  expect(((await screen.findByLabelText("Password reset link for Ben Ode")) as HTMLInputElement).value).toBe("https://liveops.example/reset?token=rst-2");
});

test("add user by invite: validates, then shows the invite link to copy; focus returns to Add user", async () => {
  const { api } = renderApp("/admin/users", routes());
  await screen.findByText("Ben Ode");
  const add = screen.getByRole("button", { name: "Add user" });
  add.focus();
  fireEvent.click(add);
  const dialog = screen.getByRole("dialog", { name: "Add user" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const q = within(dialog);
  fireEvent.click(q.getByRole("button", { name: "Send invite" }));
  expect(q.getByText("Enter their name.")).toBeTruthy();
  fireEvent.change(q.getByLabelText(/^Name/), { target: { value: "Dee Rao" } });
  fireEvent.change(q.getByLabelText(/^Email/), { target: { value: "dee@riverside.org" } });
  fireEvent.change(q.getByLabelText("Role"), { target: { value: "manager" } });
  fireEvent.click(q.getByRole("button", { name: "Send invite" }));
  const done = await screen.findByRole("dialog", { name: "Dee Rao added" });
  expect(((within(done).getByLabelText("Invitation link")) as HTMLInputElement).value).toBe("https://liveops.example/invite?token=inv-4");
  expect(api.find("POST", "/api/users")[0].body).toEqual({ email: "dee@riverside.org", name: "Dee Rao", role: "manager", mode: "invite" });
  fireEvent.click(within(done).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add user" }));
  expect(screen.getByText("Dee Rao")).toBeTruthy();
});

test("add user with a password checks the password rules; Escape closes", async () => {
  const { api } = renderApp("/admin/users", routes());
  await screen.findByText("Ben Ode");
  fireEvent.click(screen.getByRole("button", { name: "Add user" }));
  const q = within(screen.getByRole("dialog", { name: "Add user" }));
  fireEvent.click(q.getByLabelText("Set a password"));
  fireEvent.change(q.getByLabelText(/^Name/), { target: { value: "Wall One" } });
  fireEvent.change(q.getByLabelText(/^Email/), { target: { value: "wall@riverside.org" } });
  fireEvent.change(q.getByLabelText(/^Password/), { target: { value: "short" } });
  fireEvent.click(q.getByRole("button", { name: "Add user" }));
  expect(q.getByText("Use at least 10 characters.")).toBeTruthy();
  expect(api.find("POST", "/api/users")).toHaveLength(0);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("organisation settings: rename and allow public sign-up", async () => {
  const { api } = renderApp("/admin/users", routes());
  const form = await screen.findByRole("form", { name: "Organisation settings" });
  fireEvent.click(within(form).getByLabelText(/Allow public sign-up/));
  fireEvent.click(within(form).getByRole("button", { name: "Save settings" }));
  await within(form).findByText("Organisation settings saved.");
  expect(api.find("PATCH", "/api/org")[0].body).toEqual({ name: "Riverside General", signup_open: true });
});
