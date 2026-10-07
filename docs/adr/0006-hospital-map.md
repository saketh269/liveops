# ADR 0006: Hospital map (0.2) shared contract

Status: accepted (0.2). Every 0.2 agent builds against this. Change it only through the tech lead.

## Principles
- Every figure on the map is a real record. No decorative or invented movement in the product.
- Movement is a presentation of a real change (zone, anchor or x/y changed). If data stops, the map stops.
- Old layouts (0.1: `width`, `depth`, `zones` with no floors) keep working unchanged.
- Test data lives only in `tools/hospital-sim/` and never ships in product images.

## Layout v2 (`Site.layout`, stored as JSON, no migration needed)
```ts
type Pt = [number, number];
type FloorPlan = { asset_id: string; x: number; y: number; w: number; h: number; opacity?: number };
type Floor = { id: string; name: string; level: number; width: number; depth: number; plan?: FloorPlan };
type ZoneKind = "unit" | "room" | "bay" | "corridor" | "waiting" | "entrance";
type Zone = { id; name; polygon: Pt[]; color?; floor_id?: string; kind?: ZoneKind; doors?: Pt[] };
type Entrance = { id: string; name: string; floor_id?: string; point: Pt; kind: "walk" | "ambulance" };
type SiteLayout = { width?; depth?; zones?: Zone[]; floors?: Floor[]; entrances?: Entrance[] };
```
- No `floors` = one implicit floor `{id: "main", level: 0, width, depth}`. A zone without `floor_id` is on the first floor.
- `doors`: points on a zone's edge where people enter. None = walkers enter at the edge point nearest their path.
- `corridor` zones are walkable space. If a floor has none, all space outside zones is walkable.
- No entrances = default walk entrance at the middle of the floor's bottom edge; ambulance at its bottom-left corner.

## Floor plan images
- `POST /api/sites/{site_id}/plans` (multipart `file`: PNG, JPEG, WebP or PDF, ≤ 20 MB). PDF: first page rendered to PNG server side.
  Returns `{asset_id, width_px, height_px, content_type}`.
- `GET /api/sites/{site_id}/plans/{asset_id}` serves the image. Stored under `LIVEOPS_DATA_DIR/plans/`.
- `DELETE` on the same path. Files are validated by magic bytes and pixel-count capped (decompression bombs).

## Reserved asset fields (mapping targets, in addition to zone, state, label, kind, x, y)
- `floor`: floor id or name (optional; default: the floor of the asset's zone).
- `anchor`: id of another asset on the same site (a patient's `bed_id`). Drawn at/next to that asset. (0.2 batch 2)
- `role`: free text such as nurse, doctor, cleaner, patient. Picks the figure style with `kind`.

## Kinds and figures
`kind` (lowercased) picks the model: bed, patient, person/staff/nurse/doctor/cleaner, ambulance/vehicle, equipment, other.
Unknown kinds fall back to the current box shape.

## Mapping row filter (`MappingConfig.filter`)
```ts
type RowFilter = { column: string; op: "eq"|"ne"|"in"|"not_in"|"is_null"|"not_null"|"gt"|"gte"|"lt"|"lte"|"contains"; value?: unknown };
filter?: RowFilter[]   // all must match (AND)
```
A row that stops matching is removed from the map for that mapping (same as a delete). Applied in the backend to
snapshots, polls and CDC alike. Columns are validated against the dataset like other mapping fields.

## Suggested mappings
`GET /api/sources/{source_id}/suggestions?site_id=` → list of `{dataset, config, filter?, reason, confidence, attach_to?}`.
The UI shows them as a checklist and creates the selected mappings.
