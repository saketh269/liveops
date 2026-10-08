// Painted floor: tile grid, corridor tint, soft area fills and zone names printed on
// the floor (room names just inside their door). Drawn once per floor on a canvas.
import type { Zone } from "../../api/types";
import { polygonArea, polygonBounds, polygonCentroid, type Pt } from "../placement";
import type { ScenePalette } from "./style";
import { isNurseStation } from "./walls";

/** Pixels per metre for a floor, keeping the canvas within `maxPx` on its long side. */
export function paintScale(width: number, depth: number, maxPx = 2048): number {
  return Math.max(4, Math.min(32, maxPx / Math.max(width, depth, 1)));
}

/**
 * Layout direction the default camera looks from (towards +y: the camera sits below
 * the floor plan, see camera.ts VIEW_DIR). Floor just behind a wall, seen from here,
 * is hidden by that wall.
 */
const VIEWER: Pt = [0, 1];

/**
 * Where a zone's name is printed, next to its first door so it reads like a door
 * plate: on the side of the door the default camera can see. A door facing the
 * camera puts the name just outside (on the corridor), a door facing away puts it
 * just inside (towards the middle of the zone). No door: the zone's centre.
 * `bounds` (the floor) keeps an outside name on the floor.
 */
export function labelSpot(zone: Zone, bounds?: { width: number; depth: number }): Pt {
  const c = polygonCentroid(zone.polygon);
  const d = zone.doors?.find((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!d) return c;
  const dx = c[0] - d[0], dy = c[1] - d[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return c;
  const ux = dx / dist, uy = dy / dist; // inwards
  const facesViewer = -(ux * VIEWER[0] + uy * VIEWER[1]) > 0.5;
  if (facesViewer) {
    const out: Pt = [d[0] - ux * 0.75, d[1] - uy * 0.75];
    const inFloor = !bounds || (out[0] >= 0.3 && out[1] >= 0.3 && out[0] <= bounds.width - 0.3 && out[1] <= bounds.depth - 0.3);
    if (inFloor) return out;
  }
  const step = Math.min(1.3, dist * 0.5);
  return [d[0] + ux * step, d[1] + uy * step];
}

/** A zone is roughly a rectangle (so a centre line along it makes sense). */
function rectangular(poly: readonly Pt[]): boolean {
  const b = polygonBounds(poly);
  return b.w * b.h > 0 && polygonArea(poly) / (b.w * b.h) > 0.92;
}

function path(g: CanvasRenderingContext2D, poly: readonly Pt[], s: number) {
  g.beginPath();
  poly.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
  g.closePath();
}

/** Print `text` centred at (x, y) px, shrunk to fit `maxW` px. */
function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxW: number, weight: number, family: string) {
  let px = size;
  g.font = `${weight} ${px}px ${family}`;
  const w = g.measureText(text).width;
  if (w > maxW && w > 0) {
    px = Math.max(6, (px * maxW) / w);
    g.font = `${weight} ${px}px ${family}`;
  }
  g.fillText(text, x, y);
}

export type PaintFonts = { data: string; body: string };

/** Paint a floor onto a new canvas (null where canvas 2D is unavailable, e.g. tests). */
export function paintFloor(width: number, depth: number, zones: readonly Zone[], p: ScenePalette, fonts: PaintFonts, maxPx = 2048): HTMLCanvasElement | null {
  const s = paintScale(width, depth, maxPx);
  const cv = document.createElement("canvas");
  cv.width = Math.max(2, Math.round(width * s));
  cv.height = Math.max(2, Math.round(depth * s));
  const g = cv.getContext("2d");
  if (!g) return null;
  const valid = zones.filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3);

  g.fillStyle = p.floor;
  g.fillRect(0, 0, cv.width, cv.height);

  // Area fills under the grid: corridors in their own tint, other non-room zones softly.
  for (const z of valid) {
    if (z.kind === "room") continue;
    path(g, z.polygon, s);
    g.fillStyle = z.kind === "corridor" ? p.corridor : z.kind === "bay" ? p.bayPad : p.zoneFill;
    g.fill();
    if (z.color && z.kind !== "corridor") {
      g.globalAlpha = 0.3;
      try { g.fillStyle = z.color; g.fill(); } catch { /* unparsable custom color */ }
      g.globalAlpha = 1;
    }
  }

  // Tile grid: 1 m, or 5 m when tiles would be under 8 px.
  const step = s >= 8 ? 1 : 5;
  g.strokeStyle = p.floorLine;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= width + 1e-6; x += step) { g.moveTo(Math.round(x * s) + 0.5, 0); g.lineTo(Math.round(x * s) + 0.5, cv.height); }
  for (let y = 0; y <= depth + 1e-6; y += step) { g.moveTo(0, Math.round(y * s) + 0.5); g.lineTo(cv.width, Math.round(y * s) + 0.5); }
  g.stroke();

  // Dashed centre line along each straight corridor.
  g.strokeStyle = p.corridorLine;
  g.lineWidth = Math.max(1.5, s * 0.12);
  g.setLineDash([s * 0.6, s * 0.4]);
  for (const z of valid) {
    if (z.kind !== "corridor" || !rectangular(z.polygon)) continue;
    const b = polygonBounds(z.polygon);
    g.beginPath();
    if (b.w >= b.h) { g.moveTo((b.x + 0.5) * s, (b.y + b.h / 2) * s); g.lineTo((b.x + b.w - 0.5) * s, (b.y + b.h / 2) * s); }
    else { g.moveTo((b.x + b.w / 2) * s, (b.y + 0.5) * s); g.lineTo((b.x + b.w / 2) * s, (b.y + b.h - 0.5) * s); }
    g.stroke();
  }
  g.setLineDash([]);

  // Bay markings: a painted line just inside each bay's edge (over the tile grid).
  g.strokeStyle = p.bayLine;
  g.lineWidth = Math.max(2, s * 0.14);
  g.lineJoin = "round";
  for (const z of valid) {
    if (z.kind !== "bay") continue;
    const b = polygonBounds(z.polygon);
    const inset = Math.min(0.35, b.w / 6, b.h / 6);
    const c = polygonCentroid(z.polygon);
    // Shrink towards the centre: exact for rectangles, close enough for other shapes.
    path(g, z.polygon.map(([x, y]) => [x + Math.sign(c[0] - x) * inset, y + Math.sign(c[1] - y) * inset] as Pt), s);
    g.stroke();
  }

  // Names printed on the floor.
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const z of valid) {
    if (z.kind === "corridor" || isNurseStation(z)) continue; // nurse stations show their desk
    const name = (z.name || z.id || "").trim();
    if (!name) continue;
    const b = polygonBounds(z.polygon);
    if (z.kind === "room") {
      const [x, y] = labelSpot(z, { width, depth });
      g.fillStyle = p.roomLabel;
      fitText(g, name, x * s, y * s, 0.7 * s, b.w * s * 0.86, 600, fonts.data);
    } else {
      const [x, y] = polygonCentroid(z.polygon);
      g.fillStyle = p.areaLabel;
      fitText(g, name.toUpperCase(), x * s, y * s, Math.min(0.6, b.h * 0.3) * s, b.w * s * 0.85, 700, fonts.body);
    }
  }
  return cv;
}
