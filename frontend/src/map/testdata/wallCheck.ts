// Test helpers: checks that routes and positions keep out of the walls of a wall plan.
import type { Route } from "../navigation";
import type { Pt } from "../placement";
import { WORLD } from "../world/style";
import { distToSeg, segmentsIntersect, type FloorWallPlan } from "../world/wallPlan";

/** Points every `step` along a polyline. */
export function samples(pts: Pt[], step = 0.05): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Every run of the route crosses no wall and keeps out of every wall's thickness. */
export function expectClearOfWalls(plan: FloorWallPlan, r: Route, opts: { startsInWall?: boolean } = {}) {
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], b = r.points[i];
    const hit = plan.walls.find((w) => segmentsIntersect(a, b, w.a, w.b));
    expect(hit, `run ${a} → ${b} crosses wall ${hit?.a} → ${hit?.b}`).toBeUndefined();
  }
  // A route that starts inside a wall's thickness (bad input) only has to leave it without crossing.
  let worst = Infinity, at: Pt | null = null;
  for (const p of samples(opts.startsInWall ? r.points.slice(1) : r.points, 0.1)) {
    const d = wallDistance(plan, p);
    if (d < worst) { worst = d; at = p; }
  }
  expect(worst, `route passes ${worst.toFixed(3)} m from a wall at ${at}`).toBeGreaterThan(WORLD.wallThickness / 2);
}

/** Distance from a point to the nearest wall centre line. */
export function wallDistance(plan: FloorWallPlan, p: Pt): number {
  let best = Infinity;
  for (const w of plan.walls) best = Math.min(best, distToSeg(p, w.a, w.b));
  return best;
}
