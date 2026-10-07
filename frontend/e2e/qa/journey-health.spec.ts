// QA journey: Health page shows an error with a hint when the source goes away (sessions
// terminated, SELECT revoked), and recovers when access comes back.
import { expect, test } from "@playwright/test";
import { createMapping, createSite, createSource, env, pgSettings, shot, sourceSql, tag } from "./helpers";

test("health: source access lost -> Error with hint; access restored -> Running", async ({ page, request }) => {
  test.setTimeout(240_000);
  const t = tag();
  const role = `qa_h_${t}`;
  const pw = `pw_${t}_${t}`;
  sourceSql(`
    CREATE ROLE ${role} LOGIN PASSWORD '${pw}';
    GRANT CONNECT ON DATABASE ${env("E2E_SOURCE_DB")} TO ${role};
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON beds TO ${role};
  `);
  const src = await createSource(request, { name: `QA health ${t}`, type: "postgres", settings: pgSettings({ user: role }), secrets: { password: pw } });
  const site = await createSite(request, `QA health site ${t}`);
  const m = await createMapping(request, {
    site_id: site.id, source_id: src.id, dataset: "public.beds",
    config: { id_field: "bed_id", fields: { zone: "unit", state: "status" }, state_map: {} },
    options: { poll_interval_s: 1 },
  });
  const row = page.getByRole("listitem", { name: "Health of public.beds" }).filter({ hasText: `QA health ${t}` });
  const pill = row.locator(".card-head .pill");
  try {
    await page.goto("/health");
    await expect(pill).toHaveText("Running", { timeout: 30_000 });

    // 1) Sessions terminated only: the mapping should reconnect by itself
    sourceSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
    const seen = new Set<string>();
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      seen.add((await pill.textContent()) ?? "");
      await page.waitForTimeout(1000);
    }
    console.log(`[qa] health after pg_terminate_backend: statuses seen ${[...seen].join(", ")}`);
    await expect(pill).toHaveText("Running", { timeout: 60_000 });

    // 2) SELECT revoked and sessions terminated: Error with message and hint
    sourceSql(`REVOKE SELECT ON beds FROM ${role}; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
    await expect(pill).toHaveText("Error", { timeout: 60_000 });
    const notice = row.locator(".notice");
    await expect(notice).toContainText(/isn.t readable|permission denied/i);
    const text = (await notice.innerText()).replace(/\s+/g, " ");
    console.log(`[qa] health error notice: ${text}`);
    // A hint beyond the error itself, telling the user what to do
    expect(text).toMatch(/grant|SELECT|read-only user|Test connection/i);
    await expect(row.getByRole("link", { name: "Test source" })).toHaveAttribute("href", `/sources/${src.id}`);
    await shot(page, "health-error");

    // Test connection on the source page agrees
    await page.goto(`/sources/${src.id}`);
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText(/Connection (works|needs attention)\./)).toBeVisible({ timeout: 30_000 });
    console.log(`[qa] test connection while revoked: ${(await page.getByRole("list", { name: "Connection checks" }).innerText()).replace(/\s+/g, " ")}`);
    await shot(page, "health-source-test-revoked");

    // 3) Restore access: back to Running, error kept as "Last error"
    sourceSql(`GRANT SELECT ON beds TO ${role}`);
    const restored = Date.now();
    await page.goto("/health");
    await expect(pill).toHaveText("Running", { timeout: 90_000 });
    console.log(`[qa] health recovery after GRANT: ${Date.now() - restored} ms`);
    await shot(page, "health-recovered");
  } finally {
    await request.delete(`/api/mappings/${m.id}`);
    await request.delete(`/api/sites/${site.id}`);
    await request.delete(`/api/sources/${src.id}`);
    sourceSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
    sourceSql(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
  }
});
