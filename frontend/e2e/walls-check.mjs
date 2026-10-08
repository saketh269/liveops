// Walls check (LIVEOPS-107) against a running stack: a Vite dev server (it serves /src
// modules, used to read the shared wall plan) in front of a backend with the riverside
// mock set up as site "hs" (tools/riverside-mock/setup_site.py --import-layout).
// Records every drawn person's position for ~60 s of live mock activity on Floor 1 (and
// 30 s on Floor 2) and fails if anyone is drawn inside a wall. Screenshots go to OUT.
//   WALLS_BASE=http://127.0.0.1:5173 node e2e/walls-check.mjs
import fs from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.WALLS_BASE ?? "http://127.0.0.1:5173";
const OUT = process.env.WALLS_OUT ?? "/tmp/walls-shots";
const SITE = process.env.WALLS_SITE ?? "hs";
fs.mkdirSync(OUT, { recursive: true });
const plan = [
  { floor: "1", seconds: Number(process.env.F1_S ?? 60) },
  { floor: "2", seconds: Number(process.env.F2_S ?? 30) },
];

const sites = await (await fetch(`${BASE}/api/sites`)).json();
const site = sites.find((s) => s.name === SITE);
if (!site) throw new Error(`no site named ${SITE}: run tools/riverside-mock/setup_site.py first`);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failed = false;
const report = [];
for (const { floor, seconds } of plan) {
  await page.goto(`${BASE}/map/${site.id}?debug=1&floor=${floor}`);
  await page.waitForFunction(() => window.__liveopsMap?.ready && window.__liveopsMap.stats().frames > 5, null, { timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/floor${floor}-start.png` });
  const t0 = Date.now();
  let samples = 0, moving = 0, worst = Infinity, n = 0, midShot = false;
  const bad = [];
  while (Date.now() - t0 < seconds * 1000) {
    const r = await page.evaluate(async ({ siteId, floor }) => {
      const { floorLayout } = await import("/src/map/floors.ts");
      const { navGridFor } = await import("/src/map/navigation.ts");
      const { distToSeg } = await import("/src/map/world/wallPlan.ts");
      const s = await (await fetch(`/api/sites/${siteId}`)).json();
      const layout = floorLayout(s.layout, floor);
      const walls = navGridFor(layout).plan.walls;
      const assets = await (await fetch(`/api/sites/${siteId}/assets`)).json();
      const out = [];
      for (const a of assets) {
        if (a.kind === "bed" || a.kind === "ambulance") continue;
        const p = window.__liveopsMap.positionOf(a.asset_id);
        if (!p) continue;
        let d = Infinity;
        for (const w of walls) d = Math.min(d, distToSeg([p.x, p.y], w.a, w.b));
        const inside = p.x >= 0 && p.y >= 0 && p.x <= layout.width && p.y <= layout.depth;
        out.push({ id: a.asset_id, x: p.x, y: p.y, moving: p.moving, d, inside });
      }
      return { out, walls: walls.length };
    }, { siteId: site.id, floor });
    for (const p of r.out) {
      samples++;
      if (p.moving) moving++;
      if (p.inside) worst = Math.min(worst, p.d);
      if (p.inside && p.d <= 0.1) bad.push(p);
    }
    n++;
    if (!midShot && Date.now() - t0 > (seconds * 1000) / 2) { midShot = true; await page.screenshot({ path: `${OUT}/floor${floor}-mid.png` }); }
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: `${OUT}/floor${floor}-end.png` });
  const stats = await page.evaluate(() => window.__liveopsMap.stats());
  const line = { floor, seconds, rounds: n, samples, movingSamples: moving, worstWallDistance: Number(worst.toFixed(3)), inWall: bad.length, walkersNow: stats.walkers, renderer: stats.renderer };
  report.push(line);
  console.log(JSON.stringify(line));
  if (bad.length) { failed = true; console.log("IN WALL:", JSON.stringify(bad.slice(0, 10))); }
}
// Close-ups: two-bed rooms on floor 2, the ED on floor 1.
await page.goto(`${BASE}/map/${site.id}?debug=1&floor=2`);
await page.waitForFunction(() => window.__liveopsMap?.ready && window.__liveopsMap.stats().frames > 5, null, { timeout: 60_000 });
await page.evaluate(() => window.__liveopsMap.flyToZone("CVU-203A"));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/floor2-cvu-two-bed-rooms.png` });
await page.goto(`${BASE}/map/${site.id}?debug=1&floor=1`);
await page.waitForFunction(() => window.__liveopsMap?.ready && window.__liveopsMap.stats().frames > 5, null, { timeout: 60_000 });
await page.evaluate(() => window.__liveopsMap.flyToZone("ED-NS"));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/floor1-ed-station.png` });
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, errors }, null, 2));
if (errors.length) console.log("PAGE ERRORS:", errors.slice(0, 5));
await browser.close();
process.exit(failed ? 1 : 0);
