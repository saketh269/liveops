// Shared helpers for the QA journeys in this folder. Run through `npm run test:e2e`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

export const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set. Run this through "npm run test:e2e".`);
  return v;
};

export const tag = () => randomBytes(3).toString("hex");

/** Runs SQL in the source DB as the admin user (Live Ops itself only reads). Returns psql -At output. */
export function sourceSql(sql: string): string {
  const r = spawnSync("psql", [env("E2E_SOURCE_DSN"), "-v", "ON_ERROR_STOP=1", "-q", "-At", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

export const pgSettings = (over: Record<string, unknown> = {}) => ({
  host: env("E2E_SOURCE_HOST"),
  port: Number(env("E2E_SOURCE_PORT")),
  database: env("E2E_SOURCE_DB"),
  user: env("E2E_RO_USER"),
  encryption: "required",
  ...over,
});

export async function createSource(request: APIRequestContext, body: Record<string, unknown>) {
  const r = await request.post("/api/sources", { data: body });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

export async function createSite(request: APIRequestContext, name: string, zones: unknown[] = []) {
  const r = await request.post("/api/sites", { data: { name, template: "hospital", layout: { zones } } });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

export async function createMapping(request: APIRequestContext, body: Record<string, unknown>) {
  const r = await request.post("/api/mappings", { data: body });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}

export const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

/** The "Assets" count of a zone row in the live map's "By zone" table. */
export const zoneCount = (page: Page, name: string) =>
  page.locator("table.lm-zone-table tbody tr")
    .filter({ has: page.getByRole("rowheader", { name, exact: true }) })
    .locator("td").first();

/** Total from the live map's Status panel ("N assets"). */
export const assetTotal = (page: Page) => page.locator("#lm-kpi-h .lm-total");

/** Picks a site, source and dataset in the Mapping studio (/mapping/new). */
export async function startMapping(page: Page, siteName: string, sourceName: string, dataset: string) {
  await page.goto("/mapping/new");
  await page.getByLabel("Show the assets on").selectOption({ label: siteName });
  await page.getByLabel("Read from").selectOption({ label: sourceName });
  await page.getByLabel("Table or dataset").selectOption({ value: dataset });
  await expect(page.getByRole("region", { name: "Preview of records" })).toBeVisible();
}
