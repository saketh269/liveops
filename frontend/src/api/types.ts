// Mirrors backend/app/api/schemas.py and app/connectors/base.py.
// Keep in sync when the API changes (agent-review checks this).

export type JSONSchema = {
  type?: string;
  title?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JSONSchema>;
  enum?: string[];
  default?: unknown;
  format?: string;
  items?: JSONSchema;
  examples?: unknown[];
  additionalProperties?: boolean | JSONSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

export type ConnectorSpec = {
  type: string;
  display_name: string;
  category: "database" | "warehouse" | "stream" | "api" | "file" | "federation";
  modes: ("poll" | "cdc" | "push")[];
  description: string;
  settings_schema: JSONSchema;
  secrets_schema: JSONSchema;
  maturity: "stable" | "beta" | "needs_real_test";
};

export type Source = {
  id: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  secrets_set: Record<string, boolean>;
  secrets_unreadable?: boolean;
  warnings: string[];
  created_ts: number;
  updated_ts: number;
};

export type TestStep = { name: string; ok: boolean; detail: string; hint: string };
export type TestReport = { ok: boolean; steps: TestStep[]; duration_ms: number };

export type Column = { name: string; type: string; nullable: boolean };
export type Dataset = { name: string; columns: Column[]; primary_key: string[]; supports_cdc: boolean };
export type SourceRecord = Record<string, unknown>;

// Layout v2: see docs/adr/0006-hospital-map.md. Old layouts (no floors) stay valid.
export type ZoneKind = "unit" | "room" | "bay" | "corridor" | "waiting" | "entrance";
export type Zone = {
  id: string;
  name: string;
  polygon: [number, number][];
  color?: string;
  floor_id?: string;
  kind?: ZoneKind;
  doors?: [number, number][];
};
export type FloorPlan = { asset_id: string; x: number; y: number; w: number; h: number; opacity?: number };
export type Floor = { id: string; name: string; level: number; width: number; depth: number; plan?: FloorPlan };
export type Entrance = { id: string; name: string; floor_id?: string; point: [number, number]; kind: "walk" | "ambulance" };
export type SiteLayout = { zones?: Zone[]; width?: number; depth?: number; floors?: Floor[]; entrances?: Entrance[] };
export type Site = {
  id: string;
  name: string;
  template: string;
  layout: SiteLayout;
  created_ts: number;
  updated_ts: number;
};

export type MappingConfig = {
  id_field: string;
  match_key?: string | null;
  fields: Record<string, string>;
  state_map?: Record<string, string>;
  attributes?: string[];
  kind?: string | null;
  filter?: RowFilter[];
};

export type RowFilter = {
  column: string;
  op: "eq" | "ne" | "in" | "not_in" | "is_null" | "not_null" | "gt" | "gte" | "lt" | "lte" | "contains";
  value?: unknown;
};

// GET /api/sources/{id}/suggestions?site_id= (docs/adr/0006-hospital-map.md)
export type AttachTarget = {
  dataset: string; // another suggestion in the list, or the dataset of mapping_id
  mapping_id: string | null; // an existing mapping on the site
  match_key: string;
};
export type Suggestion = {
  dataset: string;
  config: MappingConfig | null; // null: not suggested (reason says why)
  filter?: RowFilter[] | null; // same as config.filter
  reason: string;
  confidence: number; // 0..1
  attach_to?: AttachTarget | null;
};

export type Mapping = {
  id: string;
  site_id: string;
  source_id: string;
  dataset: string;
  config: MappingConfig;
  options: Record<string, unknown>;
  active: boolean;
  running: boolean;
  created_ts: number;
  updated_ts: number;
};

export type MappingHealth = {
  mapping_id: string;
  source_id: string;
  status: "starting" | "running" | "error" | "paused";
  last_event_ts: number | null;
  events_total: number;
  events_per_min: number;
  lag_ms_p95: number | null;
  skipped_records: number;
  last_error: string | null;
  last_error_hint: string | null;
  last_error_ts: number | null;
};

// WebSocket /ws/sites/{id}
export type Asset = {
  site_id: string;
  asset_id: string;
  updated_ts: number;
  zone?: string;
  state?: string;
  label?: string;
  kind?: string;
  attributes?: Record<string, unknown>;
  _sources: Record<string, string>;
  [field: string]: unknown;
};

export type StreamMessage = {
  type: "snapshot" | "upsert" | "remove" | "event" | "ping";
  site_id: string;
  assets: Asset[];
  event: Record<string, unknown> | null;
  ts: number;
};

// GET /api/health
export type AppHealth = { ok: boolean; version: string; portal_db?: "ok" | "unreachable" };

// POST /api/sites/{id}/plans (floor plan image; ADR 0006)
export type PlanUpload = { asset_id: string; width_px: number; height_px: number; content_type: string };

// POST /api/sources/{id}/upload
export type UploadResult = { dataset: string; bytes: number; rows: number; columns: string[] };

// POST /api/sites/{id}/layout/import (docs/adr/0007-hospital-view.md, "Layout import")
export type LayoutImportFormat = "auto" | "riverside" | "geojson-lite";
export type LayoutImportRequest = {
  source_id: string;
  path?: string;
  format: LayoutImportFormat;
  mode: "replace" | "merge";
  dry_run: boolean;
  options?: { root?: string };
};
export type LayoutImportSummary = {
  format: "riverside" | "geojson-lite";
  floors: number;
  zones: number;
  zones_by_kind: Record<string, number>;
  beds: number;
  kept_zones: number;
  removed_zones: number;
  warnings: string[];
  problems: string[]; // block saving; same rules as the layout editor
};
export type LayoutImportResult = { layout: SiteLayout; summary: LayoutImportSummary; saved: boolean };

// GET /api/sites/{id}/assets/{asset_id}/history (backend/app/api/history.py)
export type HistoryPlace = { zone_id: string | null; zone: string | null; bed: string | null; floor_id: string | null; floor: string | null };
export type HistoryKind = "arrived" | "move" | "status" | "task" | "left" | "update";
export type HistoryEntry = HistoryPlace & {
  ts: number;
  kind: HistoryKind;
  text: string;
  source: string | null;
  status: string | null; // plain words ("Waiting for provider")
  status_raw: unknown;
  changes: Record<string, [unknown, unknown]>;
  duration_s?: number;
  duration_text?: string; // "in ED-02 for 42 min"
  ongoing?: boolean;
  floor_change?: { from: string; to: string };
  task?: string; // attached record's label ("Cleaning task")
  task_status?: string | null;
};
export type HistoryMilestone = { key: string; label: string; ts: number; value: unknown; status: unknown; seen_ts: number };
export type AssetHistory = {
  site_id: string;
  asset_id: string;
  present: boolean;
  current: HistoryPlace | null;
  history_since: number | null; // Live Ops knows history from when it started watching
  retention_days: number;
  truncated: boolean;
  entries: HistoryEntry[];
  milestones: HistoryMilestone[];
  now: number;
};
