import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/client";
import { Reply } from "../../components/__tests__/mockApi";
import { safeNext } from "../AuthProvider";
import { me, renderApp, SIGNED_OUT, STATE, where } from "./authTestUtils";

afterEach(() => vi.unstubAllGlobals());

test("signed-out visitors are sent to sign in with the page they wanted, and return there after", async () => {
  const { api } = renderApp("/sites?x=1", {
    "GET /api/auth/me": new Reply(401, SIGNED_OUT),
    "POST /api/auth/signin": me(),
  });
  await screen.findByRole("heading", { name: "Sign in" });
  expect(where()).toBe("/signin?next=%2Fsites%3Fx%3D1");
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ana@riverside.org" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Sites" });
  expect(where()).toBe("/sites?x=1");
  expect(api.find("POST", "/api/auth/signin")[0].body).toEqual({ email: "ana@riverside.org", password: "correct horse battery", remember: false });
});

test("a fresh install goes to setup: Create your admin account", async () => {
  const { api } = renderApp("/map", { "GET /api/auth/state": { ...STATE, setup_required: true } });
  await screen.findByRole("heading", { name: "Create your admin account" });
  expect(where()).toBe("/setup");
  expect(api.find("GET", "/api/auth/me")).toHaveLength(0);
});

test("setup is closed once accounts exist", async () => {
  renderApp("/setup", { "GET /api/auth/me": new Reply(401, SIGNED_OUT) });
  await screen.findByRole("heading", { name: "Sign in" });
  expect(where()).toBe("/signin");
});

test("a signed-in user opening /signin goes on to next", async () => {
  renderApp("/signin?next=%2Fhealth");
  await waitFor(() => expect(where()).toBe("/health"));
});

test("an API call that comes back 401 mid-session returns the user to sign in", async () => {
  renderApp("/sites", { "GET /api/sites": new Reply(401, SIGNED_OUT) });
  await screen.findByRole("heading", { name: "Sign in" });
  expect(where()).toBe("/signin?next=%2Fsites");
});

test("the auth state failing to load shows a retry, not a blank page", async () => {
  renderApp("/sources", { "GET /api/auth/state": new Reply(503, { detail: { message: "Live Ops is starting" } }) });
  await screen.findByRole("heading", { name: "Can't reach Live Ops" });
  expect(screen.getByText("Live Ops is starting")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("header menu: admins see My account, Users and Sign out; sign out ends the session", async () => {
  const { api } = renderApp("/sources", { "POST /api/auth/signout": new Reply(204) });
  const btn = await screen.findByRole("button", { name: /Ana Diaz, account menu/ });
  fireEvent.click(btn);
  const menu = screen.getByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["My account", "Users", "Sign out"]);
  expect(document.activeElement?.textContent).toBe("My account");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toBe("Users");
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(btn);
  fireEvent.click(btn);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(api.find("POST", "/api/auth/signout")).toHaveLength(1);
  expect(where()).toBe("/signin");
});

test("viewers: no Users menu item, no edit controls, edit pages and /admin/users redirect", async () => {
  renderApp("/sites", {
    "GET /api/auth/me": me("viewer"),
    "GET /api/sites": [{ id: "s1", name: "Riverside", template: "hospital", layout: { zones: [] }, created_ts: 0, updated_ts: 0 }],
  });
  await screen.findByText("Riverside");
  expect(screen.queryByRole("button", { name: "New site" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Edit layout" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete site" })).toBeNull();
  expect(screen.getByRole("link", { name: "Open live map" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /account menu/ }));
  expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Users" })).toBeNull();
});

test("viewers can't open edit routes", async () => {
  renderApp("/sources/new", { "GET /api/auth/me": me("viewer") });
  await waitFor(() => expect(where()).toBe("/sources"));
  expect(await screen.findByRole("heading", { name: "Sources" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Connect a source" })).toBeNull();
});

test("non-admins are sent away from /admin/users", async () => {
  renderApp("/admin/users", { "GET /api/auth/me": me("manager") });
  await waitFor(() => expect(where()).toBe("/sources"));
});

test("wallboards see only the live map", async () => {
  renderApp("/sources", { "GET /api/auth/me": me("wallboard") });
  await waitFor(() => expect(where()).toBe("/map"));
  const nav = screen.getByRole("navigation");
  expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Live map"]);
});

test("managers keep edit controls", async () => {
  renderApp("/sources", { "GET /api/auth/me": me("manager") });
  expect(await screen.findByRole("link", { name: "Connect a source" })).toBeTruthy();
});

test("safeNext only allows same-site paths and never an auth page", () => {
  expect(safeNext("/map/hs?floor=2")).toBe("/map/hs?floor=2");
  expect(safeNext("https://evil.example")).toBe("/");
  expect(safeNext("//evil.example/x")).toBe("/");
  expect(safeNext("/\\evil.example")).toBe("/");
  expect(safeNext("/signin?next=/x")).toBe("/");
  expect(safeNext(null)).toBe("/");
});

test("api client: same-origin credentials, X-CSRF-Token from the cookie on unsafe methods only", async () => {
  document.cookie = "liveops_csrf=tok%2B123; path=/";
  const { api: calls } = renderApp("/sources", { "PUT /api/sites/s1": { id: "s1" } });
  await screen.findByRole("heading", { name: "Sources" });
  await act(async () => { await api.updateSite("s1", { name: "x" }); });
  const put = calls.find("PUT", "/api/sites/s1")[0];
  expect(put.headers["x-csrf-token"]).toBe("tok+123");
  expect(put.credentials).toBe("same-origin");
  const get = calls.find("GET", "/api/sources")[0];
  expect(get.headers["x-csrf-token"]).toBeUndefined();
  expect(get.credentials).toBe("same-origin");
  document.cookie = "liveops_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});
