// QA journey: CSV / Excel file source -> upload -> mapping -> live map.
// The source page has no upload control yet, so the upload step goes through the API
// (POST /api/sources/{id}/upload) and a separate test documents the missing UI.
import { expect, test, type Page } from "@playwright/test";
import { assetTotal, createSite, shot, startMapping, tag, zoneCount } from "./helpers";

const csv1 = "asset_id,area,state,label\nP1,Dock A,in_use,Pallet 1\nP2,Dock A,free,Pallet 2\nP3,Dock B,alert,Pallet 3\n";
const csv2 = "asset_id,area,state,label\nP1,Dock B,in_use,Pallet 1\nP2,Dock A,free,Pallet 2\nP3,Dock B,free,Pallet 3\nP4,Dock A,in_use,Pallet 4\n";

async function connectCsv(page: Page, name: string) {
  await page.goto("/sources/new");
  await page.getByRole("button", { name: /^CSV \/ Excel file/ }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  return page.url().split("/sources/")[1].split("?")[0];
}

test("CSV source: create, upload, map, and see a new file version on the live map", async ({ page, request }) => {
  const t = tag();
  const name = `QA CSV ${t}`;
  const siteName = `QA Yard ${t}`;
  const site = await createSite(request, siteName, [
    { id: "a", name: "Dock A", polygon: [[2, 2], [30, 2], [30, 20], [2, 20]] },
    { id: "b", name: "Dock B", polygon: [[32, 2], [60, 2], [60, 20], [32, 20]] },
  ]);
  try {
    const id = await connectCsv(page, name);
    // Test runs on save; with no file yet it must say so in plain words, not crash
    const panel = page.getByRole("region", { name: "Test connection" });
    await expect(panel.getByText(/Connection (works|needs attention)\./)).toBeVisible({ timeout: 20_000 });
    console.log(`[qa] csv test before upload: ${(await panel.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
    await shot(page, "csv-test-before-upload");

    const up = await request.post(`/api/sources/${id}/upload`, { multipart: { file: { name: "pallets.csv", mimeType: "text/csv", buffer: Buffer.from(csv1) } } });
    expect(up.status(), await up.text()).toBe(201);
    const dataset = (await up.json()).dataset as string;

    await page.reload();
    await page.getByRole("button", { name: /Test connection|Test again/ }).first().click();
    await expect(panel.getByText("Connection works.")).toBeVisible({ timeout: 20_000 });

    await startMapping(page, siteName, name, dataset);
    await expect(page.getByRole("region", { name: "Preview of records" }).getByRole("row")).toHaveCount(4);
    await page.getByLabel(/^ID column/).selectOption("asset_id");
    await expect(page.getByLabel(/^Zone$/)).toHaveValue("area");
    await expect(page.getByLabel(/^State$/)).toHaveValue("state");
    await expect(page.getByLabel(/^Label$/)).toHaveValue("label");
    await page.getByLabel(/^Kind/).fill("pallet");
    await page.getByLabel(/Check for changes every/).fill("1");
    await shot(page, "csv-mapping");
    await page.getByRole("button", { name: "Save and start" }).click();
    await expect(page.getByText(/Mapping saved and started/)).toBeVisible();

    await page.goto(`/map/${site.id}`);
    await expect(assetTotal(page)).toHaveText("3 assets", { timeout: 30_000 });
    await expect(zoneCount(page, "Dock A")).toHaveText("2");
    await expect(zoneCount(page, "Dock B")).toHaveText("1");
    await expect(page.locator(".lm-kpi-value[data-state=alert]")).toHaveText("1");

    // A new version of the same file updates the map on the next poll
    const up2 = await request.post(`/api/sources/${id}/upload`, { multipart: { file: { name: "pallets.csv", mimeType: "text/csv", buffer: Buffer.from(csv2) } } });
    expect(up2.status()).toBe(201);
    await expect(assetTotal(page)).toHaveText("4 assets", { timeout: 20_000 });
    await expect(zoneCount(page, "Dock B")).toHaveText("2");
    await expect(page.locator(".lm-kpi-value[data-state=alert]")).toHaveText("0");
    await shot(page, "csv-live-map");
  } finally {
    const maps = await (await request.get(`/api/mappings?site_id=${site.id}`)).json();
    for (const m of maps) await request.delete(`/api/mappings/${m.id}`);
    await request.delete(`/api/sites/${site.id}`);
  }
});

test("CSV source page lets the user upload a file (LIVEOPS-80)", async ({ page }) => {
  // Known gap: the UI has no file picker; uploads only work through the API.
  await connectCsv(page, `QA CSV UI ${tag()}`);
  await shot(page, "csv-source-page-no-upload");
  await expect(page.locator('input[type="file"]')).toHaveCount(1, { timeout: 3_000 });
});
