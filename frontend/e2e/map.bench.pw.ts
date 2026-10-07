// LIVEOPS-8 benchmark: 2,000 live assets in headless Chromium.
// Run with `npm run bench:map`. Results are printed and written to test-results/bench-map.json.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SITE_ID, stubBackend } from "./stub";

const ASSETS = 2000;
const CHANGES_PER_SEC = Number(process.env.BENCH_CHANGES_PER_SEC ?? 50);
const MEASURE_MS = 10_000;
const results: Record<string, unknown> = {};

type MapDebug = { ready: boolean; stats: () => { frames: number; renderer: string; webgl: string; software: boolean; antialias: boolean; instances: number; drawCalls: number; lastFrameMs: number; walkers: number }; colorOf: (id: string) => string | null; screenOf: (id: string) => { x: number; y: number } | null; positionOf: (id: string) => { x: number; y: number; moving: boolean; leaving: boolean } | null; assetCount: () => number };

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

const WALKERS = 500;

test(`${ASSETS} figures with ${WALKERS} walking at once: fps over ${MEASURE_MS / 1000} s`, async ({ page }) => {
  const stub = await stubBackend(page, { assets: ASSETS, changesPerSec: CHANGES_PER_SEC, people: true });
  await openMap(page);
  await page.waitForTimeout(1500);
  const zones = 12;
  let wave = 0;
  // One upsert moves WALKERS records to another zone (a real change), like a shift handover.
  const sendWave = () => {
    wave++;
    const moved = [];
    for (let i = 0; i < WALKERS; i++) {
      const a = stub.assets[(i * 4 + wave) % ASSETS];
      if (a.zone === "Loading dock") continue;
      const z = Number(a.zone.replace("Zone ", "")) - 1;
      a.zone = `Zone ${((z + 5) % zones) + 1}`;
      a.updated_ts = Date.now() / 1000;
      moved.push({ ...a });
    }
    stub.ws()!.send(JSON.stringify({ type: "upsert", site_id: SITE_ID, assets: moved, event: null, ts: Date.now() / 1000 }));
    return moved.length;
  };
  let sent = sendWave();
  await page.waitForFunction((n) => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.stats().walkers >= n, Math.floor(sent * 0.9), { timeout: 10_000 });
  const measure = page.evaluate(async (ms) => {
    const m = (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap;
    const f0 = m.stats().frames;
    const times: number[] = [];
    const walkers: number[] = [];
    const cpu: number[] = [];
    let last = performance.now();
    let raf = 0;
    const tick = (t: number) => { times.push(t - last); last = t; const st = m.stats(); walkers.push(st.walkers); cpu.push(st.lastFrameMs); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    cancelAnimationFrame(raf);
    const elapsed = performance.now() - t0;
    const s = m.stats();
    times.sort((a, b) => a - b);
    walkers.sort((a, b) => a - b);
    cpu.sort((a, b) => a - b);
    return {
      cpuMsP50: cpu[Math.floor(cpu.length * 0.5)],
      cpuMsP95: cpu[Math.floor(cpu.length * 0.95)],
      fps: ((s.frames - f0) * 1000) / elapsed,
      frameMsP50: times[Math.floor(times.length * 0.5)],
      frameMsP95: times[Math.floor(times.length * 0.95)],
      walkersMin: walkers[0],
      walkersP50: walkers[Math.floor(walkers.length * 0.5)],
      renderer: s.renderer,
      instances: s.instances,
      drawCalls: s.drawCalls,
    };
  }, MEASURE_MS);
  await page.waitForTimeout(MEASURE_MS / 2);
  sent += sendWave(); // a second wave mid-measurement: walkers re-path from where they are
  const sample = await measure;
  stub.stop();
  results.walking = { ...sample, wavesSent: wave, recordsMoved: sent, viewport: "1280x800@1x", changesPerSec: CHANGES_PER_SEC, measureMs: MEASURE_MS };
  test.info().annotations.push({ type: "fps", description: `${sample.fps.toFixed(1)} fps with ${sample.walkersP50} walking on ${sample.renderer}` });
  expect(sample.instances).toBe(ASSETS);
  expect(sample.walkersMin).toBeGreaterThanOrEqual(WALKERS * 0.9);
  const min = Number(process.env.BENCH_MIN_FPS ?? 0);
  if (min) expect(sample.fps).toBeGreaterThanOrEqual(min);
});

test("a moved record walks there and arrives; a removed one walks out and disappears", async ({ page }) => {
  const stub = await stubBackend(page, { assets: 200, changesPerSec: 0, people: true });
  await page.goto(`/map/${SITE_ID}?debug=1`);
  await page.waitForFunction(() => (window as unknown as { __liveopsMap?: MapDebug }).__liveopsMap?.stats().instances === 200);
  const pos = (id: string) => page.evaluate((x) => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.positionOf(x), id);
  const a = stub.assets.find((x) => x.asset_id === "A0001")!;
  const before = (await pos("A0001"))!;
  expect(before.moving).toBe(false);
  a.zone = "Zone 12";
  stub.ws()!.send(JSON.stringify({ type: "upsert", site_id: SITE_ID, assets: [{ ...a }], event: null, ts: Date.now() / 1000 }));
  await page.waitForFunction(() => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.positionOf("A0001")?.moving === true);
  await page.waitForTimeout(1000);
  const mid = (await pos("A0001"))!;
  expect(Math.hypot(mid.x - before.x, mid.y - before.y)).toBeGreaterThan(0.5);
  // Hover works on a moving figure.
  const pt = await page.evaluate(() => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.screenOf("A0001"));
  await page.mouse.move(pt!.x, pt!.y);
  await expect(page.getByRole("region", { name: /Asset 1\b/ })).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.positionOf("A0001")?.moving === false, null, { timeout: 15_000 });

  stub.ws()!.send(JSON.stringify({ type: "remove", site_id: SITE_ID, assets: [{ site_id: SITE_ID, asset_id: "A0002" }], event: null, ts: Date.now() / 1000 }));
  await page.waitForFunction(() => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.positionOf("A0002")?.leaving === true);
  await page.waitForFunction(() => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.positionOf("A0002") === null, null, { timeout: 15_000 });
  stub.stop();
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
