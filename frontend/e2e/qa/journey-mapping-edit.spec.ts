// QA journey: edit a mapping created through the API with `fields.kind` and an identity
// state_map entry ({free: free}); saving without changes must keep everything (LIVEOPS-32).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createMapping, createSite, createSource, env, pgSettings, shot, sourceSql, tag } from "./helpers";

const t = tag();
const table = `qa_equipment_${t}`;
const config = {
  id_field: "eq_id",
  match_key: null,
  fields: { zone: "unit", state: "status", label: "eq_label", kind: "eq_kind" },
  state_map: { free: "free", busy: "in_use" },
  attributes: ["battery"],
  kind: null,
};

test.beforeAll(() => {
  sourceSql(`
    CREATE TABLE ${table} (eq_id text PRIMARY KEY, unit text, status text, eq_kind text, eq_label text, battery int);
    INSERT INTO ${table} VALUES ('E1','ICU','free','pump','Pump 1',80),('E2','ICU','busy','monitor','Monitor 2',55);
    GRANT SELECT ON ${table} TO ${env("E2E_RO_USER")};
  `);
});
test.afterAll(() => { sourceSql(`DROP TABLE IF EXISTS ${table}`); });

async function getMapping(request: APIRequestContext, siteId: string) {
  return (await (await request.get(`/api/mappings?site_id=${siteId}`)).json())[0];
}

async function seed(request: APIRequestContext) {
  const src = await createSource(request, { name: `QA equip ${t}`, type: "postgres", settings: pgSettings(), secrets: { password: env("E2E_RO_PASSWORD") } });
  const site = await createSite(request, `QA equip site ${tag()}`);
  const m = await createMapping(request, { site_id: site.id, source_id: src.id, dataset: `public.${table}`, config, options: { poll_interval_s: 2 } });
  expect(m.config.fields).toEqual(config.fields);
  expect(m.config.state_map).toEqual(config.state_map);
  return { src, site, m };
}

test("edit + save unchanged keeps fields.kind and state_map {free: free} (LIVEOPS-32)", async ({ page, request }) => {
  // Current behaviour (867e295): the save is refused, see LIVEOPS-32 comment.
  test.fail(true, "LIVEOPS-32: fields.kind is refused by the wizard and {free: free} is dropped");
  const { src, site, m } = await seed(request);
  try {
    await page.goto(`/mapping/${m.id}/edit`);
    await expect(page.getByRole("region", { name: "Preview of records" }).getByRole("row")).toHaveCount(3);
    await expect(page.getByLabel("Field name 1")).toHaveValue("kind");
    await expect(page.getByLabel("Column for field 1")).toHaveValue("eq_kind");
    await expect(page.getByLabel("Show “free” as")).toHaveValue("free");
    await page.getByRole("button", { name: "Save changes" }).click();
    await shot(page, "mapping-edit-save");
    await expect(page.getByText(/Mapping saved/)).toBeVisible({ timeout: 5_000 });
    const after = await getMapping(request, site.id);
    expect(after.config.fields).toEqual(config.fields);
    expect(after.config.state_map).toEqual(config.state_map);
    expect(after.config.attributes).toEqual(config.attributes);
  } finally {
    await request.delete(`/api/mappings/${m.id}`);
    await request.delete(`/api/sites/${site.id}`);
    await request.delete(`/api/sources/${src.id}`);
  }
});

test("current behaviour: what the edit screen does with fields.kind and {free: free}", async ({ page, request }) => {
  const { src, site, m } = await seed(request);
  try {
    await page.goto(`/mapping/${m.id}/edit`);
    await expect(page.getByRole("region", { name: "Preview of records" }).getByRole("row")).toHaveCount(3);
    const extraNames = await page.getByLabel(/^Field name \d+$/).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    const freeShown = await page.getByLabel("Show “free” as").inputValue().catch(() => "(no row)");
    await page.getByRole("button", { name: "Save changes" }).click();
    const saved = await page.getByText(/Mapping saved/).waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const alerts = (await page.getByRole("alert").allInnerTexts()).map((s) => s.replace(/\s+/g, " "));
    await shot(page, "mapping-edit-current");
    const after = await getMapping(request, site.id);
    console.log(`[qa] LIVEOPS-32 extra field rows=${JSON.stringify(extraNames)} free row="${freeShown}" saved=${saved} alerts=${JSON.stringify(alerts)}`);
    console.log(`[qa] LIVEOPS-32 stored after: fields=${JSON.stringify(after.config.fields)} state_map=${JSON.stringify(after.config.state_map)} kind=${after.config.kind}`);
    // Whatever happens, nothing may be silently dropped from the stored config.
    if (saved) {
      expect(after.config.fields).toEqual(config.fields);
      expect(after.config.state_map).toEqual(config.state_map);
    } else {
      expect(after.config).toEqual(m.config);
      // Workaround a user would try: remove the "kind" row and save again. The identity
      // translation {free: free} must still be kept.
      await page.getByRole("button", { name: "Remove field kind" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/Mapping saved/)).toBeVisible();
      const second = await getMapping(request, site.id);
      console.log(`[qa] LIVEOPS-32 after removing kind row: fields=${JSON.stringify(second.config.fields)} state_map=${JSON.stringify(second.config.state_map)}`);
      // Observed at 867e295: {free: free} is dropped (the wizard filters to !== raw). Covered by the
      // test.fail test above; logged here so the run shows the current behaviour.
      expect(second.config.state_map.busy).toBe("in_use");
      await shot(page, "mapping-edit-after-workaround");
    }
  } finally {
    await request.delete(`/api/mappings/${m.id}`);
    await request.delete(`/api/sites/${site.id}`);
    await request.delete(`/api/sources/${src.id}`);
  }
});
