"""PostgreSQL connector, poll mode. This is the reference connector: copy its
structure when writing a new one.

Safety:
- Every session is forced read-only (``default_transaction_read_only``).
- Dataset names are only accepted if ``discover()`` returned them, and are
  quoted with ``psycopg.sql.Identifier`` — never string-formatted.
- Encryption defaults to ``require``.
"""

from __future__ import annotations

import time
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from app.connectors.base import (
    Category,
    Column,
    ConnectorError,
    ConnectorSpec,
    Dataset,
    Mode,
    PollingConnector,
    Record,
    TestReport,
    TestStep,
    normalize_record,
)
from app.connectors.registry import register

SSL_MODES = {"required": "require", "verify": "verify-full", "off": "disable"}
MAX_ROWS = 50_000  # poll-mode safety cap per dataset


@register
class PostgresConnector(PollingConnector):
    spec = ConnectorSpec(
        type="postgres",
        display_name="PostgreSQL",
        category=Category.DATABASE,
        modes=[Mode.POLL],
        description="Reads tables and views from PostgreSQL 12+ with a read-only user.",
        maturity="stable",
        settings_schema={
            "type": "object",
            "required": ["host", "port", "database", "user"],
            "properties": {
                "host": {"type": "string", "title": "Host", "examples": ["db.example.com"]},
                "port": {"type": "integer", "title": "Port", "default": 5432},
                "database": {"type": "string", "title": "Database"},
                "user": {"type": "string", "title": "Read-only user"},
                "encryption": {
                    "type": "string",
                    "title": "Encryption",
                    "enum": ["required", "verify", "off"],
                    "default": "required",
                    "description": "Use 'off' only for local testing.",
                },
                "schemas": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Schemas to list",
                    "default": ["public"],
                },
            },
        },
        secrets_schema={
            "type": "object",
            "required": ["password"],
            "properties": {"password": {"type": "string", "title": "Password", "format": "password"}},
        },
    )

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any]) -> None:
        super().__init__(settings, secrets)
        self._conn: psycopg.AsyncConnection[dict[str, Any]] | None = None
        self._datasets: dict[str, Dataset] | None = None

    # -- connection -------------------------------------------------------

    def _conninfo(self) -> dict[str, Any]:
        s = self.settings
        return {
            "host": s["host"],
            "port": int(s.get("port", 5432)),
            "dbname": s["database"],
            "user": s["user"],
            "password": self.secrets.get("password", ""),
            "sslmode": SSL_MODES.get(s.get("encryption", "required"), "require"),
            "connect_timeout": 10,
            "application_name": "liveops",
            "options": "-c default_transaction_read_only=on -c statement_timeout=15000",
        }

    async def _connect(self) -> psycopg.AsyncConnection[dict[str, Any]]:
        if self._conn is None or self._conn.closed:
            self._conn = await psycopg.AsyncConnection.connect(
                **self._conninfo(), autocommit=True, row_factory=dict_row
            )
        return self._conn

    async def close(self) -> None:
        if self._conn is not None and not self._conn.closed:
            await self._conn.close()
        self._conn = None

    # -- contract ---------------------------------------------------------

    async def test(self) -> TestReport:
        started = time.monotonic()
        steps: list[TestStep] = []
        try:
            conn = await self._connect()
            steps.append(
                TestStep(
                    name="Reach the server",
                    ok=True,
                    detail=f"{self.settings['host']}:{self.settings.get('port', 5432)}",
                )
            )
        except psycopg.OperationalError as e:
            msg = str(e).strip().splitlines()[0] if str(e).strip() else "connection failed"
            hint = _connection_hint(msg, self.settings.get("encryption", "required"))
            steps.append(TestStep(name="Reach the server", ok=False, detail=msg, hint=hint))
            return TestReport.from_steps(steps, started)

        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT version() AS v, current_user AS u, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
            )
            row = await cur.fetchone() or {}
            steps.append(TestStep(name="Sign in", ok=True, detail=f"as {row.get('u', self.settings['user'])}"))
            enc = bool(row.get("ssl"))
            want = self.settings.get("encryption", "required")
            steps.append(
                TestStep(
                    name="Encryption",
                    ok=enc or want == "off",
                    detail="encrypted (TLS)" if enc else "not encrypted",
                    hint="" if enc or want == "off" else "Turn on TLS on the server.",
                )
            )
            await cur.execute("SHOW transaction_read_only")
            ro = (await cur.fetchone() or {}).get("transaction_read_only") == "on"
            steps.append(TestStep(name="Read-only session", ok=ro, detail="on" if ro else "off"))
        try:
            ds = await self.discover()
            steps.append(
                TestStep(
                    name="List tables",
                    ok=bool(ds),
                    detail=f"{len(ds)} tables or views readable",
                    hint="" if ds else "Grant SELECT on the tables you want to show, or check the schema list.",
                )
            )
        except psycopg.Error as e:
            steps.append(TestStep(name="List tables", ok=False, detail=str(e).splitlines()[0]))
        return TestReport.from_steps(steps, started)

    async def discover(self) -> list[Dataset]:
        conn = await self._connect()
        schemas = self.settings.get("schemas") or ["public"]
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                WHERE c.table_schema = ANY(%s)
                  AND has_table_privilege(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), 'SELECT')
                ORDER BY c.table_schema, c.table_name, c.ordinal_position
                """,
                (schemas,),
            )
            cols = await cur.fetchall()
            await cur.execute(
                """
                SELECT n.nspname AS s, c.relname AS t, a.attname AS col
                FROM pg_index i
                JOIN pg_class c ON c.oid = i.indrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
                WHERE i.indisprimary AND n.nspname = ANY(%s)
                """,
                (schemas,),
            )
            pks = await cur.fetchall()
        pk_map: dict[str, list[str]] = {}
        for p in pks:
            pk_map.setdefault(f"{p['s']}.{p['t']}", []).append(p["col"])
        out: dict[str, Dataset] = {}
        for c in cols:
            name = f"{c['table_schema']}.{c['table_name']}"
            d = out.setdefault(name, Dataset(name=name, columns=[], primary_key=pk_map.get(name, [])))
            d.columns.append(Column(name=c["column_name"], type=c["data_type"], nullable=c["is_nullable"] == "YES"))
        self._datasets = out
        return list(out.values())

    async def snapshot(self, dataset: str) -> list[Record]:
        schema, table = await self._resolve(dataset)
        conn = await self._connect()
        query = sql.SQL("SELECT * FROM {}.{} LIMIT {}").format(
            sql.Identifier(schema), sql.Identifier(table), sql.Literal(MAX_ROWS)
        )
        async with conn.cursor() as cur:
            await cur.execute(query)
            rows = await cur.fetchall()
        return [normalize_record(r) for r in rows]

    # -- helpers ----------------------------------------------------------

    async def _resolve(self, dataset: str) -> tuple[str, str]:
        if self._datasets is None or dataset not in self._datasets:
            await self.discover()
        assert self._datasets is not None
        if dataset not in self._datasets:
            raise ConnectorError(
                f"Table {dataset!r} isn't readable with this user",
                hint="Check the table name and that the user has SELECT on it.",
            )
        schema, _, table = dataset.partition(".")
        return schema, table


def _connection_hint(message: str, encryption: str) -> str:
    m = message.lower()
    if "ssl" in m and ("not support" in m or "refused" in m) and encryption != "off":
        return (
            "The server doesn't accept encrypted connections. "
            "Turn TLS on, or set Encryption to Off for local testing only."
        )
    if "password authentication failed" in m:
        return "Check the user name and password."
    if "could not translate host name" in m or "name or service not known" in m:
        return (
            "Check the host name. From Docker on Windows or Mac, "
            "use host.docker.internal for a database on your own computer."
        )
    if "connection refused" in m or "timeout" in m:
        return "Check the host and port, and that a firewall allows the connection."
    if "does not exist" in m:
        return "Check the database name."
    return ""
