// QA journey: REST API source with query parameters against a small local JSON server
// (LIVEOPS-20 regression: `query` must be saved as an object and actually sent).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { assetTotal, createSite, shot, startMapping, tag } from "./helpers";

type Bed = { id: string; ward: string; status: string; name: string };
const beds: Bed[] = [
  { id: "R1", ward: "ICU", status: "occupied", name: "REST bed 1" },
  { id: "R2", ward: "ICU", status: "free", name: "REST bed 2" },
];
let server: Server;
let base = "";
const seen: string[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push(url.pathname + url.search);
    if (url.pathname !== "/v1/beds") { res.writeHead(404).end(); return; }
    // Only answer with records when the query parameters arrive as name=value pairs.
    const ok = url.searchParams.get("site") === "general" && url.searchParams.get("active") === "true";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { items: ok ? beds : [] } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("REST source with query parameters: saved as an object, tested, mapped, and live", async ({ page, request }) => {
  const t = tag();
  const name = `QA REST ${t}`;
  const siteName = `QA REST site ${t}`;
  const site = await createSite(request, siteName, [{ id: "icu", name: "ICU", polygon: [[2, 2], [30, 2], [30, 20], [2, 20]] }]);
  try {
    await page.goto("/sources/new");
    await page.getByRole("button", { name: /^REST API/ }).click();
    await page.getByLabel(/^Name/).fill(name);
    await page.getByLabel(/^Base URL/).fill(base);
    await page.getByLabel(/^Path/).fill("/v1/beds");
    await page.getByRole("button", { name: "Add query parameter" }).click();
    await page.getByLabel("Query parameters: name 1").fill("site");
    await page.getByLabel("Query parameters: value 1").fill("general");
    await page.getByRole("button", { name: "Add query parameter" }).click();
    await page.getByLabel("Query parameters: name 2").fill("active");
    await page.getByLabel("Query parameters: value 2").fill("true");
    await page.getByLabel(/^Where the records are/).fill("data.items");
    await page.getByLabel(/^Dataset name/).fill("beds");
    await page.getByLabel(/^Allow plain HTTP/).check();
    await page.getByLabel(/^Allow private network addresses/).check();
    await page.getByRole("button", { name: "Save and test" }).click();

    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(page.getByText("Connection works.")).toBeVisible({ timeout: 30_000 });
    await shot(page, "rest-test-connection");

    // Stored as an object, and the server saw name=value pairs (not "[object Object]")
    const src = (await (await request.get("/api/sources")).json()).find((x: { name: string }) => x.name === name);
    expect(src.settings.query).toEqual({ site: "general", active: "true" });
    expect(seen.some((s) => s.includes("site=general") && s.includes("active=true"))).toBe(true);
    expect(seen.some((s) => /object/i.test(decodeURIComponent(s)))).toBe(false);

    // Edit page shows the rows; saving unchanged keeps the object
    await expect(page.getByLabel("Query parameters: name 2")).toHaveValue("active");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved.")).toBeVisible();
    const again = await (await request.get(`/api/sources/${src.id}`)).json();
    expect(again.settings.query).toEqual({ site: "general", active: "true" });

    // Mapping -> live map
    await startMapping(page, siteName, name, "beds");
    await expect(page.getByRole("region", { name: "Preview of records" }).getByRole("row")).toHaveCount(3);
    await page.getByLabel(/^ID column/).selectOption("id");
    await page.getByLabel(/^Zone$/).selectOption("ward");
    await page.getByLabel(/^State$/).selectOption("status");
    await page.getByLabel("Show “occupied” as").fill("in_use");
    await page.getByLabel(/Check for changes every/).fill("1");
    await page.getByRole("button", { name: "Save and start" }).click();
    await expect(page.getByText(/Mapping saved and started/)).toBeVisible();

    await page.goto(`/map/${site.id}`);
    await expect(assetTotal(page)).toHaveText("2 assets", { timeout: 30_000 });
    beds.push({ id: "R3", ward: "ICU", status: "occupied", name: "REST bed 3" });
    await expect(assetTotal(page)).toHaveText("3 assets", { timeout: 20_000 });
    await expect(page.locator(".lm-kpi-value[data-state=in-use]")).toHaveText("2");
    await shot(page, "rest-live-map");
  } finally {
    const maps = await (await request.get(`/api/mappings?site_id=${site.id}`)).json();
    for (const m of maps) await request.delete(`/api/mappings/${m.id}`);
    await request.delete(`/api/sites/${site.id}`);
  }
});
