// QA journey: edit a source's host without the password -> clear "re-enter" message;
// re-enter -> saves and the connection works (LIVEOPS-24 rule).
import { expect, test } from "@playwright/test";
import { createSource, env, pgSettings, shot, tag } from "./helpers";

test("changing the host asks for the password again, then saves", async ({ page, request }) => {
  const name = `QA edit ${tag()}`;
  const src = await createSource(request, { name, type: "postgres", settings: pgSettings(), secrets: { password: env("E2E_RO_PASSWORD") } });
  expect(src.settings.host).toBe(env("E2E_SOURCE_HOST"));
  const newHost = env("E2E_SOURCE_HOST") === "localhost" ? "127.0.0.1" : "localhost";
  try {
    await page.goto(`/sources/${src.id}`);
    const form = page.getByRole("form", { name: "Edit source" });
    await expect(form.getByLabel(/^Host/)).toHaveValue(env("E2E_SOURCE_HOST"));
    // Before any change: password field says it's saved, no re-enter note
    await expect(form.getByRole("note")).toHaveCount(0);

    await form.getByLabel(/^Host/).fill(newHost);
    const note = form.getByRole("note");
    await expect(note).toContainText("Enter the password or token again.");
    await expect(note).toContainText("You changed the host");
    await expect(form.getByText("You changed the host, so enter this again.")).toBeVisible();
    // "Remove the saved password" makes no sense while re-entering: hidden
    await expect(form.getByLabel(/Remove the saved password/)).toHaveCount(0);
    await shot(page, "source-edit-reenter-note");

    // Save without the password: blocked with a field error, nothing stored
    await form.getByRole("button", { name: "Save changes" }).click();
    // Field error ("Password is required." or "Enter it again…") next to the re-enter help
    await expect(form.getByText(/Password is required\.|Enter it again to use the new address\./)).toBeVisible();
    await expect(form.getByText("You changed the host, so enter this again.")).toBeVisible();
    await expect(form.getByRole("alert")).toContainText(/highlighted field/);
    await expect(form.getByLabel(/^Password/)).toHaveAttribute("aria-invalid", "true");
    expect((await (await request.get(`/api/sources/${src.id}`)).json()).settings.host).toBe(env("E2E_SOURCE_HOST"));
    await shot(page, "source-edit-blocked");

    // The API enforces the same rule if the UI check is bypassed
    const raw = await request.put(`/api/sources/${src.id}`, { data: { settings: pgSettings({ host: newHost }) } });
    expect(raw.status()).toBe(422);
    expect((await raw.json()).detail.message).toMatch(/Re-enter the password/);

    // Changing the host back clears the note
    await form.getByLabel(/^Host/).fill(env("E2E_SOURCE_HOST"));
    await expect(form.getByRole("note")).toHaveCount(0);

    // Re-enter: saves, restarts the test, connection works on the new host
    await form.getByLabel(/^Host/).fill(newHost);
    await form.getByLabel(/^Password/).fill(env("E2E_RO_PASSWORD"));
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved.")).toBeVisible();
    await expect(page.getByText("Connection works.")).toBeVisible({ timeout: 30_000 });
    const after = await (await request.get(`/api/sources/${src.id}`)).json();
    expect(after.settings.host).toBe(newHost);
    expect(after.secrets_set.password).toBe(true);
    await expect(page.getByLabel(/^Password/)).toHaveValue("");
    await expect(page.getByText(env("E2E_RO_PASSWORD"))).toHaveCount(0);
    await shot(page, "source-edit-saved");

    // A non-endpoint change (name) keeps the saved password without asking
    await page.getByRole("form", { name: "Edit source" }).getByLabel(/^Name/).fill(`${name} renamed`);
    await expect(page.getByRole("form", { name: "Edit source" }).getByRole("note")).toHaveCount(0);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: `${name} renamed`, level: 1 })).toBeVisible();
    expect((await (await request.get(`/api/sources/${src.id}`)).json()).secrets_set.password).toBe(true);
  } finally {
    await request.delete(`/api/sources/${src.id}`);
  }
});
