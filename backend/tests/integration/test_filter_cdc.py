"""Row filter on a real Postgres logical-replication stream: rows updated into
and out of the filter appear and disappear on the map (ADR 0006)."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import psycopg
import pytest

from app.core.mapping import MappingConfig
from app.core.runner import MappingSpec, RunnerManager
from app.core.state import InMemoryStateStore
from tests.conftest import pg_params, requires_pg

pytestmark = [requires_pg, pytest.mark.integration]


@pytest.fixture
async def cdc_source(temp_database: str) -> AsyncIterator[dict[str, Any]]:
    p = pg_params()
    admin = psycopg.conninfo.make_conninfo(**{**p, "dbname": temp_database})
    server = psycopg.conninfo.make_conninfo(**{**p, "dbname": "postgres"})
    role, pub = f"lo_flt_{uuid.uuid4().hex[:8]}", f"lo_pub_{uuid.uuid4().hex[:8]}"
    async with await psycopg.AsyncConnection.connect(admin, autocommit=True) as c:
        await c.execute(
            "CREATE TABLE tasks (task_id serial PRIMARY KEY, bed_id text, status text NOT NULL, done_at timestamptz)"
        )
        await c.execute("INSERT INTO tasks (bed_id, status) VALUES ('B1', 'open')")
        await c.execute("INSERT INTO tasks (bed_id, status, done_at) VALUES ('B2', 'done', now())")
        await c.execute(f"CREATE ROLE {role} LOGIN REPLICATION PASSWORD 'pw'")
        await c.execute(f"GRANT SELECT ON tasks TO {role}")
        await c.execute(f"CREATE PUBLICATION {pub} FOR TABLE tasks")
    settings = {
        "host": p.get("host", "localhost"),
        "port": int(p.get("port", 5432)),
        "database": temp_database,
        "user": role,
        "encryption": "off",
        "publication": pub,
    }
    try:
        yield {"settings": settings, "admin": admin}
    finally:
        async with await psycopg.AsyncConnection.connect(admin, autocommit=True) as c:
            await c.execute(f"DROP OWNED BY {role}")  # its grants; the database itself is dropped by the fixture
        async with await psycopg.AsyncConnection.connect(server, autocommit=True) as c:
            await c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = %s", (role,))
            for _ in range(50):
                cur = await c.execute(
                    "SELECT slot_name, active FROM pg_replication_slots WHERE database = %s", (temp_database,)
                )
                slots = await cur.fetchall()
                if not slots:
                    break
                for name, active in slots:
                    if not active:
                        await c.execute("SELECT pg_drop_replication_slot(%s)", (name,))
                await asyncio.sleep(0.1)
            await c.execute(f"DROP ROLE IF EXISTS {role}")


async def test_cdc_filter_moves_rows_on_and_off_the_map(cdc_source: dict[str, Any]) -> None:
    config = MappingConfig.model_validate(
        {
            "id_field": "task_id",
            "match_key": "bed_id",
            "fields": {"state": "status"},
            "filter": [{"column": "done_at", "op": "is_null"}],
        }
    )
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    spec = MappingSpec(
        mapping_id="m",
        site_id="s",
        source_id="src",
        source_type="postgres_cdc",
        settings=cdc_source["settings"],
        secrets={"password": "pw"},
        dataset="public.tasks",
        config=config,
        options={},
    )

    async def state() -> dict[str, Any]:
        return {a.asset_id: a.flat().get("state") for a in await store.site_assets("s")}

    async def expect(want: dict[str, Any]) -> None:
        deadline = time.monotonic() + 10
        got: dict[str, Any] = {}
        while time.monotonic() < deadline:
            got = await state()
            if got == want:
                return
            await asyncio.sleep(0.05)
        raise AssertionError(f"expected {want}, got {got} (health {rm.health['m'].as_dict()})")

    async def run(sql: str) -> None:
        async with await psycopg.AsyncConnection.connect(cdc_source["admin"], autocommit=True) as c:
            await c.execute(sql)

    await rm.start(spec)
    try:
        await expect({"B1": "open"})  # B2's task is done: not in the initial state
        await run("UPDATE tasks SET status = 'done', done_at = now() WHERE bed_id = 'B1'")  # out of the filter
        await expect({})
        await run("UPDATE tasks SET status = 'reopened', done_at = NULL WHERE bed_id = 'B2'")  # into the filter
        await run("INSERT INTO tasks (bed_id, status) VALUES ('B3', 'open'), (NULL, 'open')")  # keyless: skipped
        await expect({"B2": "reopened", "B3": "open"})
        await run("DELETE FROM tasks WHERE bed_id = 'B3'")
        await expect({"B2": "reopened"})
        assert rm.health["m"].skipped_records == 0
    finally:
        await rm.stop_all()
