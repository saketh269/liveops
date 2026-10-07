# Changelog

All notable changes to Live Ops. Versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-07

First release. A live operations map that connects to the systems you already
have. Built from scratch in Sprint 0 and Sprint 1 (Jira epic LIVEOPS-1).

### Sources you can connect

| Source | How it updates | Tested against |
|---|---|---|
| PostgreSQL | Checks every few seconds | Real Postgres 16 |
| PostgreSQL (live changes) | Live, via logical replication (p95 ≈ 20 ms) | Real Postgres 16 |
| MySQL | Live via binlog (p95 ≈ 7 ms), or checks every few seconds | Real MySQL 8.0 |
| REST API (JSON) | Checks every few seconds; API key, bearer token or OAuth2 | Local test API |
| Webhook | Pushed live (signed with HMAC) | Real backend |
| CSV / Excel file | Upload in the UI; updates when you replace the file | Real files |
| S3 / object storage files | Checks for changed files | S3-compatible test server |
| Microsoft SQL Server | Checks, or live via Change Tracking | **Not yet tested on a real server** |
| Oracle Database | Checks every few seconds | **Not yet tested on a real server** |

### Features

- **Sources:** pick a source type, fill in a form, test the connection step by
  step with plain-English fixes, edit or delete. Passwords are encrypted at
  rest and never shown again.
- **Sites:** create sites from a template (hospital, warehouse, farm, delivery, generic).
- **Mapping studio:** preview a table, choose the ID, zone, state and label
  columns, translate state values, and set a match key to combine several
  sources into one asset.
- **Live 3D map:** zones, assets coloured by state, hover for details and which
  source set each value, KPI panel, event feed, layout editor, 2D fallback.
- **Health:** per mapping status, events per minute, lag p95, skipped rows and
  errors with hints.
- **Reliability:** stale assets are cleaned up after restarts, mappings restart
  with backoff after errors, and with Redis several backend processes share the
  work (one owner per mapping, automatic takeover).

### Security

- Read-only access to every source; injection attempts are refused.
- Encryption required by default. "Verify" checks the server certificate.
  Postgres refuses to send a password to a server that can't prove it knows it (SCRAM).
- Saved credentials are only sent to the server they were entered for.
- Local use only: the portal listens on 127.0.0.1 and answers only to local host names (ADR 0005).
- Guards against SSRF, zip bombs, oversized uploads and webhook replay.

### Known issues (planned for 0.1.1)

- **No sign-in yet.** Use on your own computer only.
- SQL Server and Oracle have only been tested with simulated drivers; their real
  tests run in GitHub Actions.
- 3D map measured at 13–16 fps with 2,000 assets on software graphics; the
  30 fps target needs confirming on a machine with a GPU.
- Remaining Jira bugs: LIVEOPS-49, 50, 51, 59, 68, 69, 70, 73, 76, 77, 78, 83,
  84, 85, 86, 94 (Low/Medium; none block local use).
- Container base images are pinned by tag, not digest (LIVEOPS-37).
- pymssql and psycopg are LGPL-licensed; include their license texts if you
  redistribute Live Ops.
