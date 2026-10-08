import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Reply } from "../../components/__tests__/mockApi";
import { me, renderApp, SIGNED_OUT, STATE, where } from "./authTestUtils";

afterEach(() => vi.unstubAllGlobals());

const signedOut = { "GET /api/auth/me": new Reply(401, SIGNED_OUT) };
const alert = () => screen.getAllByRole("alert").map((a) => a.textContent).join(" ");

test("validates before sending, and focuses the first problem", async () => {
  const { api } = renderApp("/signin", signedOut);
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByText("Enter your email address.")).toBeTruthy();
  expect(screen.getByText("Enter your password.")).toBeTruthy();
  const email = screen.getByLabelText(/^Email/);
  expect(document.activeElement).toBe(email);
  expect(email.getAttribute("aria-invalid")).toBe("true");
  expect(email.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.change(email, { target: { value: "ana" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByText(/Enter a full email address/)).toBeTruthy();
  expect(api.find("POST", "/api/auth/signin")).toHaveLength(0);
});

test("401 shows one generic message that doesn't reveal whether the email exists", async () => {
  renderApp("/signin", { ...signedOut, "POST /api/auth/signin": new Reply(401, { detail: { message: "Invalid credentials" } }) });
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "who@riverside.org" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "wrong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(alert()).toContain("That email and password don't match"));
  expect(where()).toBe("/signin"); // no redirect loop on the auth page itself
});

test("423 says the account is locked and how long to wait", async () => {
  renderApp("/signin", {
    ...signedOut,
    "POST /api/auth/signin": new Reply(423, { detail: { message: "Account locked" } }, { "Retry-After": "840" }),
  });
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ana@riverside.org" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(alert()).toContain("This account is locked"));
  expect(alert()).toContain("about 14 minutes");
});

test("show/hide password, remember me, and the Forgot password link", async () => {
  const { api } = renderApp("/signin", { ...signedOut, "POST /api/auth/signin": me() });
  await screen.findByRole("heading", { name: "Sign in" });
  const pw = screen.getByLabelText(/^Password/) as HTMLInputElement;
  expect(pw.type).toBe("password");
  const toggle = screen.getByRole("button", { name: "Show password" });
  fireEvent.click(toggle);
  expect(pw.type).toBe("text");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("link", { name: "Forgot password?" }).getAttribute("href")).toBe("/forgot");
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: " Ana@Riverside.org " } });
  fireEvent.change(pw, { target: { value: "secret-secret" } });
  fireEvent.click(screen.getByLabelText(/Keep me signed in/));
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.find("POST", "/api/auth/signin")[0]?.body).toEqual({ email: "Ana@Riverside.org", password: "secret-secret", remember: true }));
  await waitFor(() => expect(where()).toBe("/sources"));
});

test("no SSO buttons or Create an account link unless the install offers them", async () => {
  renderApp("/signin", signedOut);
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByText(/Continue with/)).toBeNull();
  expect(screen.queryByRole("link", { name: "Create an account" })).toBeNull();
});

test("SSO providers and open sign-up appear when the state lists them", async () => {
  renderApp("/signin?next=%2Fmap", {
    ...signedOut,
    "GET /api/auth/state": { ...STATE, signup_open: true, sso: ["google", { id: "entra", name: "Microsoft Entra ID", url: "/api/auth/sso/entra/start" }] },
  });
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.getByRole("link", { name: "Continue with Google" }).getAttribute("href")).toBe("/api/auth/sso/google?next=%2Fmap");
  expect(screen.getByRole("link", { name: "Continue with Microsoft Entra ID" }).getAttribute("href")).toBe("/api/auth/sso/entra/start?next=%2Fmap");
  expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe("/signup");
});
