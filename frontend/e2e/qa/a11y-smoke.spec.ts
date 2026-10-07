// QA accessibility smoke (no axe-core in the repo): labels, keyboard focus order and visible
// focus, and text contrast in light and dark, at 400 px and desktop width.
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createSite, createSource, env, pgSettings, tag } from "./helpers";

type Finding = { page: string; check: string; detail: string };

/** Form controls and buttons with no accessible name. */
const unlabeled = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea, button, a[href], [role=button], [tabindex='0']"))) {
    if (el.closest("[aria-hidden=true]") || (el as HTMLInputElement).type === "hidden" || el.offsetParent === null && el.tagName !== "polygon") continue;
    const labelled = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")
      || ((el as HTMLInputElement).labels?.length ?? 0) > 0 || (el.textContent ?? "").trim() !== "";
    if (!labelled) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${el.className}`.slice(0, 80));
  }
  return out;
});

/** Text whose contrast against its effective background is below WCAG AA. */
const lowContrast = (page: Page) => page.evaluate(() => {
  const parse = (c: string) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255 };
    for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) };
    return base;
  };
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const done = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || done.has(el) || !(n.textContent ?? "").trim() || el.closest("svg, [aria-hidden=true], option, datalist")) continue;
    done.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || el.getClientRects().length === 0) continue;
    const fg = parse(cs.color);
    const bg = bgOf(el);
    const fgMix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const [hi, lo] = [lum(fgMix), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const disabled = (el.closest("button, input, select") as HTMLButtonElement | null)?.disabled;
    if (!disabled && ratio < (large ? 3 : 4.5)) {
      out.push(`${ratio.toFixed(2)}:1 "${(n.textContent ?? "").trim().slice(0, 30)}" (${el.tagName.toLowerCase()}.${el.className}, ${cs.color} on rgb(${bg.r | 0},${bg.g | 0},${bg.b | 0}))`);
    }
  }
  return out;
});

/** Tab through the page: is every focus stop visible (outline, box-shadow or stroke)? */
async function focusWalk(page: Page, max = 60) {
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: string[] = [];
  const invisible: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none"
        || (el instanceof SVGElement && cs.stroke !== "none");
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      return { key: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${name}"`, visible, rect: el.getBoundingClientRect().width > 0 };
    });
    if (!f) break;
    if (stops.length && f.key === stops[0]) break; // wrapped around
    stops.push(f.key);
    if (!f.visible || !f.rect) invisible.push(f.key);
  }
  return { stops, invisible };
}

test("a11y smoke: labels, focus, contrast at 400 px and desktop, light and dark", async ({ page, request }) => {
  test.setTimeout(300_000);
  const t = tag();
  const site = await createSite(request, `QA a11y ${t}`, [{ id: "a", name: "Ward A", polygon: [[2, 2], [30, 2], [30, 20], [2, 20]] }]);
  const src = await createSource(request, { name: `QA a11y src ${t}`, type: "postgres", settings: pgSettings(), secrets: { password: env("E2E_RO_PASSWORD") } });
  const findings: Finding[] = [];
  const paths = ["/sources", "/sources/new", `/sources/${src.id}`, "/sites", "/mapping", "/mapping/new", "/health", `/map/${site.id}?view=2d`, `/map/${site.id}?edit=1`];
  try {
    for (const [w, h] of [[400, 800], [1280, 800]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        for (const path of paths) {
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await page.waitForLoadState("networkidle");
          const where = `${path} @${w} ${scheme}`;
          for (const d of await lowContrast(page)) findings.push({ page: where, check: "contrast", detail: d });
          if (scheme === "light") {
            for (const d of await unlabeled(page)) findings.push({ page: where, check: "label", detail: d });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (overflow > 0) findings.push({ page: where, check: "reflow", detail: `scrolls sideways by ${overflow}px` });
          }
          if (scheme === "light" && w === 1280) {
            const { stops, invisible } = await focusWalk(page);
            console.log(`[qa] focus order ${path}: ${stops.join(" > ")}`);
            for (const d of invisible) findings.push({ page: where, check: "focus-visible", detail: d });
          }
        }
        // PostgreSQL form (picker -> form)
        await page.goto("/sources/new");
        await page.getByRole("button", { name: /^PostgreSQL(?! \(live)/ }).click();
        for (const d of await lowContrast(page)) findings.push({ page: `/sources/new pg form @${w} ${scheme}`, check: "contrast", detail: d });
        if (scheme === "light") for (const d of await unlabeled(page)) findings.push({ page: `/sources/new pg form @${w}`, check: "label", detail: d });
      }
    }
    const lang = await page.evaluate(() => document.documentElement.lang);
    if (!lang) findings.push({ page: "all", check: "lang", detail: "<html> has no lang" });
    const title = await page.title();
    console.log(`[qa] html lang="${lang}" title="${title}"`);
  } finally {
    await request.delete(`/api/sources/${src.id}`);
    await request.delete(`/api/sites/${site.id}`);
  }
  // Dedupe for the log
  const uniq = [...new Map(findings.map((f) => [`${f.check}|${f.detail}|${f.page.split(" @")[0]}`, f])).values()];
  writeFileSync(test.info().outputPath("a11y-findings.json"), JSON.stringify(uniq, null, 2));
  for (const f of uniq) console.log(`[qa] a11y ${f.check} ${f.page}: ${f.detail}`);
  console.log(`[qa] a11y findings: ${uniq.length}`);
  expect(uniq.filter((f) => f.check === "label"), "controls without a name").toEqual([]);
});
