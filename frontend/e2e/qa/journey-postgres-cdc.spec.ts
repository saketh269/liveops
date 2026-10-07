// QA journey: PostgreSQL (live changes) source, from the connector picker to a live map that updates.
import { expect, test } from "@playwright/test";
import { assetTotal, createSite, env, sourceSql, shot, startMapping, tag } from "./helpers";

test("picker tells the two PostgreSQL types apart", async ({ page }) => {
  await page.goto("/sources/new");
  const poll = page.getByRole("button", { name: /^PostgreSQL(?! \(live)/ });
  const live = page.getByRole("button", { name: /^PostgreSQL \(live changes\)/ });
  await expect(poll).toHaveCount(1);
  await expect(live).toHaveCount(1);
  // Freshness badge and plain-words mode line differ
  await expect(poll).toContainText("Checks every few seconds");
  await expect(poll).not.toContainText("Live changes");
  await expect(live).toContainText("Live changes");
  await expect(live).toContainText("Streams each change as it is committed");
  // Live changes says what it needs from the admin
  await expect(live).toContainText(/wal_level=logical/);
  await expect(live).toContainText(/REPLICATION/);
  await expect(live).toContainText("Beta");
  await shot(page, "picker");
});

test("connect PostgreSQL (live changes), test, map, and see a change arrive on the live map", async ({ page, request }) => {
  const t = tag();
  const role = `qa_cdc_${t}`;
  const pw = `pw_${t}_${t}`;
  const pub = `qa_pub_${t}`;
  const table = `qa_cdc_beds_${t}`;
  sourceSql(`
    CREATE TABLE ${table} (bed_id text PRIMARY KEY, unit text, status text, bed_label text);
    INSERT INTO ${table} VALUES ('C1','ICU','occupied','Bed C1'),('C2','ICU','vacant','Bed C2'),('C3','Ward 4','vacant','Bed C3');
    CREATE ROLE ${role} LOGIN REPLICATION PASSWORD '${pw}';
    GRANT CONNECT ON DATABASE ${env("E2E_SOURCE_DB")} TO ${role};
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON ${table} TO ${role};
    CREATE PUBLICATION ${pub} FOR TABLE ${table};
  `);
  const siteName = `QA CDC ${t}`;
  const site = await createSite(request, siteName, [{ id: "icu", name: "ICU", polygon: [[2, 2], [30, 2], [30, 20], [2, 20]] }]);
  const name = `QA live ${t}`;
  try {
    // --- Picker -> form
    await page.goto("/sources/new");
    await page.getByRole("button", { name: /^PostgreSQL \(live changes\)/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Connect PostgreSQL (live changes)" })).toBeVisible();
    await expect(page.getByRole("note")).toContainText(/beta/i);
    await page.getByLabel(/^Name/).fill(name);
    await page.getByLabel(/^Host/).fill(env("E2E_SOURCE_HOST"));
    await page.getByLabel(/^Port/).fill(env("E2E_SOURCE_PORT"));
    await page.getByLabel(/^Database/).fill(env("E2E_SOURCE_DB"));
    await page.getByLabel(/^User with REPLICATION/).fill(role);
    await page.getByLabel(/^Publication/).fill(pub);
    await page.getByLabel(/^Password/).fill(pw);
    await page.getByRole("button", { name: "Save and test" }).click();

    // --- Test connection: every step green, with plain names
    await expect(page.getByText("Connection works.")).toBeVisible({ timeout: 30_000 });
    const steps = page.getByRole("list", { name: "Connection checks" }).getByRole("listitem");
    expect(await steps.count()).toBeGreaterThanOrEqual(3);
    for (const s of await steps.all()) {
      await expect(s).toContainText("✓");
      await expect(s).not.toContainText("✗");
    }
    const stepNames = (await steps.allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
    console.log(`[qa] postgres_cdc test steps: ${stepNames.join(" | ")}`);
    await shot(page, "cdc-test-connection");
    await expect(page.getByText(pw)).toHaveCount(0);

    // --- Mapping studio
    await startMapping(page, siteName, name, `public.${table}`);
    await expect(page.getByLabel(/^ID column/)).toHaveValue("bed_id");
    await expect(page.getByLabel(/^Zone$/)).toHaveValue("unit");
    await page.getByLabel("Show “occupied” as").fill("in_use");
    await page.getByLabel("Show “vacant” as").fill("free");
    await page.getByLabel(/^Kind/).fill("bed");
    // CDC: the poll interval is described as a fallback only
    await expect(page.locator("#m-poll-help")).toContainText("only used as a fallback");
    await page.getByRole("button", { name: "Save and start" }).click();
    await expect(page.getByText(/Mapping saved and started/)).toBeVisible();
    const health = async () => JSON.stringify(await (await request.get("/api/health/mappings")).json());
    await expect.poll(async () => {
      const h = (await (await request.get("/api/health/mappings")).json()) as { source_id: string; status: string; events_total: number }[];
      const srcs = await (await request.get("/api/sources")).json();
      const id = srcs.find((x: { name: string }) => x.name === name)?.id;
      const mine = h.find((x) => x.source_id === id);
      return mine ? `${mine.status}:${mine.events_total > 0}` : "missing";
    }, { timeout: 30_000, message: "mapping should be running with events" }).toBe("running:true")
      .catch(async (e) => { throw new Error(`${e.message}\nhealth: ${await health()}`); });

    // --- Live map: snapshot arrives, then a committed change shows up within seconds
    await page.goto(`/map/${site.id}`);
    await expect(page.getByRole("status").filter({ hasText: /^Live$/ })).toBeVisible({ timeout: 30_000 });
    await expect(assetTotal(page)).toHaveText("3 assets", { timeout: 30_000 });
    await expect(page.locator(".lm-kpi-value[data-state=in-use]")).toHaveText("1");
    await shot(page, "cdc-live-map-before");

    const started = Date.now();
    sourceSql(`UPDATE ${table} SET status = 'occupied' WHERE bed_id = 'C2'`);
    await expect(page.locator(".lm-kpi-value[data-state=in-use]")).toHaveText("2", { timeout: 15_000 });
    const latency = Date.now() - started;
    console.log(`[qa] postgres_cdc change -> live map: ${latency} ms`);
    await expect(page.locator(".lm-feed")).toContainText(/C2|Bed C2/);

    sourceSql(`INSERT INTO ${table} VALUES ('C4','ICU','vacant','Bed C4')`);
    await expect(assetTotal(page)).toHaveText("4 assets", { timeout: 15_000 });
    await expect(page.getByText("Bed C4").first()).toBeAttached();
    sourceSql(`DELETE FROM ${table} WHERE bed_id = 'C1'`);
    await expect(assetTotal(page)).toHaveText("3 assets", { timeout: 15_000 });
    await shot(page, "cdc-live-map-after");
  } finally {
    const maps = await (await request.get(`/api/mappings?site_id=${site.id}`)).json();
    for (const m of maps) await request.delete(`/api/mappings/${m.id}`);
    const srcs = await (await request.get("/api/sources")).json();
    for (const s of srcs.filter((x: { name: string }) => x.name === name)) await request.delete(`/api/sources/${s.id}`);
    await request.delete(`/api/sites/${site.id}`);
    // A leftover replication slot would stop run.mjs from dropping the source DB.
    for (let i = 0; i < 20; i++) {
      sourceSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
      sourceSql(`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = current_database() AND NOT active`);
      if (sourceSql(`SELECT count(*) FROM pg_replication_slots WHERE database = current_database()`) === "0") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    sourceSql(`DROP PUBLICATION IF EXISTS ${pub}; DROP TABLE IF EXISTS ${table}; DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
  }
});
