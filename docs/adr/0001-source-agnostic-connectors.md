# ADR 0001: Source-agnostic connector framework

Date: 2026-10-06 · Status: accepted

## Context

The first prototype read only from Zetaris views. The product must connect to
any operational source: relational databases, warehouses, APIs, files and
streams.

## Decision

One `Connector` contract (`test`, `discover`, `preview`, `stream`, `health`,
`close`) with three modes (poll, CDC, push). Everything after the connector
sees only `Change` objects. Zetaris and Trino become connectors like any other.

## Consequences

- New sources are added without touching mapping, state or UI code.
- Poll connectors get diffing for free; CDC/push connectors must also emit the
  initial state first.
- A shared contract kit enforces identical behaviour across connectors.
