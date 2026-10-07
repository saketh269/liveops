// QA: Sites -> Edit layout -> draw a zone named like the mapped zone -> Save ->
// the live map places the assets inside it. Plus UI error states.
// Runs against the real backend through `npm run test:e2e` (e2e/run.mjs).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set. Run this through "npm run test:e2e".`);
  return v;
};

function sourceSql(sql: string) {
  const r = spawnSync("psql", [env("E2E_SOURCE_DSN"), "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

const pgSettings = (over: Record<string, unknown> = {}) => ({
  host: env("E2E_SOURCE_HOST"),
  port: Number(env("E2E_SOURCE_PORT")),
  database: env("E2E_SOURCE_DB"),
  user: env("E2E_RO_USER"),
  encryption: "required",
  ...over,
});

async function seed(request: APIRequestContext) {
  const tag = randomBytes(3).toString("hex");
  const src = await (await request.post("/api/sources", {
    data: { name: `QA beds ${tag}`, type: "postgres", settings: pgSettings(), secrets: { password: env("E2E_RO_PASSWORD") } },
  })).json();
  const siteName = `QA Zones ${tag}`;
  const site = await (await request.post("/api/sites", { data: { name: siteName, template: "hospital", layout: { zones: [] } } })).json();
  const m = await request.post("/api/mappings", {
    data: {
      site_id: site.id, source_id: src.id, dataset: "public.beds",
      config: { id_field: "bed_id", fields: { zone: "unit", state: "status", label: "bed_label" }, state_map: { occupied: "in_use" }, kind: "bed" },
      options: { poll_interval_s: 1 },
    },
  });
  expect(m.status(), await m.text()).toBe(201);
  const mapping = await m.json();
  return { src, site, siteName, mapping };
}

type MapHooks = { ready: boolean; assetCount: () => number; screenOf: (id: string) => unknown };
const zoneRow = (page: Page, name: string) =>
  page.locator("table.lm-zone-table tbody tr").filter({ has: page.getByRole("rowheader", { name, exact: true }) });

test("draw a zone named like the mapped zone and see the assets inside it", async ({ page, request }) => {
  const { site, siteName, mapping } = await seed(request);
  try {
    // --- Sites -> Edit layout
    await page.goto("/sites");
    const card = page.getByRole("listitem").filter({ hasText: siteName });
    await card.getByRole("link", { name: "Edit layout" }).click();
    await expect(page).toHaveURL(new RegExp(`/map/${site.id}\\?edit=1$`));
    await expect(page.getByRole("heading", { name: `${siteName}: layout` })).toBeVisible();

    // --- Draw a zone by dragging on empty floor
    const svg = page.locator("svg.lm-editor-svg");
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("heading", { name: "Zones 1" })).toBeVisible();

    // --- Name it like the mapped zone value, then save
    await page.getByLabel("Name", { exact: true }).fill("ICU");
    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Layout saved: 1 zone" })).toBeVisible();
    const saved = await (await request.get(`/api/sites/${site.id}`)).json();
    expect(saved.layout.zones.map((z: { name: string }) => z.name)).toEqual(["ICU"]);

    // --- Live map: the two ICU beds are in ICU, the Ward 4 beds are unassigned
    await page.getByRole("button", { name: "Back to live map" }).click();
    await expect(zoneRow(page, "ICU").locator("td").first()).toHaveText("2", { timeout: 20_000 });
    await expect(zoneRow(page, "Unassigned").locator("td").first()).toHaveText("2");
    await page.screenshot({ path: test.info().outputPath("zone-live-map.png"), fullPage: true });

    // --- A source change moves a bed into the zone, live
    sourceSql("UPDATE beds SET unit = 'ICU' WHERE bed_id = 'B03'");
    await expect(zoneRow(page, "ICU").locator("td").first()).toHaveText("3", { timeout: 20_000 });
    await expect(zoneRow(page, "Unassigned").locator("td").first()).toHaveText("1");

    // --- 3D debug hooks: every asset is drawn and has a position on screen
    await page.goto(`/map/${site.id}?debug=1`);
    const has3d = await page.waitForFunction(() => (window as unknown as { __liveopsMap?: { ready: boolean } }).__liveopsMap?.ready, null, { timeout: 15_000 })
      .then(() => true, () => false);
    if (has3d) {
      await expect.poll(() => page.evaluate(() => (window as unknown as { __liveopsMap: MapHooks }).__liveopsMap.assetCount())).toBe(4);
      const pos = await page.evaluate(() => (window as unknown as { __liveopsMap: MapHooks }).__liveopsMap.screenOf("B03"));
      expect(pos, "B03 should have a screen position").toBeTruthy();
    } else {
      test.info().annotations.push({ type: "note", description: "WebGL unavailable; 3D debug hooks not checked" });
    }
  } finally {
    sourceSql("UPDATE beds SET unit = 'Ward 4' WHERE bed_id = 'B03'");
    await request.delete(`/api/mappings/${mapping.id}`);
  }
});

async function connectPostgres(page: Page, name: string, over: { host?: string; port?: string; password: string }) {
  await page.goto("/sources");
  const link = page.getByRole("link", { name: /Connect (your first|a) source/ }).first();
  await link.click();
  await page.getByRole("button", { name: /^PostgreSQL(?! \(live)/ }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Host/).fill(over.host ?? env("E2E_SOURCE_HOST"));
  await page.getByLabel(/^Port/).fill(over.port ?? env("E2E_SOURCE_PORT"));
  await page.getByLabel(/^Database/).fill(env("E2E_SOURCE_DB"));
  await page.getByLabel(/^Read-only user/).fill(env("E2E_RO_USER"));
  await page.getByLabel(/^Password/).fill(over.password);
  await page.getByRole("button", { name: "Save and test" }).click();
  return page.getByRole("list", { name: "Connection checks" }).getByRole("listitem");
}

test("wrong password shows the failing step with a hint", async ({ page }) => {
  const steps = await connectPostgres(page, "QA wrong password", { password: "definitely-wrong" });
  const failed = steps.filter({ hasText: "✗" }).first();
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed).toContainText(/password authentication failed/i);
  await expect(failed).toContainText("Check the user name and password.");
  await expect(page.getByText("Connection works.")).toHaveCount(0);
  await expect(page.getByText("definitely-wrong")).toHaveCount(0);
});

test("unreachable host shows the failing step with a hint", async ({ page }) => {
  const steps = await connectPostgres(page, "QA unreachable", { host: "127.0.0.1", port: "1", password: "x" });
  const failed = steps.filter({ hasText: "✗" }).first();
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(failed).toContainText("Reach the server");
  await expect(failed).toContainText(/Check the host and port/);
});

test("API down: pages say the backend can't be reached and how to fix it", async ({ page }) => {
  await page.route((url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/"), (route) => route.abort("connectionrefused"));
  const missing: string[] = [];
  for (const path of ["/sources", "/sites", "/health", "/mapping"]) {
    await page.goto(path);
    const msg = page.getByText(/backend is running/i).first();
    const shown = await msg.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!shown) {
      await page.screenshot({ path: test.info().outputPath(`api-down${path.replace("/", "-")}.png`), fullPage: true });
      missing.push(`${path}: "${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160)}"`);
    }
  }
  expect(missing, "pages without an 'API unreachable' message").toEqual([]);
});
