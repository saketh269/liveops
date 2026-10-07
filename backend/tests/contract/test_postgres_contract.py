from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import psycopg
import pytest

from app.connectors.base import Connector
from app.connectors.postgres import PostgresConnector
from tests.conftest import pg_params, requires_pg
from tests.contract.kit import SEED_ROWS, ConnectorContract


class PgDriver:
    def __init__(self, dbname: str) -> None:
        self.dbname = dbname
        self.dataset = "public.assets"
        p = pg_params()
        self.admin = {**p, "dbname": dbname}
        self.role = f"lo_reader_{uuid.uuid4().hex[:8]}"  # roles are cluster-wide: keep unique

    async def setup(self) -> None:
        async with await psycopg.AsyncConnection.connect(**self.admin, autocommit=True) as c:
            await c.execute(
                """CREATE TABLE assets (id text PRIMARY KEY, status text, zone text,
                   updated_at timestamptz DEFAULT now(), amount numeric(10,2) DEFAULT 1.50, blob bytea)"""
            )
            for r in SEED_ROWS:
                await c.execute(
                    "INSERT INTO assets (id, status, zone) VALUES (%s, %s, %s)", (r["id"], r["status"], r["zone"])
                )
            await c.execute(f"CREATE ROLE {self.role} LOGIN PASSWORD 'reader_pw'")
            await c.execute(f'GRANT CONNECT ON DATABASE "{self.dbname}" TO {self.role}')
            await c.execute(f"GRANT USAGE ON SCHEMA public TO {self.role}")
            await c.execute(f"GRANT SELECT ON assets TO {self.role}")

    async def teardown(self) -> None:
        async with await psycopg.AsyncConnection.connect(**{**self.admin, "dbname": "postgres"}, autocommit=True) as c:
            await c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = %s", (self.role,))
        async with await psycopg.AsyncConnection.connect(**self.admin, autocommit=True) as c:
            await c.execute(f"REVOKE ALL ON assets FROM {self.role}")
            await c.execute(f"REVOKE ALL ON SCHEMA public FROM {self.role}")
            await c.execute(f'REVOKE ALL ON DATABASE "{self.dbname}" FROM {self.role}')
        async with await psycopg.AsyncConnection.connect(**{**self.admin, "dbname": "postgres"}, autocommit=True) as c:
            await c.execute(f"DROP ROLE IF EXISTS {self.role}")

    async def _exec(self, q: str, params: tuple[Any, ...]) -> None:
        async with await psycopg.AsyncConnection.connect(**self.admin, autocommit=True) as c:
            await c.execute(q, params)

    async def insert(self, row: dict[str, Any]) -> None:
        await self._exec(
            "INSERT INTO assets (id, status, zone) VALUES (%s, %s, %s)", (row["id"], row["status"], row["zone"])
        )

    async def update(self, key: str, changes: dict[str, Any]) -> None:
        await self._exec("UPDATE assets SET status = %s, updated_at = now() WHERE id = %s", (changes["status"], key))

    async def delete(self, key: str) -> None:
        await self._exec("DELETE FROM assets WHERE id = %s", (key,))

    def settings(self) -> dict[str, Any]:
        p = pg_params()
        return {
            "host": p.get("host", "localhost"),
            "port": int(p.get("port", 5432)),
            "database": self.dbname,
            "user": self.role,
            "encryption": "off",
        }


@requires_pg
class TestPostgresContract(ConnectorContract):
    latency_budget_s = 5.0

    @pytest.fixture
    async def driver(self, temp_database: str) -> AsyncIterator[PgDriver]:
        d = PgDriver(temp_database)
        await d.setup()
        try:
            yield d
        finally:
            await d.teardown()

    def make_connector(self, driver: PgDriver) -> Connector:  # type: ignore[override]
        return PostgresConnector(driver.settings(), {"password": "reader_pw"})

    def make_bad_connector(self, driver: PgDriver) -> Connector:  # type: ignore[override]
        return PostgresConnector(driver.settings(), {"password": "wrong-password"})

    async def test_session_is_read_only(self, driver: PgDriver) -> None:
        c = PostgresConnector(driver.settings(), {"password": "reader_pw"})
        try:
            conn = await c._connect()
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                await conn.execute("CREATE TEMP TABLE t (x int)")
        finally:
            await c.close()

    async def test_unknown_table_is_rejected(self, driver: PgDriver) -> None:
        from app.connectors.base import ConnectorError

        c = PostgresConnector(driver.settings(), {"password": "reader_pw"})
        try:
            with pytest.raises(ConnectorError):
                await c.preview('public.assets"; DROP TABLE assets; --')
        finally:
            await c.close()
