import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set. Run this through "npm run test:e2e".`);
  return v;
};

/** Changes a row in the source DB as the admin user (Live Ops itself only reads). */
function sourceSql(sql: string) {
  const r = spawnSync("psql", [env("E2E_SOURCE_DSN"), "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

test("connect Postgres, test it, create a site, map beds, and see it running on Health", async ({ page }) => {
  // --- Sources: empty state, then connect PostgreSQL
  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "No sources yet" })).toBeVisible();
  await page.getByRole("link", { name: "Connect your first source" }).click();
  await page.getByRole("button", { name: /^PostgreSQL(?! \(live)/ }).click();
  await page.getByLabel(/^Name/).fill("E2E hospital DB");
  await page.getByLabel(/^Host/).fill(env("E2E_SOURCE_HOST"));
  await page.getByLabel(/^Port/).fill(env("E2E_SOURCE_PORT"));
  await page.getByLabel(/^Database/).fill(env("E2E_SOURCE_DB"));
  await page.getByLabel(/^Read-only user/).fill(env("E2E_RO_USER"));
  await page.getByLabel(/^Password/).fill(env("E2E_RO_PASSWORD"));
  await expect(page.getByLabel(/^Encryption/)).toHaveValue("required");
  await page.getByRole("button", { name: "Save and test" }).click();

  // --- Test connection runs automatically after saving; every step green
  await expect(page.getByText("Connection works.")).toBeVisible();
  const steps = page.getByRole("list", { name: "Connection checks" }).getByRole("listitem");
  await expect(steps).toHaveCount(5);
  for (const step of await steps.all()) {
    await expect(step).toContainText("✓");
    await expect(step).not.toContainText("✗");
  }
  await expect(steps.filter({ hasText: "Encryption" })).toContainText("encrypted (TLS)");
  await expect(steps.filter({ hasText: "Read-only session" })).toContainText("on");
  await expect(steps.filter({ hasText: "List tables" })).toContainText("1 tables or views readable");

  await page.screenshot({ path: test.info().outputPath("test-connection.png"), fullPage: true });
  // Password is never shown again
  await expect(page.getByLabel(/^Password/)).toHaveValue("");

  // --- Sites: create a hospital site
  await page.getByRole("navigation").getByRole("link", { name: "Sites" }).click();
  await page.getByRole("button", { name: "Create your first site" }).click();
  await page.getByLabel(/^Site name/).fill("E2E General");
  await page.getByLabel("Template").selectOption("hospital");
  await page.getByRole("button", { name: "Create site" }).click();
  const siteCard = page.getByRole("listitem").filter({ hasText: "E2E General" });
  await expect(siteCard.getByRole("link", { name: "Edit layout" })).toHaveAttribute("href", /\/map\/.+\?edit=1$/);

  // --- Mapping studio: map beds
  await page.getByRole("navigation").getByRole("link", { name: "Mapping studio" }).click();
  await page.getByRole("link", { name: "New mapping" }).click();
  await expect(page.getByLabel("Show the assets on")).toHaveValue(/.+/);
  await expect(page.getByLabel("Read from")).toHaveValue(/.+/);
  await page.getByLabel("Table or dataset").selectOption("public.beds");
  const preview = page.getByRole("region", { name: "Preview of records" });
  await expect(preview.getByRole("row")).toHaveCount(5);
  await expect(page.getByLabel(/^ID column/)).toHaveValue("bed_id");
  await expect(page.getByLabel(/^State$/)).toHaveValue("status");
  await page.getByLabel("Show “occupied” as").fill("in_use");
  await page.getByLabel("Show “vacant” as").fill("free");
  await page.getByLabel(/^Kind/).fill("bed");
  await page.getByLabel("patient_count").check();
  await page.getByLabel(/Check for changes every/).fill("1");
  await page.screenshot({ path: test.info().outputPath("mapping-studio.png"), fullPage: true });
  await page.getByRole("button", { name: "Save and start" }).click();
  await expect(page.getByText(/Mapping saved and started/)).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Mapping public.beds" })).toBeVisible();

  // --- Health: running, with events from the initial snapshot
  await page.getByRole("link", { name: "Health", exact: true }).first().click();
  const row = page.getByRole("listitem", { name: "Health of public.beds" });
  await expect(row.locator(".pill")).toHaveText("Running", { timeout: 30_000 });
  const total = row.locator("dt", { hasText: "Events total" }).locator("xpath=following-sibling::dd");
  await expect.poll(async () => Number(await total.textContent()), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await expect(page.getByLabel("App health")).toContainText("Portal database: ok");
  await page.screenshot({ path: test.info().outputPath("health.png"), fullPage: true });

  // A change in the source shows up as a new event (poll every 1 s, page refresh every 5 s)
  const before = Number(await total.textContent());
  sourceSql("UPDATE beds SET status = 'vacant', patient_count = 0 WHERE bed_id = 'B01'");
  await expect.poll(async () => Number(await total.textContent()), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(row.locator("dt", { hasText: "Events / min" }).locator("xpath=following-sibling::dd")).not.toHaveText("0");
});

test("pages fit a 400 px wide screen without sideways scrolling, light and dark", async ({ page }, info) => {
  await page.setViewportSize({ width: 400, height: 800 });
  const paths = ["/sources", "/sources/new", "/sites", "/mapping", "/mapping/new", "/health"];
  for (const [i, path] of paths.entries()) {
    const scheme = i % 2 ? "dark" : "light";
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    // Saved for reviewers (see the results folder printed by run.mjs).
    await page.screenshot({ path: info.outputPath(`${path.replace(/\//g, "_")}-${scheme}.png`), fullPage: true });
  }
});
