# ADR 0004: Snapshot marker, source id for connectors, no silent truncation

Date: 2026-10-07 · Status: accepted · Fixes: LIVEOPS-22, 23, 31, 34, 40, 42, 46

## Context

Sprint 1 review and QA found three gaps in the connector contract:

1. The runner could not tell when a connector's initial full state ended, so
   assets deleted while the backend was down (or ids that changed after a
   mapping edit) stayed on the map forever.
2. Connectors did not know which portal source they belong to, so the webhook
   connector keyed its buffer on a hash of the signing secret (two sources
   sharing a secret shared data).
3. A record with a NULL key stopped the whole stream, and poll snapshots were
   silently capped at 50,000 rows (missing rows looked like deletes).

## Decision

- `ChangeOp.SNAPSHOT_END`: every `stream()` yields exactly one marker right
  after the initial state (`snapshot_end(dataset)` helper; `PollingConnector`
  does it automatically). On the marker the runner calls
  `StateStore.reconcile(site, mapping, keep=ids_seen)`, removing that mapping's
  fields from assets not in the snapshot.
- Connectors are constructed with `source_id=` (keyword, may be `None` in tests)
  and expose it as `self.source_id`. Push and file connectors key their data on it.
- Records without a key value are skipped and counted in
  `connector.skipped_records` (shown on the Health page). Never fatal.
- Poll snapshots must be complete or raise: fetch `cap + 1`, call
  `check_row_cap()`. The error tells the user to map a filtered view or use CDC.
- Minimum poll interval 0.5 s, enforced by the API and `PollingConnector`.

The contract kit checks the marker and keyless-row behaviour for every connector.

## Consequences

Connectors that override `stream()` (postgres_cdc, mysql cdc, sqlserver change
tracking, webhook) must emit the marker. Mapping edits clear the old fields and
rebuild from the new snapshot.
