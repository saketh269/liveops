# ADR 0007: Hospital view (0.3) — the approved look on live data

Status: accepted. Approved reference: `docs/design/hospital-view-prototype.html` (Saketh approved the look).
Builds on ADR 0006. Every figure is a real record; the prototype's simulation never ships.

## Target
The live map looks and behaves like the prototype, driven by real sources:
- soft daylight 3D: ACES tone mapping, hemisphere + warm directional light, soft shadows, angled orthographic camera
- rooms are floor tiles tinted by the state of the bed in them; low cut-away walls with door gaps; accent-topped outer walls
- recognisable models: bed (frame, mattress, pillow, sheet, status light), patient lying in bed, standing people
  (head, body, legs) styled by role (nurse teal scrubs, doctor white coat, EVS amber with cart, transporter, paramedic red),
  ambulance with light bar; nurse station desk; waiting chairs
- glass cards floating over the scene: KPI strip (top), floor rail (left), unit/room card (right), journey tracker (bottom),
  problem pins projected over the world; a clean **demo mode** (`?demo=1`) hides setup notices and editing chrome

## Data rules
- Room tint = state of the `kind: bed` asset whose zone is that room zone (zone kind `room`); none → neutral tile.
- A person with `anchor` (reserved field, ADR 0006) whose anchor is a bed asset is drawn **in** that bed if their state
  maps to in_use and they are a patient; staff with a bed location stand at the bedside. Otherwise packed in the zone.
- People walk between zones (motion.ts) only on real changes; beds never move.
- KPI numbers come from live assets only (Phase 2 adds timers and alert rules).

## Ownership (Phase 1) — edit only your files; touch shared files in small, marked hunks
| Agent | Owns | May touch (small hooks) |
|---|---|---|
| scene | `map/world/*` (new: style tokens, lighting, ground, room tiles, walls, nurse stations, camera presets), scene.ts setup/lighting/zone drawing | MapView3D.tsx |
| models | `map/figureGeometry.ts`, `map/figures.ts`, `map/figureLayer.ts` model look, `FigureGlyph.tsx`, new `map/models/*` | — |
| anchors | `map/placement.ts`, `map/motion.ts`, `map/navigation.ts`, backend reserved field `anchor` in mapping/state if needed | MappingWizard field list |
| layout-import | backend `app/api/layout_import.py` (+ tests), frontend "Import layout" in LayoutEditor / site setup | `api/client.ts`, `api/types.ts` |
| ui-shell | `pages/LiveMapPage.tsx`, `map/panels.tsx`, `map/SetupHints.tsx`, `map/map.css`, new `map/hud/*` | — |

`api/types.ts` and `api/client.ts`: additive changes only. Never reformat files you don't own.

## Test environment
- Mock of the user's hospital API: `python tools/riverside-mock/mock_api.py --port <your port>` (same endpoints, auth
  `X-API-Key: demo-key`, layout, statuses). `tools/riverside-mock/setup_site.py` creates site "hs" with the six sources and
  mappings exactly as on the user's PC.
- The tech lead verifies merged work against the real API on the user's PC.

## Layout import (contract)
`POST /api/sites/{id}/layout/import` body `{source_id, path?, format: "auto"|"riverside"|"geojson-lite", mode: "replace"|"merge", options}`
→ `{layout, summary: {floors, zones, beds, warnings[]}}`, with `dry_run: true` returning the preview without saving.
Uses the source's connection (base URL, sign-in, network guard) to GET the path. The "riverside" format is
`{floors:[{floor, units:[{unit_id, name, x, y, width, height, nurse_station:{x,y}, rooms:[{room_id,x,y,width,height,beds:[{bed_id,x,y}]}]}]}]}`
and produces what `tools/riverside-mock/setup_site.py::build_layout` produces (one `room` zone per bed, corridors, stations).
