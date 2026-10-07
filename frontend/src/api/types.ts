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
  warnings: string[];
  created_ts: number;
  updated_ts: number;
};

export type TestStep = { name: string; ok: boolean; detail: string; hint: string };
export type TestReport = { ok: boolean; steps: TestStep[]; duration_ms: number };

export type Column = { name: string; type: string; nullable: boolean };
export type Dataset = { name: string; columns: Column[]; primary_key: string[]; supports_cdc: boolean };
export type SourceRecord = Record<string, unknown>;

export type Zone = { id: string; name: string; polygon: [number, number][]; color?: string };
export type SiteLayout = { zones?: Zone[]; width?: number; depth?: number };
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
  type: "snapshot" | "upsert" | "remove" | "event";
  site_id: string;
  assets: Asset[];
  event: Record<string, unknown> | null;
  ts: number;
};

// GET /api/health
export type AppHealth = { ok: boolean; version: string; portal_db?: "ok" | "unreachable" };
