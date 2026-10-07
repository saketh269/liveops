// QA journey: layout editor — draw, rename, move, delete zones, save, reload; and the same
// with the keyboard only.
import { expect, test, type Page } from "@playwright/test";
import { createSite, shot, tag } from "./helpers";

type Z = { id: string; name: string; polygon: [number, number][] };
const minX = (z: Z) => Math.min(...z.polygon.map((p) => p[0]));
const minY = (z: Z) => Math.min(...z.polygon.map((p) => p[1]));

async function dragOnFloor(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator("svg.lm-editor-svg").boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 10 });
  await page.mouse.up();
}

test("draw, rename, move, delete zones with the mouse; save; reload keeps them", async ({ page, request }) => {
  const site = await createSite(request, `QA Layout ${tag()}`);
  try {
    await page.goto(`/map/${site.id}?edit=1`);
    await expect(page.getByRole("heading", { level: 1, name: /: layout$/ })).toBeVisible();
    await expect(page.getByText("No zones yet. Draw one on the floor or use Add zone.")).toBeVisible();

    // Draw zone 1 and name it
    await dragOnFloor(page, [0.05, 0.1], [0.35, 0.45]);
    await expect(page.getByRole("heading", { name: "Zones 1" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("North wing");
    await expect(page.getByRole("button", { name: "Zone North wing" })).toBeVisible();

    // Add zone 2 with the button, rename
    await page.getByRole("button", { name: "Add zone" }).click();
    await expect(page.getByRole("heading", { name: "Zones 2" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("South wing");

    // Draw zone 3, then delete it with the Delete zone button
    await dragOnFloor(page, [0.7, 0.6], [0.95, 0.95]);
    await expect(page.getByRole("heading", { name: "Zones 3" })).toBeVisible();
    await page.getByRole("button", { name: "Delete zone" }).click();
    await expect(page.getByRole("heading", { name: "Zones 2" })).toBeVisible();

    // Move North wing by dragging it
    await page.getByRole("button", { name: /^North wing/ }).click();
    const x0 = Number(await page.getByLabel("X", { exact: true }).inputValue());
    const north = (await page.getByRole("button", { name: "Zone North wing" }).boundingBox())!;
    await page.mouse.move(north.x + north.width / 2, north.y + north.height / 2);
    await page.mouse.down();
    await page.mouse.move(north.x + north.width / 2 + 60, north.y + north.height / 2 + 10, { steps: 10 });
    await page.mouse.up();
    const x1 = Number(await page.getByLabel("X", { exact: true }).inputValue());
    expect(x1).toBeGreaterThan(x0);

    // Duplicate names are refused with a clear message, nothing saved
    await page.getByLabel("Name", { exact: true }).fill("South wing");
    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.getByRole("alert")).toContainText(/2 zones are named "south wing"/i);
    await page.getByLabel("Name", { exact: true }).fill("North wing");

    // Cancel with unsaved changes asks first; dismissing keeps the editor open
    page.once("dialog", (d) => { expect(d.message()).toMatch(/Discard/); void d.dismiss(); });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Save layout" })).toBeVisible();

    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Layout saved: 2 zones" })).toBeVisible();
    await shot(page, "layout-mouse-saved");

    const saved = (await (await request.get(`/api/sites/${site.id}`)).json()).layout.zones as Z[];
    expect(saved.map((z) => z.name).sort()).toEqual(["North wing", "South wing"]);
    expect(minX(saved.find((z) => z.name === "North wing")!)).toBeCloseTo(x1, 0);

    // Reload: the editor shows the saved zones
    await page.reload();
    await expect(page.getByRole("heading", { name: "Zones 2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zone North wing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zone South wing" })).toBeVisible();
    // Back to live map lists them in the By zone table
    await page.getByRole("button", { name: "Back to live map" }).click();
    await expect(page.locator("table.lm-zone-table")).toContainText("North wing");
    await expect(page.locator("table.lm-zone-table")).toContainText("South wing");
  } finally {
    await request.delete(`/api/sites/${site.id}`);
  }
});

/** What has focus, in words: role/tag + accessible-ish name. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return "body";
  const name = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? "";
  return `${el.getAttribute("role") ?? el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${name.replace(/\s+/g, " ").trim().slice(0, 40)}"`;
});

async function tabTo(page: Page, want: RegExp, opts: { back?: boolean; max?: number; log?: string[] } = {}) {
  for (let i = 0; i < (opts.max ?? 40); i++) {
    await page.keyboard.press(opts.back ? "Shift+Tab" : "Tab");
    const f = await focused(page);
    opts.log?.push(f);
    if (want.test(f)) return f;
  }
  throw new Error(`Never reached ${want} with ${opts.back ? "Shift+Tab" : "Tab"}; last: ${opts.log?.slice(-5).join(" > ")}`);
}

test("layout editor works with the keyboard only", async ({ page, request }) => {
  const site = await createSite(request, `QA Keys ${tag()}`);
  try {
    await page.goto(`/map/${site.id}?edit=1`);
    await expect(page.getByRole("heading", { level: 1, name: /: layout$/ })).toBeVisible();
    const order: string[] = [];

    // Add a zone
    await tabTo(page, /"Add zone"/, { log: order });
    console.log(`[qa] layout focus order to Add zone: ${order.join(" > ")}`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Zones 1" })).toBeVisible();

    // Rename it
    await tabTo(page, /#lm-zname/);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Keyboard ward");
    await expect(page.getByRole("button", { name: "Zone Keyboard ward" })).toBeVisible();

    // Move it with arrow keys: Shift+Tab back to the zone on the floor
    const x0 = Number(await page.locator("#lm-zx").inputValue());
    const y0 = Number(await page.locator("#lm-zy").inputValue());
    await tabTo(page, /"Zone Keyboard ward"/, { back: true });
    const ring = await page.evaluate(() => {
      const el = document.activeElement as SVGElement;
      const cs = getComputedStyle(el);
      return { stroke: cs.stroke, width: cs.strokeWidth, outline: cs.outlineStyle };
    });
    console.log(`[qa] focused zone style: ${JSON.stringify(ring)}`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator("#lm-zx")).toHaveValue(String(x0 + 2));
    await expect(page.locator("#lm-zy")).toHaveValue(String(y0 + 5));

    // Add a second zone and delete it with the Delete key
    await tabTo(page, /"Add zone"/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Zones 2" })).toBeVisible();
    await tabTo(page, /"Zone Zone 2"/, { back: true });
    await page.keyboard.press("Delete");
    await expect(page.getByRole("heading", { name: "Zones 1" })).toBeVisible();
    const afterDelete = await focused(page);
    console.log(`[qa] focus after deleting a zone with Delete: ${afterDelete}`);

    // Save with the keyboard
    await tabTo(page, /"Save layout"/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Layout saved: 1 zone" })).toBeVisible();
    await shot(page, "layout-keyboard-saved");

    const zones = (await (await request.get(`/api/sites/${site.id}`)).json()).layout.zones as Z[];
    expect(zones.map((z) => z.name)).toEqual(["Keyboard ward"]);
    expect(minX(zones[0])).toBeCloseTo(x0 + 2, 1);
    expect(minY(zones[0])).toBeCloseTo(y0 + 5, 1);

    await page.reload();
    await expect(page.getByRole("button", { name: "Zone Keyboard ward" })).toBeVisible();
  } finally {
    await request.delete(`/api/sites/${site.id}`);
  }
});
