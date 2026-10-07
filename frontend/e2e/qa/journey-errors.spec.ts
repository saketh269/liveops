// QA journey: error states — server errors, losing the API mid-session, and a changed
// LIVEOPS_SECRET_KEY (409) using a second backend on the same portal DB.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createSource, env, pgSettings, shot, tag } from "./helpers";

test("server errors (500) read as plain words with a next step", async ({ page }) => {
  await page.route((u) => u.pathname.startsWith("/api/"), (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Internal Server Error" }) }));
  for (const path of ["/sources", "/sites", "/mapping", "/health"]) {
    await page.goto(path);
    const alert = page.getByRole("alert").first();
    await expect(alert, `${path} shows an alert`).toBeVisible({ timeout: 10_000 });
    const text = (await alert.innerText()).replace(/\s+/g, " ");
    console.log(`[qa] 500 on ${path}: ${text}`);
    expect(text, `${path} hint`).toMatch(/try again|backend logs/i);
    expect(text).not.toMatch(/undefined|\[object|Traceback/);
  }
  await shot(page, "errors-500-health");
});

test("Health keeps the last known state when the API goes away, and recovers", async ({ page }) => {
  await page.goto("/health");
  await expect(page.getByLabel("App health")).toContainText("Portal database: ok");
  let down = true;
  await page.route((u) => u.pathname.startsWith("/api/"), (r) => (down ? r.abort("connectionrefused") : r.fallback()));
  const alert = page.getByRole("alert").filter({ hasText: "Lost contact with the server; showing the last known state" });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText(/backend is running/);
  await expect(page.getByLabel("App health")).toBeVisible();
  await shot(page, "errors-health-lost-contact");
  down = false;
  await expect(alert).toHaveCount(0, { timeout: 15_000 });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

test.describe("after LIVEOPS_SECRET_KEY changes", () => {
  let other: ChildProcess | undefined;
  let otherUrl = "";
  let log = "";

  test.beforeAll(async () => {
    // Same portal DB as run.mjs (its name mirrors the source DB), different key, no runners.
    const portal = new URL(env("E2E_SOURCE_DSN"));
    portal.pathname = `/${env("E2E_SOURCE_DB").replace("_src_", "_portal_")}`;
    const port = await freePort();
    otherUrl = `http://127.0.0.1:${port}`;
    other = spawn("uvicorn", ["app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: join(process.cwd(), "..", "backend"),
      env: {
        ...process.env,
        LIVEOPS_DATABASE_URL: portal.toString().replace(/^postgres(ql)?:/, "postgresql+psycopg:"),
        LIVEOPS_SECRET_KEY: randomBytes(32).toString("base64url") + "=",
        LIVEOPS_START_RUNNERS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    other.stdout?.on("data", (d) => { log += d; });
    other.stderr?.on("data", (d) => { log += d; });
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${otherUrl}/api/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`second backend didn't start:\n${log.slice(-2000)}`);
  });
  test.afterAll(() => { other?.kill("SIGTERM"); });

  test("a source saved with the old key: readable 409 and a way to re-enter the password (LIVEOPS-91)", async ({ page, request }) => {
    const name = `QA key ${tag()}`;
    const src = await createSource(request, { name, type: "postgres", settings: pgSettings(), secrets: { password: env("E2E_RO_PASSWORD") } });
    try {
      // Browser talks to the backend with the new key
      await page.route((u) => u.pathname.startsWith("/api/"), async (r) => {
        const u = new URL(r.request().url());
        const resp = await r.fetch({ url: `${otherUrl}${u.pathname}${u.search}` });
        await r.fulfill({ response: resp });
      });
      const direct = await fetch(`${otherUrl}/api/sources/${src.id}`);
      console.log(`[qa] new-key backend GET /api/sources/{id}: ${direct.status} ${(await direct.text()).slice(0, 200)}`);
      const list = await fetch(`${otherUrl}/api/sources`);
      console.log(`[qa] new-key backend GET /api/sources: ${list.status}`);

      // Source list: either lists the sources or explains the key problem
      await page.goto("/sources");
      await page.waitForLoadState("networkidle");
      const listText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      console.log(`[qa] /sources after key change: ${listText.slice(0, 300)}`);
      await shot(page, "errors-409-sources");
      await expect(page.getByText(/LIVEOPS_SECRET_KEY|enter its password/).first()).toBeVisible();

      // The source page must let the user re-enter the password (the hint says to)
      await page.goto(`/sources/${src.id}`);
      await page.waitForLoadState("networkidle");
      await shot(page, "errors-409-source-page");
      const pageText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      console.log(`[qa] /sources/{id} after key change: ${pageText.slice(0, 300)}`);
      await expect(page.getByRole("form", { name: "Edit source" }), "edit form reachable to re-enter the password").toBeVisible({ timeout: 5_000 });
      await page.getByLabel(/^Password/).fill(env("E2E_RO_PASSWORD"));
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Changes saved.")).toBeVisible();
    } finally {
      await request.delete(`/api/sources/${src.id}`);
    }
  });
});
