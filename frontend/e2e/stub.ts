// Stubbed Live Ops API + WebSocket for browser benchmarks: no backend needed.
import type { Page, WebSocketRoute } from "@playwright/test";

export const SITE_ID = "bench";
const STATES = ["free", "available", "occupied", "in_use", "cleaning", "maintenance", "alert", "blocked", "unknown"];
const KINDS = ["bed", "pump", "wheelchair", "monitor"];
/** People and vehicles for the walking benchmark: [kind, role]. */
export const PEOPLE: [string, string | undefined][] = [
  ["staff", "nurse"], ["staff", "doctor"], ["staff", "cleaner"], ["patient", undefined], ["person", undefined], ["bed", undefined], ["equipment", undefined], ["ambulance", undefined],
];

export function benchSite(zonesX = 4, zonesY = 3) {
  const width = 120, depth = 72, gap = 2;
  const zw = (width - gap * (zonesX + 1)) / zonesX;
  const zd = (depth - gap * (zonesY + 1)) / zonesY;
  const zones = [];
  for (let j = 0; j < zonesY; j++) {
    for (let i = 0; i < zonesX; i++) {
      const x = gap + i * (zw + gap), y = gap + j * (zd + gap);
      zones.push({ id: `z${j * zonesX + i}`, name: `Zone ${j * zonesX + i + 1}`, polygon: [[x, y], [x + zw, y], [x + zw, y + zd], [x, y + zd]] });
    }
  }
  return { id: SITE_ID, name: "Benchmark site", template: "hospital", layout: { width, depth, zones }, created_ts: 0, updated_ts: 0 };
}

/** Deterministic pseudo-random generator so runs are comparable. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function benchAssets(n: number, zones: number, rand = rng(), people = false) {
  return Array.from({ length: n }, (_, i) => ({
    site_id: SITE_ID,
    asset_id: `A${String(i).padStart(4, "0")}`,
    label: `Asset ${i}`,
    kind: people ? PEOPLE[i % PEOPLE.length][0] : KINDS[i % KINDS.length],
    ...(people && PEOPLE[i % PEOPLE.length][1] ? { role: PEOPLE[i % PEOPLE.length][1] } : {}),
    zone: i % 97 === 0 ? "Loading dock" : `Zone ${(i % zones) + 1}`, // ~1% unassigned
    state: STATES[Math.floor(rand() * STATES.length)],
    attributes: { temp: 20 + (i % 7) },
    updated_ts: Date.now() / 1000,
    _sources: { state: "ehr", zone: "ehr", label: "ehr", kind: "ehr", attributes: "ehr" },
  }));
}

export type Stub = { ws: () => WebSocketRoute | null; assets: ReturnType<typeof benchAssets>; stop: () => void };

/**
 * Routes /api and /ws for the page. After the snapshot, sends `changesPerSec`
 * random state changes in batches every 100 ms (skipping ids in `exclude`).
 */
export async function stubBackend(page: Page, opts: { assets: number; changesPerSec: number; exclude?: Set<string>; people?: boolean }): Promise<Stub> {
  const site = benchSite();
  const assets = benchAssets(opts.assets, site.layout.zones.length, rng(), opts.people);
  let socket: WebSocketRoute | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const rand = rng(7);

  await page.route("**/api/sites", (r) => r.fulfill({ json: [site] }));
  await page.route(`**/api/sites/${SITE_ID}`, (r) => r.fulfill({ json: site }));
  await page.routeWebSocket(`**/ws/sites/${SITE_ID}`, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "snapshot", site_id: SITE_ID, assets, event: null, ts: Date.now() / 1000 }));
    const perTick = Math.max(1, Math.round(opts.changesPerSec / 10));
    timer = setInterval(() => {
      for (let k = 0; k < perTick; k++) {
        const a = assets[Math.floor(rand() * assets.length)];
        if (opts.exclude?.has(a.asset_id)) continue;
        a.state = STATES[Math.floor(rand() * STATES.length)];
        a.updated_ts = Date.now() / 1000;
        ws.send(JSON.stringify({ type: "upsert", site_id: SITE_ID, assets: [{ ...a }], event: null, ts: a.updated_ts }));
      }
    }, 100);
  });
  return { ws: () => socket, assets, stop: () => clearInterval(timer) };
}
