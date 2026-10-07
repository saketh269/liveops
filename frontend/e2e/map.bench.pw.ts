// LIVEOPS-8 benchmark: 2,000 live assets in headless Chromium.
// Run with `npm run bench:map`. Results are printed and written to test-results/bench-map.json.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SITE_ID, stubBackend } from "./stub";

const ASSETS = 2000;
const CHANGES_PER_SEC = Number(process.env.BENCH_CHANGES_PER_SEC ?? 50);
const MEASURE_MS = 10_000;
const results: Record<string, unknown> = {};

type MapDebug = { ready: boolean; stats: () => { frames: number; renderer: string; webgl: string; software: boolean; antialias: boolean; instances: number; drawCalls: number; lastFrameMs: number }; colorOf: (id: string) => string | null; screenOf: (id: string) => { x: number; y: number } | null; assetCount: () => number };

async function openMap(page: Page) {
  await page.goto(`/map/${SITE_ID}?debug=1${process.env.BENCH_QS ?? ""}`);
  await page.waitForFunction((n) => {
    const m = (window as unknown as { __liveopsMap?: MapDebug }).__liveopsMap;
    return !!m && m.assetCount() >= n && m.stats().instances >= n;
  }, ASSETS, { timeout: 30_000 });
}

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/bench-map.json", JSON.stringify(results, null, 2));
  console.log(`\nbench:map results\n${JSON.stringify(results, null, 2)}`);
});

test(`renders ${ASSETS} assets with ${CHANGES_PER_SEC} state changes/s: fps over ${MEASURE_MS / 1000} s`, async ({ page }) => {
  const stub = await stubBackend(page, { assets: ASSETS, changesPerSec: CHANGES_PER_SEC });
  await openMap(page);
  await page.waitForTimeout(1500); // warm-up: shader compile, first uploads

  const sample = await page.evaluate(async (ms) => {
    const m = (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap;
    const f0 = m.stats().frames;
    const times: number[] = [];
    let last = performance.now();
    let raf = 0;
    const tick = (t: number) => { times.push(t - last); last = t; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    cancelAnimationFrame(raf);
    const elapsed = performance.now() - t0;
    const s = m.stats();
    times.sort((a, b) => a - b);
    return {
      fps: ((s.frames - f0) * 1000) / elapsed,
      frameMsP50: times[Math.floor(times.length * 0.5)],
      frameMsP95: times[Math.floor(times.length * 0.95)],
      renderer: s.renderer,
      webgl: s.webgl,
      antialias: s.antialias,
      instances: s.instances,
      drawCalls: s.drawCalls,
      assets: m.assetCount(),
    };
  }, MEASURE_MS);
  stub.stop();

  Object.assign(results, { fps: { ...sample, software: /swiftshader|llvmpipe|softpipe|software/i.test(sample.renderer), viewport: "1280x800@1x", changesPerSec: CHANGES_PER_SEC, measureMs: MEASURE_MS } });
  test.info().annotations.push({ type: "fps", description: `${sample.fps.toFixed(1)} fps on ${sample.renderer}` });
  expect(sample.assets).toBe(ASSETS);
  expect(sample.instances).toBe(ASSETS);
  expect(sample.fps).toBeGreaterThan(0);
  const min = Number(process.env.BENCH_MIN_FPS ?? 0);
  if (min) expect(sample.fps).toBeGreaterThanOrEqual(min);
});

test("a state change on the stream recolors the right asset within 1 s", async ({ page }) => {
  const targets = ["A0003", "A0500", "A1234", "A1999", "A0042"];
  const stub = await stubBackend(page, { assets: ASSETS, changesPerSec: CHANGES_PER_SEC, exclude: new Set(targets) });
  await openMap(page);
  await page.waitForTimeout(500);
  const latencies: number[] = [];
  const colorOf = (x: string) => page.evaluate((id) => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.colorOf(id), x);
  const tokenHex = (t: string) => page.evaluate((token) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
    probe.remove();
    return `#${rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }, t);
  const options: [string, string][] = [["alert", "--state-alert"], ["available", "--state-free"], ["maintenance", "--state-cleaning"], ["occupied", "--state-in-use"]];
  const hex = new Map<string, string>();
  for (const [, t] of options) hex.set(t, await tokenHex(t));

  for (let i = 0; i < targets.length * 2; i++) {
    const id = targets[i % targets.length];
    const before = await colorOf(id);
    const others = new Map<string, string | null>();
    for (const o of targets) if (o !== id) others.set(o, await colorOf(o));
    // Pick a state whose color differs from what is drawn now, so the check can't pass by accident.
    const [state, token] = options.find(([, t]) => hex.get(t) !== before)!;
    const expected = hex.get(token)!;
    const a = stub.assets.find((x) => x.asset_id === id)!;
    a.state = state;
    const t0 = Date.now();
    stub.ws()!.send(JSON.stringify({ type: "upsert", site_id: SITE_ID, assets: [{ ...a, updated_ts: t0 / 1000 }], event: null, ts: t0 / 1000 }));
    await page.waitForFunction(([x, want]) => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.colorOf(x) === want, [id, expected] as const, { polling: "raf", timeout: 5000 });
    latencies.push(Date.now() - t0);
    // No other target was recolored.
    for (const [o, c] of others) expect(await colorOf(o)).toBe(c);
  }
  stub.stop();
  const sorted = [...latencies].sort((x, y) => x - y);
  results.recolor = { samples: latencies, medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted[sorted.length - 1] };
  expect(Math.max(...latencies)).toBeLessThan(1000);
});

test("hovering and clicking an asset shows its fields and sources", async ({ page }) => {
  const stub = await stubBackend(page, { assets: 200, changesPerSec: 0 });
  await page.goto(`/map/${SITE_ID}?debug=1`);
  await page.waitForFunction(() => (window as unknown as { __liveopsMap?: MapDebug }).__liveopsMap?.stats().instances === 200);
  await page.waitForTimeout(300);
  const id = "A0050";
  const pt = await page.evaluate((x) => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.screenOf(x), id);
  expect(pt).not.toBeNull();
  await page.mouse.move(pt!.x, pt!.y);
  const details = page.getByRole("region", { name: /Asset 50/ });
  await expect(details).toBeVisible();
  await page.mouse.click(pt!.x, pt!.y);
  await expect(details.getByRole("button", { name: "Close asset details" })).toBeVisible();
  await expect(details.getByRole("rowheader", { name: "attributes.temp" })).toBeVisible();
  await expect(details.getByRole("cell", { name: "ehr" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details.getByRole("button", { name: "Close asset details" })).toHaveCount(0);
  stub.stop();
});
