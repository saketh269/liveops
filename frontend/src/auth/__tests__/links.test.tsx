import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Reply } from "../../components/__tests__/mockApi";
import { me, renderApp, SIGNED_OUT, where } from "./authTestUtils";

afterEach(() => vi.unstubAllGlobals());

const signedOut = { "GET /api/auth/me": new Reply(401, SIGNED_OUT) };
const alert = () => screen.getAllByRole("alert").map((a) => a.textContent).join(" ");

test("forgot password always confirms the same way", async () => {
  const { api } = renderApp("/forgot", { ...signedOut, "POST /api/auth/forgot": new Reply(204) });
  await screen.findByRole("heading", { name: "Reset your password" });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
  expect(screen.getByText("Enter your email address.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "nobody@riverside.org" } });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
  await screen.findByRole("heading", { name: "Check your email" });
  expect(screen.getByText(/If there's a Live Ops account for/)).toBeTruthy();
  expect(api.find("POST", "/api/auth/forgot")[0].body).toEqual({ email: "nobody@riverside.org" });
});

test("reset: validates, saves, then asks to sign in with the new password", async () => {
  const { api } = renderApp("/reset?token=abc", { ...signedOut, "POST /api/auth/reset": new Reply(204) });
  await screen.findByRole("heading", { name: "Choose a new password" });
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
  expect(screen.getByText("Use at least 10 characters.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: "a much longer one" } });
  fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
  await screen.findByText("Your password was changed. Sign in with the new one.");
  expect(where()).toBe("/signin?reason=reset");
  expect(api.find("POST", "/api/auth/reset")[0].body).toEqual({ token: "abc", password: "a much longer one" });
});

test("reset: an expired link explains what to do", async () => {
  renderApp("/reset?token=old", { ...signedOut, "POST /api/auth/reset": new Reply(400, { detail: { message: "This link has expired." } }) });
  await screen.findByRole("heading", { name: "Choose a new password" });
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: "a much longer one" } });
  fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
  await waitFor(() => expect(alert()).toContain("This link has expired."));
  expect(alert()).toContain("Forgot password?");
});

test("a link without its token says so", async () => {
  renderApp("/invite", signedOut);
  await screen.findByRole("heading", { name: "This link is incomplete" });
});

test("verify posts the token once and confirms", async () => {
  const { api } = renderApp("/verify?token=v1", { ...signedOut, "POST /api/auth/verify": new Reply(204) });
  await screen.findByRole("heading", { name: "Email verified" });
  expect(api.find("POST", "/api/auth/verify")).toEqual([expect.objectContaining({ body: { token: "v1" } })]);
  expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
});

test("verify failure is explained", async () => {
  renderApp("/verify?token=bad", { ...signedOut, "POST /api/auth/verify": new Reply(400, { detail: { message: "This link was already used." } }) });
  await screen.findByRole("heading", { name: "We couldn't verify your email" });
  expect(alert()).toContain("already used");
});

test("invite accept: validates, signs in and opens the app", async () => {
  const { api } = renderApp("/invite?token=inv", { ...signedOut, "POST /api/auth/invite/accept": me("viewer", { name: "Sam Lee" }) });
  await screen.findByRole("heading", { name: "Join Live Ops" });
  fireEvent.click(screen.getByRole("button", { name: "Join and sign in" }));
  expect(screen.getByText("Enter your name.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^Your name/), { target: { value: "Sam Lee" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "ward round 0700" } });
  fireEvent.click(screen.getByRole("button", { name: "Join and sign in" }));
  await waitFor(() => expect(where()).toBe("/map"));
  expect(api.find("POST", "/api/auth/invite/accept")[0].body).toEqual({ token: "inv", name: "Sam Lee", password: "ward round 0700" });
});
