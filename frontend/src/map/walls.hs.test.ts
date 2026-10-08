// People never walk through walls on the real hospital layout shape (LIVEOPS-107).
// HS_LAYOUT is what the layout import makes of the riverside mock; the records below
// are synthetic test records shaped like the hs mappings (beds by bed id, patients
// anchored to beds, staff at beds / nurse stations / support areas, ambulances in bays).
import type { Asset, SiteLayout } from "../api/types";
import { floorLayout, floorsOf } from "./floors";
import { Motion } from "./motion";
import { NavGrid, navFloorOf, navGridFor, type Route } from "./navigation";
import { placeAssets, type Pt } from "./placement";
import { HS_LAYOUT } from "./testdata/hsLayout";
import { expectClearOfWalls, wallDistance } from "./testdata/wallCheck";
import { WORLD } from "./world/style";
import { isNurseStation } from "./world/walls";

const T2 = WORLD.wallThickness / 2;
const floors = floorsOf(HS_LAYOUT).map((f) => ({ id: f.id, layout: floorLayout(HS_LAYOUT, f.id) }));

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const rec = (id: string, kind: string, zone: string, extra: Partial<Asset> = {}): Asset =>
  ({ site_id: "hs", asset_id: id, updated_ts: 1, kind, zone, state: "in_use", _sources: {}, ...extra });

/** Records for one floor: a bed per bed zone, patients in or beside beds, staff at beds, stations and support areas. */
function recordsFor(layout: SiteLayout, rand: () => number): Asset[] {
  const zones = layout.zones ?? [];
  const beds = zones.filter((z) => z.kind === "room" && !z.id.startsWith("area-"));
  const out: Asset[] = beds.map((z) => rec(z.id, "bed", z.id));
  beds.forEach((z, i) => {
    if (i % 2 === 0) out.push(rec(`P-${z.id}`, "patient", z.id, { anchor: z.id, state: i % 6 === 0 ? "alert" : "in_use" }));
    if (i % 3 === 0) out.push(rec(`N-${z.id}`, "staff", z.id, { role: i % 2 ? "nurse" : "physician" }));
  });
  for (const z of zones) {
    if (isNurseStation(z)) for (let k = 0; k < 4; k++) out.push(rec(`S-${z.id}-${k}`, "staff", z.id, { role: "nurse" }));
    else if (z.id.startsWith("area-")) for (let k = 0; k < 3 + Math.floor(rand() * 5); k++) out.push(rec(`A-${z.id}-${k}`, z.kind === "waiting" ? "patient" : "staff", z.name, { role: "transporter", state: "alert" }));
    else if (z.kind === "bay") out.push(rec(`AMB-${z.id}`, "ambulance", z.id));
  }
  return out;
}

/** Plays a minute of random hospital activity on a floor; returns how many drawn positions were in a wall. */
function playMinute(layout: SiteLayout, seed: number, nav?: (l: SiteLayout) => NavGrid) {
  const plan = navGridFor(layout).plan;
  const rand = seeded(seed);
  let t = 0;
  const m = new Motion({ now: () => t, nav });
  m.setLayout(layout);
  let list = recordsFor(layout, rand);
  const apply = (instant = false) => {
    const assets = new Map(list.map((a) => [a.asset_id, a]));
    m.update(assets, placeAssets(layout, assets.values()), instant);
  };
  apply(true);
  const zones = layout.zones ?? [];
  const bedIds = zones.filter((z) => z.kind === "room" && !z.id.startsWith("area-")).map((z) => z.id);
  const places = zones.filter((z) => isNurseStation(z) || z.id.startsWith("area-")).map((z) => z.name).concat(bedIds);
  let bad = 0, samples = 0, n = 0, walked = 0;
  for (let step = 0; step < 1200; step++) { // 60 s at 50 ms
    if (step % 20 === 0) {
      // Every second: a few records move, one arrives, one leaves.
      list = list.map((a) => {
        if (a.kind === "patient" && a.anchor && rand() < 0.08) {
          const to = bedIds[Math.floor(rand() * bedIds.length)];
          return { ...a, zone: to, anchor: to };
        }
        if (a.kind === "staff" && rand() < 0.1) return { ...a, zone: places[Math.floor(rand() * places.length)] };
        return a;
      });
      list.push(rec(`NEW-${n++}`, "staff", places[Math.floor(rand() * places.length)], { role: "nurse" }));
      const people = list.filter((a) => a.kind !== "bed" && a.kind !== "ambulance");
      const gone = people[Math.floor(rand() * people.length)];
      list = list.filter((a) => a !== gone);
      apply();
    }
    t += 50;
    m.step();
    for (const f of m.all()) {
      if (f.model === "bed" || f.model === "ambulance") continue;
      samples++;
      if (m.isMoving(f.id)) walked++;
      if (f.x < 0 || f.y < 0 || f.x > plan.width || f.y > plan.depth) { bad++; continue; } // outside the building
      if (wallDistance(plan, [f.x, f.y]) <= T2) bad++;
    }
  }
  return { bad, samples, walked };
}

/** The old behaviour, for checking the check: straight lines from anywhere to anywhere. */
class StraightNav extends NavGrid {
  route(from: Pt, to: Pt): Route { return { points: [from, to], reached: true }; }
}

test("the wall check catches walkers that cut straight through walls", () => {
  const layout = floors.find((f) => f.id === "2")!.layout;
  const straight = new StraightNav(navFloorOf(layout));
  expect(playMinute(layout, 3, () => straight).bad).toBeGreaterThan(0);
});

describe.each(floors)("hs floor $id", ({ id, layout }) => {
  const nav = navGridFor(layout);
  const plan = nav.plan;

  test("has walls and walkable space, and everyone is placed clear of the walls", () => {
    expect(plan.walls.length).toBeGreaterThan(4);
    const pl = placeAssets(layout, recordsFor(layout, seeded(1)));
    for (const [aid, p] of pl.positions) {
      if (aid.startsWith("AMB-") || p.unassigned) continue;
      const d = wallDistance(plan, [p.x, p.y]);
      // Beds stand in the middle of their room; people keep at least a walker's width from walls.
      expect(d, `${aid} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) is ${d.toFixed(2)} m from a wall`).toBeGreaterThan(T2 + 0.25);
      if (p.approach) expect(wallDistance(plan, p.approach)).toBeGreaterThan(T2 + 0.25);
    }
  });

  test("routes between random places (beds, bedsides, two-bed halves, stations, support areas, cores) never cross a wall", () => {
    const rand = seeded(7 + id.length);
    const pl = placeAssets(layout, recordsFor(layout, rand));
    const spots: Pt[] = [];
    for (const p of pl.positions.values()) {
      if (p.unassigned) continue;
      spots.push(p.approach ?? [p.x, p.y]);
    }
    const core = nav.exitNear([0, 0], "walk");
    expect(core).not.toBeNull();
    spots.push(core!);
    let reached = 0;
    const N = 160;
    for (let i = 0; i < N; i++) {
      const a = spots[Math.floor(rand() * spots.length)], b = spots[Math.floor(rand() * spots.length)];
      const r = nav.route(a, b);
      expectClearOfWalls(plan, r);
      if (r.reached) reached++;
    }
    expect(reached).toBe(N); // every place on an hs floor can be walked to
  });

  test("walkers come onto the floor inside the building, at a walkable spot", () => {
    const p = nav.exitNear([plan.width / 2, plan.depth / 2], "walk")!;
    expect(p[0]).toBeGreaterThan(0.3);
    expect(p[1]).toBeGreaterThan(0.3);
    expect(p[0]).toBeLessThan(plan.width - 0.3);
    expect(p[1]).toBeLessThan(plan.depth - 0.3);
    expect(nav.walkable(p)).toBe(true);
  });

  test("motion: a minute of random moves, arrivals and departures; no figure is ever drawn in a wall", () => {
    const { bad, samples, walked } = playMinute(layout, 42 + id.charCodeAt(0));
    expect(samples).toBeGreaterThan(1000);
    expect(walked).toBeGreaterThan(100); // people did walk
    expect(bad).toBe(0);
  });
});
