# How we work

This repo is built by a tech lead and a team of agents. Everyone follows the
same process.

## Flow for every ticket

1. **Read the ticket** in Jira (project LIVEOPS). The ticket is the instructions.
2. **Branch** from `main`: `feat/<short-name>` or `fix/<short-name>`.
3. **Comment on the ticket** when you start: `[agent-name] Started. Branch feat/x. Plan: ...`
   and move it to **In Progress**.
4. Build it with tests. Keep changes inside your area (see ownership below).
5. Run **all** checks locally (below). Do not hand over red checks.
6. Commit with a clear message (`feat(connectors): add MySQL binlog CDC`).
7. Comment on the ticket: what was built, files changed, test results with
   numbers, anything not done. Move it to **In Review**.
8. Review/security/QA comments come back on the ticket. Fix, re-run checks,
   comment again.
9. The tech lead merges to `main`. Nobody else merges.

## Checks (all must pass)

```bash
# backend
cd backend
pip install -e ".[dev]"
export LIVEOPS_TEST_PG_DSN=postgresql://postgres:postgres@localhost:5432/postgres
ruff check . && ruff format --check . && mypy app && pytest -q

# frontend
cd frontend
npm ci && npm run typecheck && npm run lint && npm test && npm run build
```

## Ownership (Sprint 1)

| Area | Owner |
|---|---|
| `backend/app/connectors/base.py`, `registry.py`, `docs/design.md`, `tests/contract/kit.py` | tech lead (changes need an ADR) |
| `backend/app/core/state.py`, new `core/redis_state.py`, `core/eventlog.py`, `api/stream.py` | agent-core |
| `backend/app/connectors/postgres_cdc.py`, `mysql.py` | agent-db |
| `backend/app/connectors/sqlserver.py`, `oracle.py` | agent-enterprise-db |
| `backend/app/connectors/rest.py`, `webhook.py`, `files.py`, `api/webhooks.py` | agent-api |
| `frontend/src/pages/{Sources,Sites,Mapping,Health}Page.tsx`, `frontend/src/components/forms/` | agent-frontend-app |
| `frontend/src/pages/LiveMapPage.tsx`, `frontend/src/map/` | agent-frontend-3d |

Shared files (`app/connectors/__init__.py`, `pyproject.toml`, `package.json`,
`api/types.ts`): append only, keep edits minimal so merges stay clean.

## Rules

- Follow `docs/design.md`. If the contract does not fit, stop and write it on
  the ticket; don't change the contract on your own.
- Never commit secrets or `.env`.
- Never claim something is tested if it was not run against a real system. Say
  "needs real test" instead.
- Every user-facing message says what went wrong and how to fix it.
