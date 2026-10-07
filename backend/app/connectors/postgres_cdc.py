"""PostgreSQL connector, live change capture (CDC) through logical replication.

How it streams one table:

1. Open a replication connection (psycopg2 ``LogicalReplicationConnection``)
   and create a **temporary** ``pgoutput`` slot with ``EXPORT_SNAPSHOT``.
2. On a normal read-only connection, import that snapshot and read the table
   once. Those rows are emitted as UPSERTs; they are exactly the state at the
   slot's start point, so no change is lost or applied twice.
3. Start replication from the slot. A worker thread only moves raw messages
   from the socket into an asyncio queue; decoding happens on the event loop
   (tiny per message). INSERT/UPDATE become UPSERT, DELETE and TRUNCATE become
   DELETE, each with ``source_ts`` = the transaction's commit time.

The table is never re-read after the first snapshot.

Safety:
- Replication only reads. The snapshot session is forced read-only.
- Dataset names are only accepted if ``discover()`` returned them and are
  quoted with ``psycopg.sql.Identifier``.
- The slot is temporary: Postgres drops it when the replication connection
  ends, including when this process dies. ``close()`` ends it explicitly.
- Encryption defaults to ``require``.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import select
import struct
import threading
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import psycopg
import psycopg2
import psycopg2.extras
from psycopg import sql
from psycopg.abc import Transformer as LoaderContext
from psycopg.adapt import Transformer
from psycopg.pq import Format
from psycopg.rows import dict_row

from app.connectors.base import (
    Category,
    Change,
    ChangeOp,
    Column,
    Connector,
    ConnectorError,
    ConnectorSpec,
    Dataset,
    Mode,
    Record,
    TestReport,
    TestStep,
    normalize_record,
    normalize_value,
    record_key,
)
from app.connectors.postgres import _connection_hint
from app.connectors.registry import register

log = logging.getLogger("liveops.connectors.postgres_cdc")

SSL_MODES = {"required": "require", "verify": "verify-full", "off": "disable"}
MAX_ROWS = 100_000  # initial-state cap; the key cache below is bounded by it
QUEUE_SIZE = 10_000  # replication messages buffered before the reader waits
PG_EPOCH = dt.datetime(2000, 1, 1, tzinfo=dt.UTC).timestamp()


@register
class PostgresCdcConnector(Connector):
    spec = ConnectorSpec(
        type="postgres_cdc",
        display_name="PostgreSQL (live changes)",
        category=Category.DATABASE,
        modes=[Mode.CDC],
        description=(
            "Streams row changes from PostgreSQL 12+ as they commit, using logical replication. "
            "Needs wal_level=logical, a user with the REPLICATION attribute and a publication."
        ),
        maturity="beta",
        settings_schema={
            "type": "object",
            "required": ["host", "port", "database", "user", "publication"],
            "properties": {
                "host": {"type": "string", "title": "Host", "examples": ["db.example.com"]},
                "port": {"type": "integer", "title": "Port", "default": 5432},
                "database": {"type": "string", "title": "Database"},
                "user": {"type": "string", "title": "User with REPLICATION and SELECT"},
                "publication": {
                    "type": "string",
                    "title": "Publication",
                    "default": "liveops",
                    "description": "Created by an admin: CREATE PUBLICATION liveops FOR TABLE public.my_table;",
                },
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
        self._pumps: set[_ReplicationPump] = set()
        # Instrumentation for tests and health: how often the full table was read.
        self.snapshot_queries = 0
        self.last_slot_name: str | None = None

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
        pumps, self._pumps = list(self._pumps), set()
        for p in pumps:
            await p.stop()
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
            msg = _first_line(e, "connection failed")
            hint = _connection_hint(msg, self.settings.get("encryption", "required"))
            steps.append(TestStep(name="Reach the server", ok=False, detail=msg, hint=hint))
            return TestReport.from_steps(steps, started)

        try:
            await self._test_server(conn, steps)
        except psycopg.Error as e:
            steps.append(TestStep(name="Read server settings", ok=False, detail=_first_line(e, "query failed")))
            return TestReport.from_steps(steps, started)
        steps.append(await asyncio.to_thread(self._test_replication_connection))
        return TestReport.from_steps(steps, started)

    async def _test_server(self, conn: psycopg.AsyncConnection[dict[str, Any]], steps: list[TestStep]) -> None:
        user = self.settings["user"]
        async with conn.cursor() as cur:
            await cur.execute("SELECT current_user AS u, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
            row = await cur.fetchone() or {}
            steps.append(TestStep(name="Sign in", ok=True, detail=f"as {row.get('u', user)}"))
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

            await cur.execute("SHOW wal_level")
            wal = (await cur.fetchone() or {}).get("wal_level", "")
            steps.append(
                TestStep(
                    name="Logical replication enabled",
                    ok=wal == "logical",
                    detail=f"wal_level = {wal}",
                    hint=""
                    if wal == "logical"
                    else (
                        "Ask your DBA to set wal_level = logical in postgresql.conf (on RDS/Aurora: "
                        "rds.logical_replication = 1 in the parameter group) and restart the server."
                    ),
                )
            )

            await cur.execute("SELECT rolreplication, rolsuper FROM pg_roles WHERE rolname = current_user")
            r = await cur.fetchone() or {}
            can_replicate = bool(r.get("rolreplication") or r.get("rolsuper"))
            steps.append(
                TestStep(
                    name="Replication permission",
                    ok=can_replicate,
                    detail="user has REPLICATION" if can_replicate else "user lacks the REPLICATION attribute",
                    hint=""
                    if can_replicate
                    else f"Run as an admin: ALTER ROLE {_quote_ident(user)} WITH REPLICATION;"
                    " (on RDS: GRANT rds_replication TO the user).",
                )
            )

            await cur.execute(
                "SELECT current_setting('max_replication_slots')::int"
                " - (SELECT count(*) FROM pg_replication_slots) AS free"
            )
            free = int((await cur.fetchone() or {}).get("free", 0))
            steps.append(
                TestStep(
                    name="Free replication slot",
                    ok=free > 0,
                    detail=f"{free} free",
                    hint="" if free > 0 else "Raise max_replication_slots or drop unused slots (pg_replication_slots).",
                )
            )

        steps.append(await self._publication_step())

    async def _publication_step(self) -> TestStep:
        pub = self.settings.get("publication") or ""
        schemas = self.settings.get("schemas") or ["public"]
        example = f"CREATE PUBLICATION {_quote_ident(pub or 'liveops')} FOR TABLE {schemas[0]}.your_table;"
        if not pub:
            return TestStep(
                name="Publication",
                ok=False,
                detail="no publication name set",
                hint=f"Ask an admin to run: {example} Then enter its name in the Publication setting.",
            )
        conn = await self._connect()
        async with conn.cursor() as cur:
            await cur.execute("SELECT pubinsert, pubupdate, pubdelete FROM pg_publication WHERE pubname = %s", (pub,))
            p = await cur.fetchone()
            if p is None:
                return TestStep(
                    name="Publication",
                    ok=False,
                    detail=f"publication {pub!r} does not exist in database {self.settings['database']!r}",
                    hint=f"Ask an admin to run (in this database): {example}",
                )
            covered = await self._published_tables(pub)
        datasets = {d.name for d in await self.discover()}
        readable = sorted(covered & datasets)
        missing_ops = [op for op in ("insert", "update", "delete") if not p[f"pub{op}"]]
        if not readable:
            return TestStep(
                name="Publication",
                ok=False,
                detail=f"publication {pub!r} covers no table this user can read",
                hint=(
                    f"Add your table: ALTER PUBLICATION {_quote_ident(pub)} ADD TABLE schema.your_table; "
                    "and GRANT SELECT on it to this user."
                ),
            )
        if missing_ops:
            return TestStep(
                name="Publication",
                ok=False,
                detail=f"publication {pub!r} does not publish: {', '.join(missing_ops)}",
                hint=f"Run: ALTER PUBLICATION {_quote_ident(pub)} SET (publish = 'insert, update, delete, truncate');",
            )
        shown = ", ".join(readable[:5]) + (" ..." if len(readable) > 5 else "")
        return TestStep(name="Publication", ok=True, detail=f"{pub!r} covers {len(readable)} table(s): {shown}")

    def _test_replication_connection(self) -> TestStep:
        name = "Open a replication connection"
        try:
            rc = psycopg2.connect(**self._conninfo(), connection_factory=psycopg2.extras.LogicalReplicationConnection)
        except psycopg2.OperationalError as e:
            msg = _first_line(e, "replication connection failed")
            hint = _connection_hint(msg, self.settings.get("encryption", "required"))
            if "pg_hba" in msg or "replication connection" in msg:
                hint = (
                    "The server refuses replication connections from here. Add a line like "
                    "'hostssl replication <user> <your network> scram-sha-256' to pg_hba.conf and reload."
                )
            return TestStep(name=name, ok=False, detail=msg, hint=hint)
        try:
            with rc.cursor() as cur:
                cur.execute("IDENTIFY_SYSTEM")
                cur.fetchone()
            return TestStep(name=name, ok=True, detail="replication protocol available")
        except psycopg2.Error as e:
            return TestStep(name=name, ok=False, detail=_first_line(e, "IDENTIFY_SYSTEM failed"))
        finally:
            rc.close()

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
                WHERE c.table_schema = ANY(%s) AND t.table_type = 'BASE TABLE'
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
                ORDER BY array_position(i.indkey, a.attnum)
                """,
                (schemas,),
            )
            pks = await cur.fetchall()
        pub = self.settings.get("publication") or ""
        covered = await self._published_tables(pub) if pub else set()
        pk_map: dict[str, list[str]] = {}
        for p in pks:
            pk_map.setdefault(f"{p['s']}.{p['t']}", []).append(p["col"])
        out: dict[str, Dataset] = {}
        for c in cols:
            name = f"{c['table_schema']}.{c['table_name']}"
            d = out.setdefault(
                name,
                Dataset(name=name, columns=[], primary_key=pk_map.get(name, []), supports_cdc=name in covered),
            )
            d.columns.append(Column(name=c["column_name"], type=c["data_type"], nullable=c["is_nullable"] == "YES"))
        self._datasets = out
        return list(out.values())

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        schema, table = await self._resolve(dataset)
        conn = await self._connect()
        query = sql.SQL("SELECT * FROM {}.{} LIMIT {}").format(
            sql.Identifier(schema), sql.Identifier(table), sql.Literal(max(0, min(int(limit), 1000)))
        )
        async with conn.cursor() as cur:
            await cur.execute(query)
            rows = await cur.fetchall()
        return [normalize_record(r) for r in rows]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        schema, table = await self._resolve(dataset)
        ds = (self._datasets or {})[dataset]
        pub = self.settings.get("publication") or ""
        if not ds.supports_cdc:
            raise ConnectorError(
                f"Table {dataset} is not in publication {pub!r}, so its changes can't be streamed",
                hint=(
                    f"Ask an admin to run: ALTER PUBLICATION {_quote_ident(pub or 'liveops')} ADD TABLE "
                    f"{_quote_ident(schema)}.{_quote_ident(table)};"
                    if pub
                    else f"Ask an admin to run: CREATE PUBLICATION liveops FOR TABLE "
                    f"{_quote_ident(schema)}.{_quote_ident(table)}; and set Publication to liveops."
                ),
            )
        conn = await self._connect()
        loop = asyncio.get_running_loop()
        pump = _ReplicationPump(self._conninfo(), pub, loop)
        self._pumps.add(pump)
        try:
            snapshot_name = await asyncio.to_thread(pump.open)
            self.last_slot_name = pump.slot
            decoder = _Decoder(dataset, schema, table, key_fields, ds.primary_key, Transformer(conn))
            async for change in self._initial_state(conn, schema, table, snapshot_name, decoder):
                yield change
            pump.start()
            while True:
                item = await pump.queue.get()
                if isinstance(item, BaseException):
                    raise ConnectorError(
                        f"Replication stream stopped: {_first_line(item, type(item).__name__)}",
                        hint="Check that the server is up and the user still has REPLICATION; it will reconnect.",
                    ) from item
                for change in decoder.decode(item):
                    yield change
        finally:
            self._pumps.discard(pump)
            await pump.stop()

    # -- helpers ----------------------------------------------------------

    async def _initial_state(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        schema: str,
        table: str,
        snapshot_name: str,
        decoder: _Decoder,
    ) -> AsyncIterator[Change]:
        """Read the table once, at exactly the slot's start point."""
        self.snapshot_queries += 1
        ts = time.time()
        count = 0
        await conn.execute("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        try:
            await conn.execute(sql.SQL("SET TRANSACTION SNAPSHOT {}").format(sql.Literal(snapshot_name)))
            async with conn.cursor(name=f"liveops_snap_{uuid.uuid4().hex[:8]}") as cur:
                await cur.execute(sql.SQL("SELECT * FROM {}.{}").format(sql.Identifier(schema), sql.Identifier(table)))
                while rows := await cur.fetchmany(1000):
                    count += len(rows)
                    if count > MAX_ROWS:
                        raise ConnectorError(
                            f"Table {schema}.{table} has more than {MAX_ROWS:,} rows",
                            hint="Live Ops shows up to 100,000 records per table. Map a smaller table or a view.",
                        )
                    for row in rows:
                        change = decoder.remember(row, ts)
                        if change is not None:
                            yield change
        finally:
            await conn.execute("COMMIT")

    async def _published_tables(self, pub: str) -> set[str]:
        conn = await self._connect()
        async with conn.cursor() as cur:
            await cur.execute("SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = %s", (pub,))
            return {f"{r['schemaname']}.{r['tablename']}" for r in await cur.fetchall()}

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


# --------------------------------------------------------------------------
# Replication pump: socket -> asyncio queue, on a worker thread
# --------------------------------------------------------------------------


class _ReplicationPump:
    def __init__(self, conninfo: dict[str, Any], publication: str, loop: asyncio.AbstractEventLoop) -> None:
        self._conninfo = conninfo
        self._publication = publication
        self._loop = loop
        self.slot = f"liveops_{uuid.uuid4().hex[:16]}"
        self.queue: asyncio.Queue[bytes | BaseException] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._stop = threading.Event()
        self._conn: Any = None
        self._thread: threading.Thread | None = None

    def open(self) -> str:
        """Connect and create the temporary slot. Returns the exported snapshot name."""
        try:
            self._conn = psycopg2.connect(
                **self._conninfo, connection_factory=psycopg2.extras.LogicalReplicationConnection
            )
            cur = self._conn.cursor()
            # The slot name is generated above (liveops_<hex>), never user input.
            cur.execute(f"CREATE_REPLICATION_SLOT {self.slot} TEMPORARY LOGICAL pgoutput EXPORT_SNAPSHOT")
            row = cur.fetchone()
        except psycopg2.Error as e:
            self._close_conn()
            msg = _first_line(e, "replication setup failed")
            raise ConnectorError(
                f"Couldn't start logical replication: {msg}",
                hint=_replication_hint(msg) or _connection_hint(msg, "required"),
            ) from None
        return str(row[2])

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"pg-cdc-{self.slot}", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            cur = self._conn.cursor()
            pub = '"' + self._publication.replace('"', '""') + '"'
            cur.start_replication(
                slot_name=self.slot,
                decode=False,
                options={"proto_version": "1", "publication_names": pub},
                status_interval=10,
            )
            while not self._stop.is_set():
                msg = cur.read_message()
                if msg is None:
                    select.select([cur], [], [], 0.5)
                    continue
                if not self._put(bytes(msg.payload)):
                    return
                cur.send_feedback(flush_lsn=msg.data_start)
        except Exception as e:  # noqa: BLE001 - surfaced to the stream as a ConnectorError
            if not self._stop.is_set():
                self._put(e)
        finally:
            self._close_conn()

    def _put(self, item: bytes | BaseException) -> bool:
        fut = asyncio.run_coroutine_threadsafe(self.queue.put(item), self._loop)
        while not self._stop.is_set():
            try:
                fut.result(timeout=0.5)
                return True
            except TimeoutError:
                continue
        fut.cancel()
        return False

    def _close_conn(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()  # ends the session; Postgres drops the temporary slot

    async def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            await asyncio.to_thread(t.join, 5.0)
        if t is None or not t.is_alive():
            await asyncio.to_thread(self._close_conn)


# --------------------------------------------------------------------------
# pgoutput decoding (protocol version 1)
# --------------------------------------------------------------------------


@dataclass
class _Relation:
    schema: str
    table: str
    columns: list[tuple[str, int, bool]]  # name, type oid, part of replica identity


@dataclass
class _Decoder:
    dataset: str
    schema: str
    table: str
    key_fields: list[str]
    primary_key: list[str]
    transformer: LoaderContext
    relations: dict[int, _Relation] = field(default_factory=dict)
    cache: dict[str, Record] = field(default_factory=dict)  # key -> last record (for TOAST and identity)
    by_identity: dict[tuple[Any, ...], str] = field(default_factory=dict)
    commit_ts: float | None = None
    skipped: int = 0

    def remember(self, row: dict[str, Any], ts: float | None) -> Change | None:
        rec = normalize_record(row)
        try:
            key = record_key(rec, self.key_fields)
        except KeyError:
            self.skipped += 1
            return None
        self._store(key, rec)
        return Change(op=ChangeOp.UPSERT, dataset=self.dataset, key=key, record=rec, source_ts=ts)

    def _store(self, key: str, rec: Record) -> None:
        self.cache[key] = rec
        if self.primary_key and all(f in rec for f in self.primary_key):
            self.by_identity[tuple(rec[f] for f in self.primary_key)] = key

    def _forget(self, key: str) -> None:
        rec = self.cache.pop(key, None)
        if rec is not None and self.primary_key:
            self.by_identity.pop(tuple(rec.get(f) for f in self.primary_key), None)

    def decode(self, data: bytes) -> list[Change]:
        kind = data[:1]
        if kind == b"B":
            (_lsn, ts_us, _xid) = struct.unpack_from("!QqI", data, 1)
            self.commit_ts = PG_EPOCH + ts_us / 1_000_000
            return []
        if kind == b"R":
            self._relation(data)
            return []
        if kind in (b"I", b"U", b"D"):
            (relid,) = struct.unpack_from("!I", data, 1)
            rel = self.relations.get(relid)
            if rel is None or (rel.schema, rel.table) != (self.schema, self.table):
                return []
            return self._row_change(kind, rel, data, 5)
        if kind == b"T":
            (nrels,) = struct.unpack_from("!I", data, 1)
            relids = struct.unpack_from(f"!{nrels}I", data, 6)
            if any(
                (r := self.relations.get(i)) is not None and (r.schema, r.table) == (self.schema, self.table)
                for i in relids
            ):
                out = [
                    Change(op=ChangeOp.DELETE, dataset=self.dataset, key=k, record={}, source_ts=self.commit_ts)
                    for k in self.cache
                ]
                self.cache.clear()
                self.by_identity.clear()
                return out
        return []  # C (commit), O (origin), Y (type) and others carry no row data

    def _relation(self, data: bytes) -> None:
        (relid,) = struct.unpack_from("!I", data, 1)
        pos = 5
        schema, pos = _cstring(data, pos)
        table, pos = _cstring(data, pos)
        pos += 1  # replica identity setting
        (ncols,) = struct.unpack_from("!H", data, pos)
        pos += 2
        cols: list[tuple[str, int, bool]] = []
        for _ in range(ncols):
            flags = data[pos]
            name, pos = _cstring(data, pos + 1)
            (oid, _typmod) = struct.unpack_from("!Ii", data, pos)
            pos += 8
            cols.append((name, oid, bool(flags & 1)))
        self.relations[relid] = _Relation(schema, table, cols)
        identity = [c[0] for c in cols if c[2]]
        if identity and identity != self.primary_key:
            self.primary_key = identity
            self.by_identity = {
                tuple(r.get(f) for f in identity): k for k, r in self.cache.items() if all(f in r for f in identity)
            }

    def _row_change(self, kind: bytes, rel: _Relation, data: bytes, pos: int) -> list[Change]:
        old: Record | None = None
        tag = data[pos : pos + 1]
        if tag in (b"K", b"O"):
            old, pos = self._tuple(rel, data, pos + 1, None)
            if tag == b"K":  # only identity columns are meaningful
                ident = {c[0] for c in rel.columns if c[2]}
                old = {k: v for k, v in old.items() if k in ident}
            tag = data[pos : pos + 1]
        ts = self.commit_ts
        if kind == b"D":
            key = self._key_of(old or {})
            if key is None:
                self.skipped += 1
                return []
            self._forget(key)
            return [Change(op=ChangeOp.DELETE, dataset=self.dataset, key=key, record={}, source_ts=ts)]
        assert tag == b"N", f"unexpected pgoutput tuple tag {tag!r}"
        old_key = self._key_of(old) if old else None
        prior = self.cache.get(old_key) if old_key else None
        new, _ = self._tuple(rel, data, pos + 1, prior)
        try:
            key = record_key(new, self.key_fields)
        except KeyError:
            self.skipped += 1
            return []
        prior = prior if prior is not None else self.cache.get(key)
        if prior is not None:  # unchanged TOAST values: keep the last known value
            for name, _oid, _ in rel.columns:
                if name not in new and name in prior:
                    new[name] = prior[name]
        out: list[Change] = []
        if old_key is not None and old_key != key:
            self._forget(old_key)
            out.append(Change(op=ChangeOp.DELETE, dataset=self.dataset, key=old_key, record={}, source_ts=ts))
        self._store(key, new)
        out.append(Change(op=ChangeOp.UPSERT, dataset=self.dataset, key=key, record=new, source_ts=ts))
        return out

    def _key_of(self, partial: Record) -> str | None:
        try:
            return record_key(partial, self.key_fields)
        except KeyError:
            pass
        if self.primary_key and all(partial.get(f) is not None for f in self.primary_key):
            return self.by_identity.get(tuple(partial[f] for f in self.primary_key))
        return None

    def _tuple(self, rel: _Relation, data: bytes, pos: int, prior: Record | None) -> tuple[Record, int]:
        (ncols,) = struct.unpack_from("!H", data, pos)
        pos += 2
        out: Record = {}
        for i in range(ncols):
            name, oid, _ = rel.columns[i]
            kind = data[pos : pos + 1]
            pos += 1
            if kind == b"n":
                out[name] = None
            elif kind == b"u":
                if prior is not None and name in prior:
                    out[name] = prior[name]
            elif kind in (b"t", b"b"):
                (length,) = struct.unpack_from("!I", data, pos)
                pos += 4
                raw = data[pos : pos + length]
                pos += length
                fmt = Format.TEXT if kind == b"t" else Format.BINARY
                out[name] = normalize_value(self.transformer.get_loader(oid, fmt).load(raw))
            else:
                raise ValueError(f"unknown pgoutput column kind {kind!r}")
        return out, pos


def _cstring(data: bytes, pos: int) -> tuple[str, int]:
    end = data.index(b"\x00", pos)
    return data[pos:end].decode("utf-8"), end + 1


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _first_line(e: BaseException, default: str) -> str:
    s = str(e).strip()
    return s.splitlines()[0] if s else default


def _replication_hint(message: str) -> str:
    m = message.lower()
    if "superuser or replication role" in m or "permission denied to start" in m:
        return "Give the user the REPLICATION attribute: ALTER ROLE <user> WITH REPLICATION;"
    if "wal_level" in m:
        return "Set wal_level = logical on the server and restart it."
    if "all replication slots are in use" in m:
        return "Raise max_replication_slots or drop unused slots in pg_replication_slots."
    if "pg_hba" in m:
        return "Allow replication connections for this user in pg_hba.conf (a 'replication' line) and reload."
    if "publication" in m and "does not exist" in m:
        return "Create the publication: CREATE PUBLICATION liveops FOR TABLE schema.table;"
    return ""
