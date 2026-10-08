import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Reply } from "../../components/__tests__/mockApi";
import { passwordProblem, passwordStrength } from "../password";
import { me, renderApp, SIGNED_OUT, STATE, where } from "./authTestUtils";

afterEach(() => vi.unstubAllGlobals());

const open = { "GET /api/auth/me": new Reply(401, SIGNED_OUT), "GET /api/auth/state": { ...STATE, signup_open: true } };
const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("sign-up validates name, email, organisation, password rules and terms", async () => {
  const { api } = renderApp("/signup", open);
  await screen.findByRole("heading", { name: "Create your account" });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(screen.getByText("Enter your name.")).toBeTruthy();
  expect(screen.getByText("Enter your work email.")).toBeTruthy();
  expect(screen.getByText("Enter your organisation's name.")).toBeTruthy();
  expect(screen.getByText("Enter a password.")).toBeTruthy();
  expect(screen.getByText("Accept the terms to continue.")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText(/^Your name/));

  fill(/^Your name/, "Ana Diaz");
  fill(/^Work email/, "ana@riverside.org");
  fill(/^Organisation name/, "Riverside General");
  fill(/^Password/, "short");
  expect(screen.getByText("Strength: Too short or easy to guess")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(screen.getByText("Use at least 10 characters.")).toBeTruthy();
  fill(/^Password/, "ana@riverside.org");
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(screen.getByText("Don't use your email address as the password.")).toBeTruthy();
  expect(api.find("POST", "/api/auth/signup")).toHaveLength(0);
});

test("sign-up success says to check email, then continues into the app", async () => {
  const { api } = renderApp("/signup", { ...open, "POST /api/auth/signup": new Reply(201, me("admin", { email_verified: false })) });
  await screen.findByRole("heading", { name: "Create your account" });
  fill(/^Your name/, "Ana Diaz");
  fill(/^Work email/, "ana@riverside.org");
  fill(/^Organisation name/, "Riverside General");
  fill(/^Password/, "night shift coffee 42");
  fireEvent.click(screen.getByLabelText(/I accept the terms/));
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  const h = await screen.findByRole("heading", { name: "Check your email to verify" });
  expect(document.activeElement).toBe(h);
  expect(api.find("POST", "/api/auth/signup")[0].body).toEqual({
    org_name: "Riverside General", name: "Ana Diaz", email: "ana@riverside.org", password: "night shift coffee 42", accept_terms: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue to Live Ops" }));
  await waitFor(() => expect(where()).toBe("/sources"));
});

test("sign-up errors from the API are announced", async () => {
  renderApp("/signup", { ...open, "POST /api/auth/signup": new Reply(409, { detail: { message: "An account with that email already exists.", hint: "Sign in instead." } }) });
  await screen.findByRole("heading", { name: "Create your account" });
  fill(/^Your name/, "Ana Diaz");
  fill(/^Work email/, "ana@riverside.org");
  fill(/^Organisation name/, "Riverside General");
  fill(/^Password/, "night shift coffee 42");
  fireEvent.click(screen.getByLabelText(/I accept the terms/));
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await waitFor(() => expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("already exists"));
});

test("sign-up is closed unless an organisation allows it", async () => {
  renderApp("/signup", { "GET /api/auth/me": new Reply(401, SIGNED_OUT) });
  await screen.findByRole("heading", { name: "Sign-up is closed" });
  expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
});

test("setup creates the first admin and enters the app", async () => {
  const { api } = renderApp("/", { "GET /api/auth/state": { ...STATE, setup_required: true }, "POST /api/auth/setup": me() });
  await screen.findByRole("heading", { name: "Create your admin account" });
  expect(screen.queryByLabelText(/I accept the terms/)).toBeNull();
  fill(/^Your name/, "Ana Diaz");
  fill(/^Work email/, "ana@riverside.org");
  fill(/^Organisation name/, "Riverside General");
  fill(/^Password/, "night shift coffee 42");
  fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));
  await waitFor(() => expect(where()).toBe("/sources"));
  expect(api.find("POST", "/api/auth/setup")[0].body).toEqual({ org_name: "Riverside General", name: "Ana Diaz", email: "ana@riverside.org", password: "night shift coffee 42" });
});

test("password rules match the API and the meter grows with strength", () => {
  expect(passwordProblem("123456789")).toMatch(/10 characters/);
  expect(passwordProblem("Ana@Riverside.org", "ana@riverside.org")).toMatch(/email/);
  expect(passwordProblem("night shift coffee")).toBeNull();
  expect(passwordStrength("password1234").score).toBe(1);
  expect(passwordStrength("night shift coffee 42").score).toBeGreaterThanOrEqual(3);
  expect(passwordStrength("Night-Shift-Coffee-42!").score).toBe(4);
});
