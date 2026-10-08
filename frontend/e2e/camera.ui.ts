// Camera controls (camera fix): drag to rotate and tilt, right-drag to pan, wheel to zoom,
// keys and on-screen buttons, follow pause/resume, the 2D fallback, and the phone layout.
// Screenshots of three angles go to $CAMERA_SHOTS_DIR (default /tmp/camera-shots).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SITE_ID, stubBackend } from "./stub";

type View = { target: [number, number]; zoom: number; azimuth: number; polar: number; following: boolean; paused: boolean };
type MapDebug = { ready: boolean; view: () => View; assetCount: () => number; stats: () => { instances: number } };

const SHOTS = process.env.CAMERA_SHOTS_DIR ?? "/tmp/camera-shots";

async function openMap(page: Page, qs = "") {
  await stubBackend(page, { assets: 240, changesPerSec: 0, people: true });
  await page.goto(`/map/${SITE_ID}?debug=1${qs}`);
  if (qs.includes("view=2d")) {
    await page.locator("svg.lm-svg [data-asset]").first().waitFor({ timeout: 30_000 });
    return;
  }
  await page.waitForFunction(() => {
    const m = (window as unknown as { __liveopsMap?: MapDebug }).__liveopsMap;
    return !!m && m.assetCount() >= 240 && m.stats().instances > 0;
  }, null, { timeout: 30_000 });
  // Problem pins ride on the world and move as the camera turns; a pin that lands under the
  // pointer would take the drag. They are not under test here.
  await page.addStyleTag({ content: ".lm-hud-pins { display: none !important; }" });
}

const view = (page: Page) => page.evaluate(() => (window as unknown as { __liveopsMap: MapDebug }).__liveopsMap.view());

/** Waits until the camera has stopped easing and returns where it rests. */
async function settled(page: Page): Promise<View> {
  let last = JSON.stringify(await view(page));
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await view(page));
    if (now === last) return JSON.parse(now) as View;
    last = now;
  }
  return JSON.parse(last) as View;
}

/** A point over the bare canvas (not a card or a pin) near the middle of the map. */
async function canvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    for (const [fx, fy] of [[0.42, 0.55], [0.38, 0.62], [0.5, 0.5], [0.45, 0.7], [0.35, 0.45]]) {
      const x = Math.round(vw * fx), y = Math.round(vh * fy);
      const ok = [[0, 0], [160, 0], [-160, 0], [0, 110], [0, -110]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy)?.classList.contains("lm-canvas"));
      if (ok) return { x, y };
    }
    return null;
  });
  expect(p, "a free spot on the canvas to drag").not.toBeNull();
  return p!;
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, button: "left" | "right" = "left") {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.waitForTimeout(80); // stop before letting go: no fling
  await page.mouse.up({ button });
  return settled(page);
}

test("drag rotates and tilts, right-drag pans, wheel zooms; three angles", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await openMap(page);
  const start = await settled(page);
  const at = await canvasPoint(page);
  await page.screenshot({ path: join(SHOTS, "1-default-angle.png") });

  // Left/right drags turn the map (yaw) without changing the tilt.
  const right = await drag(page, at, 160, 0);
  expect(right.azimuth).toBeLessThan(start.azimuth - 0.5);
  expect(right.polar).toBeCloseTo(start.polar, 3);
  // Turning happens around the point under the cursor, so the target moves too.
  expect(Math.hypot(right.target[0] - start.target[0], right.target[1] - start.target[1])).toBeGreaterThan(0.5);
  const left = await drag(page, at, -160, 0);
  expect(left.azimuth).toBeGreaterThan(right.azimuth + 0.5);

  // Up/down drags tilt: up towards the horizon, down towards a top view.
  const up = await drag(page, at, 0, -100);
  expect(up.polar).toBeGreaterThan(left.polar + 0.2);
  expect(up.azimuth).toBeCloseTo(left.azimuth, 3);
  await page.screenshot({ path: join(SHOTS, "2-turned-and-tilted-low.png") });
  const down = await drag(page, at, 0, 200);
  expect(down.polar).toBeLessThan(up.polar - 0.4);

  // Right-drag pans: target moves, angles stay.
  const pan = await drag(page, at, 120, 60, "right");
  expect(Math.hypot(pan.target[0] - down.target[0], pan.target[1] - down.target[1])).toBeGreaterThan(3);
  expect(pan.azimuth).toBeCloseTo(down.azimuth, 3);
  expect(pan.polar).toBeCloseTo(down.polar, 3);

  // Wheel zooms in towards the cursor.
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -300);
  const zoomed = await settled(page);
  expect(zoomed.zoom).toBeGreaterThan(pan.zoom * 1.2);

  // Keys (map focused): Q/E rotate, W/S tilt, arrows pan.
  await page.locator(".lm-canvas-host").focus();
  await page.keyboard.press("e");
  await page.keyboard.press("s");
  await page.keyboard.press("ArrowRight");
  const keyed = await settled(page);
  expect(keyed.azimuth).toBeGreaterThan(zoomed.azimuth);
  expect(keyed.polar).toBeLessThan(zoomed.polar);
  expect(keyed.target).not.toEqual(zoomed.target);
  await page.screenshot({ path: join(SHOTS, "3-close-up-from-above.png") });

  // On-screen controls.
  const cam = page.getByRole("group", { name: "Camera" });
  await cam.getByRole("button", { name: "Rotate right" }).click();
  expect((await settled(page)).azimuth).toBeGreaterThan(keyed.azimuth + 0.3);
  await cam.getByRole("button", { name: /Tilt up/ }).click();
  expect((await settled(page)).polar).toBeGreaterThan(keyed.polar);
  await cam.getByRole("button", { name: /^Compass/ }).click();
  expect(Math.abs(Math.sin((await settled(page)).azimuth))).toBeLessThan(1e-3);
  await expect(cam.getByRole("button", { name: /North is up/ })).toBeVisible();
  await cam.getByRole("button", { name: "Reset view" }).click();
  const reset = await settled(page);
  expect(reset.azimuth).toBeCloseTo(start.azimuth, 3);
  expect(reset.polar).toBeCloseTo(start.polar, 3);
  expect(reset.zoom).toBeCloseTo(start.zoom, 2);
});

test("following: orbit keeps tracking, a pan pauses it, Resume tracking returns", async ({ page }) => {
  await openMap(page);
  await settled(page);
  // Select a figure through Find asset, then follow it.
  await page.getByPlaceholder("Find asset").fill("A0001");
  const cam = page.getByRole("group", { name: "Camera" });
  await cam.getByRole("button", { name: "Follow" }).click();
  await expect(cam.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "true");
  const tracking = await settled(page);
  expect(tracking.following).toBe(true);
  const at = await canvasPoint(page);
  const orbit = await drag(page, at, 120, 0);
  expect(orbit.paused).toBe(false);
  expect(orbit.target[0]).toBeCloseTo(tracking.target[0], 0);
  expect(orbit.target[1]).toBeCloseTo(tracking.target[1], 0);
  const panned = await drag(page, at, 150, 80, "right");
  expect(panned.paused).toBe(true);
  const resume = cam.getByRole("button", { name: "Resume tracking" });
  await expect(resume).toBeVisible();
  await resume.click();
  const back = await settled(page);
  expect(back.paused).toBe(false);
  expect(back.target[0]).toBeCloseTo(tracking.target[0], 0);
  await expect(resume).toHaveCount(0);
});

test("touch: one finger rotates, two fingers pinch-zoom and pan, double-tap zooms in", async ({ page }) => {
  await openMap(page);
  const start = await settled(page);
  const at = await canvasPoint(page);
  /** Synthetic touch pointers on the canvas, dispatched together: [type, id, x, y]. */
  const send = (events: [string, number, number, number][]) => page.evaluate((events) => {
    const el = document.querySelector(".lm-canvas")!;
    for (const [type, id, x, y] of events) {
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, isPrimary: id === 1, button: 0 }));
    }
  }, events);
  const touch = (type: string, pts: [number, number, number][]) => send(pts.map(([id, x, y]) => [type, id, x, y] as [string, number, number, number]));
  // One finger sideways: turn.
  await touch("pointerdown", [[1, at.x, at.y]]);
  for (let i = 1; i <= 10; i++) await touch("pointermove", [[1, at.x + i * 14, at.y]]);
  await page.waitForTimeout(80);
  await touch("pointerup", [[1, at.x + 140, at.y]]);
  const turned = await settled(page);
  expect(turned.azimuth).toBeLessThan(start.azimuth - 0.4);
  // Two fingers spreading apart and moving together: zoom in and pan.
  await touch("pointerdown", [[2, at.x - 40, at.y], [3, at.x + 40, at.y]]);
  for (let i = 1; i <= 10; i++) await touch("pointermove", [[2, at.x - 40 - i * 6, at.y + i * 4], [3, at.x + 40 + i * 6, at.y + i * 4]]);
  await touch("pointerup", [[2, at.x - 100, at.y + 40], [3, at.x + 100, at.y + 40]]);
  const pinched = await settled(page);
  expect(pinched.zoom).toBeGreaterThan(turned.zoom * 1.5);
  expect(pinched.target).not.toEqual(turned.target);
  // Double-tap: zoom in.
  await send([["pointerdown", 4, at.x, at.y], ["pointerup", 4, at.x, at.y], ["pointerdown", 5, at.x + 3, at.y], ["pointerup", 5, at.x + 3, at.y]]);
  expect((await settled(page)).zoom).toBeGreaterThan(pinched.zoom * 1.2);
});

test("2D fallback: drag pans, wheel zooms, rotate turns the drawing", async ({ page }) => {
  await openMap(page, "&view=2d");
  const svg = page.locator("svg.lm-svg");
  await expect(svg).toBeVisible();
  const vb0 = await svg.getAttribute("viewBox");
  const box = (await svg.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 30, { steps: 8 });
  await page.mouse.up();
  const vb1 = await svg.getAttribute("viewBox");
  expect(vb1).not.toBe(vb0);
  await page.mouse.wheel(0, -200);
  const [, , w1] = vb1!.split(" ").map(Number);
  const [, , w2] = (await svg.getAttribute("viewBox"))!.split(" ").map(Number);
  expect(w2).toBeLessThan(w1);
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam.getByRole("button", { name: /Tilt/ })).toHaveCount(0);
  await cam.getByRole("button", { name: "Rotate right" }).click();
  await expect(svg.locator("> g").first()).toHaveAttribute("transform", /^rotate\(22\.5/);
  await cam.getByRole("button", { name: "Reset view" }).click();
  await expect(svg).toHaveAttribute("viewBox", vb0!);
});

test("phone: the camera controls sit clear of every card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMap(page);
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toBeVisible();
  const c = (await cam.boundingBox())!;
  expect(c.x).toBeGreaterThanOrEqual(0);
  expect(c.x + c.width).toBeLessThanOrEqual(390);
  for (const sel of [".lm-hud-top", ".lm-hud-tools", ".lm-hud-side", ".lm-hud-journey", ".lm-hud-hints", ".lm-hud-floors"]) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      const b = (await el.boundingBox())!;
      const overlap = c.x < b.x + b.width && b.x < c.x + c.width && c.y < b.y + b.height && b.y < c.y + c.height;
      expect(overlap, `camera controls overlap ${sel}`).toBe(false);
    }
  }
  // Touch-size buttons with names.
  for (const name of ["Zoom in", "Zoom out", "Rotate left", "Rotate right", "Reset view"]) await expect(cam.getByRole("button", { name })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "4-phone-controls.png") });
});
