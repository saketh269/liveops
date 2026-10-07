# Live Ops: design

Status: **frozen for Sprint 1**, amended by ADR 0004 and 0005 (changes need a decision record in `docs/adr/`).
Owner: tech lead. Ticket: LIVEOPS-2.

## 1. What we are building

A web portal that shows a company's operations live on a 3D map, fed by **any**
data source they already have. A hospital sees beds turn from free to in use as
the EHR changes; a warehouse sees trucks dock as the WMS updates.

The product promise: connect a source, map its records to things on the map,
and watch them move, without copying the data into a warehouse first.

## 2. Architecture

```
 Source systems                 Live Ops backend (FastAPI)                     Browser
 ┌──────────────┐   Connector   ┌─────────┐   Mapping   ┌─────────────┐  WS   ┌──────────┐
 │ Postgres     │──────────────▶│ Change  │────────────▶│ State store │──────▶│ Live map │
 │ MySQL, APIs  │  poll / CDC / │ stream  │ AssetEvent  │ (merge by   │       │ (3D)     │
 │ files, ...   │  push         └─────────┘             │  asset id)  │       └──────────┘
 └──────────────┘                                       └─────────────┘
                     Portal DB (Postgres): sources, sites, mappings (Alembic)
```

Data flows one way. Live Ops **only reads** from sources.

| Layer | Code | Notes |
|---|---|---|
| Connector SDK | `backend/app/connectors/base.py` | The contract below |
| Connectors | `backend/app/connectors/*.py` | One module per source type, registered with `@register` |
| Mapping | `backend/app/core/mapping.py` | Change → AssetEvent |
| State store | `backend/app/core/state.py` | Current asset state, multi-source merge, pub/sub |
| Runner | `backend/app/core/runner.py` | One task per active mapping, retries with backoff, health |
| API | `backend/app/api/*.py` | REST + WebSocket `/ws/sites/{id}` |
| Portal DB | `backend/app/db.py`, `migrations/` | Our own config only, never customer data |
| Front end | `frontend/src` | React + TypeScript + Vite; Three.js for the map |

## 3. The connector contract

Every source implements `Connector` (`app/connectors/base.py`). It is constructed as `Connector(settings, secrets, source_id=...)`; `self.source_id` identifies the portal source (ADR 0004).

| Method | Must do |
|---|---|
| `spec` (class attribute) | `ConnectorSpec`: type id, display name, category, modes, JSON Schema for settings, separate JSON Schema for secrets, honest `maturity` |
| `test()` | Check reachability, sign-in, encryption, read-only, permissions. One `TestStep` per check, each failed step with `detail` and a plain-English `hint`. **Never raises. Never includes secret values.** |
| `discover()` | List readable datasets (tables, views, endpoints, files) with columns and key columns |
| `preview(dataset, limit)` | Up to `limit` records, already JSON-safe |
| `stream(dataset, key_fields, options)` | Async iterator of `Change`. First the full current state as `UPSERT`s, then **exactly one `SNAPSHOT_END` marker**, then only differences (`UPSERT` / `DELETE`) forever. Rows without a key are skipped and counted in `skipped_records` (ADR 0004) |
| `health()` | Optional; default runs `test()` |
| `close()` | Release connections; safe to call twice |

Modes:

- **poll**: subclass `PollingConnector`, implement `snapshot(dataset)`; diffing and the loop are provided. Default interval 3 s (`options.poll_interval_s`).
- **cdc**: override `stream()` to read the change log (Postgres logical replication, MySQL binlog, SQL Server change tracking). Must still emit the initial state first.
- **push**: webhooks and streams. Override `stream()` reading from an internal queue the API feeds.

Rules for every connector:

1. **Read-only.** Force read-only sessions where the source supports it. Never issue writes.
2. **No string-built queries.** Dataset names are accepted only if `discover()` returned them; identifiers are quoted by the driver's identifier API.
3. **Encryption on by default.** Setting values: `required` (default), `verify`, `off` (local testing only; the API warns).
4. **JSON-safe records.** Run every row through `normalize_record()` (handles datetime, Decimal, UUID, bytes, NaN).
5. **Secrets stay secret.** Only in `secrets_schema`, never logged, never in reports, errors or API responses.
6. **Bounded.** Timeouts on connect and queries. Poll snapshots are complete or raise (`check_row_cap`), never silently truncated. Poll interval ≥ 0.5 s.
7. **Passes the contract kit** in `backend/tests/contract/kit.py` against a real system.

## 4. Event format

`Change` (connector output) → `AssetEvent` (after mapping) → merged `Asset` (state store) → `StreamMessage` (WebSocket).

```jsonc
// StreamMessage on /ws/sites/{site_id}
{"type": "snapshot" | "upsert" | "remove" | "event",
 "site_id": "a1b2",
 "assets": [{"asset_id": "B01", "state": "in_use", "zone": "ICU", "kind": "bed",
             "label": "Bed 01", "attributes": {...}, "updated_ts": 1791350000.1,
             "_sources": {"state": "<source id>", "zone": "<source id>"}}],
 "event": null,
 "ts": 1791350000.2}
```

`type: "event"` messages carry `event = {"asset_id", "text", "source_id", "ts", "changes": {field: [old, new]}}`.
`type: "ping"` is sent every 20 s as a keepalive; clients ignore it (it is not a data update).
Clients must ignore message types they don't know.

Reserved asset fields: `zone`, `state`, `label`, `kind`, `x`, `y`. Anything else goes in `attributes` or as an extra merged field.

## 5. Mapping and multi-source merge

A mapping ties one dataset of one source to one site:

```json
{"id_field": "bed_id", "match_key": "bed_id",
 "fields": {"zone": "unit", "state": "status", "label": "bed_label"},
 "state_map": {"occupied": "in_use"}, "attributes": ["patient_count"], "kind": "bed"}
```

The asset id is the value of `match_key` (default `id_field`). Two mappings on
the same site whose records share that value **merge into one asset**: e.g. the
EHR gives `state`, housekeeping gives `cleaning`. Each field remembers which
source set it. Merge rule v0.1: latest received value per field wins; removing
from one source drops only that source's fields.

## 6. State store interface

`StateStore.apply(event)`, `site_assets(site_id)`, `subscribe(site_id)`
(snapshot then live), `clear_mapping(site_id, mapping_id)`. `InMemoryStateStore`
is the reference; the Redis implementation (LIVEOPS-3) must pass the same unit
tests.

## 7. API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/connectors` | Specs for the source picker and forms |
| GET/POST | `/api/sources` | List / add (secrets encrypted, masked in responses) |
| GET/PUT/DELETE | `/api/sources/{id}` | Read / edit (omitted secrets are kept) / remove |
| POST | `/api/sources/{id}/test` | Run `test()` |
| GET | `/api/sources/{id}/datasets` | `discover()` |
| GET | `/api/sources/{id}/preview?dataset=` | `preview()` |
| GET/POST, GET/PUT/DELETE | `/api/sites`, `/api/sites/{id}` | Sites with `layout.zones` |
| GET/POST, PUT/DELETE | `/api/mappings`, `/api/mappings/{id}` | Mappings; validated against real columns; `active` starts/stops |
| GET | `/api/health`, `/api/health/mappings` | App and per-mapping health (lag p95, events/min, last error + hint) |
| GET | `/api/sites/{id}/assets` | Current assets |
| WS | `/ws/sites/{id}` | Live stream |

## 8. Targets

| Target | Value |
|---|---|
| Source change → browser | < 10 s p95 (poll), < 2 s p95 (CDC/push) |
| Scale v0.1 | 50 sites, 2,000 assets per site, 100 viewers |
| Map rendering | 30+ fps at 2,000 assets on a 2022 laptop |

## 9. Testing environment note

The build workspace cannot pull container images, so local tests use native
Postgres 16, MySQL 8 and Redis. SQL Server and Oracle are tested only in GitHub
Actions service containers; until those pass, their specs say
`maturity="needs_real_test"`.
