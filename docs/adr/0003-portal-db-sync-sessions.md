# ADR 0003: Synchronous SQLAlchemy for the portal database (v0.1)

Date: 2026-10-06 · Status: accepted, revisit at Phase 6

## Decision

The portal DB (sources, sites, mappings) uses synchronous SQLAlchemy 2.0
sessions. Queries are small and infrequent (configuration, not live data).
Live data never touches the portal DB; it flows connector → state store → WS.

## Consequences

Simple code and migrations now. If configuration traffic grows, move to the
async engine; the session dependency is the single seam.
