# ADR 0002: State store with per-field multi-source merge

Date: 2026-10-06 · Status: accepted

## Decision

Assets are keyed by `(site_id, asset_id)` where `asset_id` is the mapping's
match key value. Each field keeps value, source, mapping and timestamp. Latest
received value wins per field. Removing an asset in one mapping drops only that
mapping's fields.

`InMemoryStateStore` is the reference implementation (single process). A Redis
implementation (LIVEOPS-3) will hold the same semantics for multi-process
deployments and keep an append-only event log for Replay.

## Consequences

Combining sources needs no joins in the source systems. Complex cross-source
joins remain possible later through a federation connector (Zetaris, Trino).
