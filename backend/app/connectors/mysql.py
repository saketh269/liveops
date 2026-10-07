"""MySQL connector: poll mode, or live change capture (CDC) from the binary log.

Modes (setting ``mode``):
- ``auto`` (default): CDC when the binary log is usable (``log_bin`` on,
  ``binlog_format=ROW``, ``binlog_row_image=FULL``, REPLICATION SLAVE and
  REPLICATION CLIENT granted), otherwise poll.
- ``cdc``: binary log only; ``test()`` fails if it isn't usable.
- ``poll``: query the table on an interval and diff (no extra grants).

CDC for one table: note the current binlog position, read the table once in a
consistent-snapshot transaction (emitted as UPSERTs), then follow the binlog
from the noted position with python-mysql-replication, filtered to this one
schema and table, on a worker thread. Events committed between the position
and the snapshot are replayed; they are full row images, so the result
converges to the same state. The table is not re-read after the first snapshot.

Safety:
- Every query session is ``SET SESSION TRANSACTION READ ONLY``. The binlog
  reader only reads the replication stream.
- Dataset names are only accepted if ``discover()`` returned them, and are
  backtick-quoted (embedded backticks doubled), never string-built from input.
- Encryption defaults to ``required``; a connection that ends up without TLS
  is refused unless Encryption is ``off``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import re
import socket
import ssl
import threading
import time
from collections.abc import AsyncIterator, Callable
from typing import Any, TypeVar

import pymysql
import pymysql.cursors
from pymysql.constants import CLIENT
from pymysqlreplication import BinLogStreamReader
from pymysqlreplication.event import HeartbeatLogEvent
from pymysqlreplication.row_event import DeleteRowsEvent, UpdateRowsEvent, WriteRowsEvent

from app.connectors.base import (
    MAX_SNAPSHOT_ROWS,
    Category,
    Change,
    ChangeOp,
    Column,
    ConnectorError,
    ConnectorSpec,
    Dataset,
    Mode,
    PollingConnector,
    Record,
    TestReport,
    TestStep,
    check_row_cap,
    normalize_record,
    record_key,
    snapshot_end,
)
from app.connectors.registry import register

log = logging.getLogger("liveops.connectors.mysql")

MAX_ROWS = MAX_SNAPSHOT_ROWS  # per-dataset cap for poll snapshots and the CDC initial state; larger raises
QUEUE_SIZE = 10_000
# Without binlog_row_metadata=FULL the binlog library can't decode these faithfully
# (binary as text, ENUM/SET as None), so rows of tables that have them are re-read
# by key after each change: a one-row lookup, never a table scan.
LOOKUP_TYPES = {"binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "enum", "set"}
INT_BITS = {"tinyint": 8, "smallint": 16, "mediumint": 24, "int": 32, "integer": 32, "bigint": 64}
T = TypeVar("T")


class _SafeConnection(pymysql.connections.Connection):
    """PyMySQL connection that never sends credentials in plaintext when TLS was asked for.

    Stock PyMySQL silently continues without TLS when the server (or someone in
    the middle) doesn't advertise CLIENT_SSL, and only then authenticates
    (LIVEOPS-26). Here the handshake is refused before any auth packet is sent.
    """

    def _request_authentication(self) -> None:
        if self.ssl and not (self.server_capabilities & CLIENT.SSL):
            raise pymysql.err.OperationalError(
                2026, "The server did not offer TLS, so Live Ops refused to send the password"
            )
        super()._request_authentication()


@register
class MySQLConnector(PollingConnector):
    spec = ConnectorSpec(
        type="mysql",
        display_name="MySQL",
        category=Category.DATABASE,
        modes=[Mode.CDC, Mode.POLL],
        description=(
            "Reads tables from MySQL 8 with a read-only user. Streams changes live from the binary log "
            "when it is enabled (binlog_format=ROW), otherwise polls."
        ),
        maturity="beta",
        settings_schema={
            "type": "object",
            "required": ["host", "port", "database", "user"],
            "properties": {
                "host": {"type": "string", "title": "Host", "examples": ["db.example.com"]},
                "port": {"type": "integer", "title": "Port", "default": 3306},
                "database": {"type": "string", "title": "Database (schema)"},
                "user": {"type": "string", "title": "Read-only user"},
                "mode": {
                    "type": "string",
                    "title": "How to read changes",
                    "enum": ["auto", "cdc", "poll"],
                    "default": "auto",
                    "description": "auto: live from the binary log when usable, otherwise poll.",
                },
                "encryption": {
                    "type": "string",
                    "title": "Encryption",
                    "enum": ["required", "verify", "off"],
                    "default": "required",
                    "description": "Use 'off' only for local testing. 'verify' also checks the server certificate.",
                },
                "ssl_ca": {
                    "type": "string",
                    "title": "CA certificate file (for 'verify')",
                    "description": "Path on the Live Ops server. Empty uses the system trust store.",
                },
                "server_id": {
                    "type": "integer",
                    "title": "Replica server id (CDC)",
                    "description": "Unique among the server's replicas. Empty picks a random one.",
                    "minimum": 1,
                    "maximum": 4294967295,
                },
            },
        },
        secrets_schema={
            "type": "object",
            "required": ["password"],
            "properties": {"password": {"type": "string", "title": "Password", "format": "password"}},
        },
    )

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any], *, source_id: str | None = None) -> None:
        super().__init__(settings, secrets, source_id=source_id)
        self._conn: pymysql.connections.Connection[Any] | None = None
        self._lock = threading.Lock()
        self._datasets: dict[str, Dataset] | None = None
        self._unsigned: dict[str, dict[str, int]] = {}  # dataset -> unsigned int column -> bits
        self._pumps: set[_BinlogPump] = set()
        # Instrumentation for tests and health: how often the full table was read.
        self.snapshot_queries = 0
        self.row_lookups = 0
        self.active_mode: str | None = None

    # -- connection -------------------------------------------------------

    def _ssl(self) -> ssl.SSLContext | None:
        enc = self.settings.get("encryption", "required")
        if enc == "off":
            return None
        if enc == "verify":
            return ssl.create_default_context(cafile=self.settings.get("ssl_ca") or None)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # "required": encrypted, certificate not checked
        return ctx

    def _connect_kwargs(self) -> dict[str, Any]:
        s = self.settings
        ctx = self._ssl()
        kw: dict[str, Any] = {
            "host": s["host"],
            "port": int(s.get("port", 3306)),
            "user": s["user"],
            "password": self.secrets.get("password", ""),
            "connect_timeout": 10,
            "read_timeout": 30,
            "write_timeout": 30,
            "charset": "utf8mb4",
        }
        if ctx is None:
            kw["ssl_disabled"] = True
        else:
            kw["ssl"] = ctx
        return kw

    def _open(self) -> pymysql.connections.Connection[Any]:
        conn = _SafeConnection(
            **self._connect_kwargs(),
            autocommit=True,
            cursorclass=pymysql.cursors.DictCursor,
            init_command="SET SESSION TRANSACTION READ ONLY",
        )
        with conn.cursor() as cur:
            cur.execute("SET SESSION time_zone = '+00:00', SESSION max_execution_time = 15000")
        if self.settings.get("encryption", "required") != "off" and not _cipher(conn):
            conn.close()
            raise ConnectorError(
                "The server accepted the connection without encryption",
                hint="Turn TLS on in MySQL (have_ssl=YES), or set Encryption to Off for local testing only.",
            )
        return conn

    def _run(self, fn: Callable[[pymysql.connections.Connection[Any]], T]) -> T:
        """Run ``fn`` with the shared session (opened on first use). Call via ``asyncio.to_thread``."""
        with self._lock:
            if self._conn is None or not self._conn.open:
                self._conn = self._open()
            return fn(self._conn)

    async def _call(self, fn: Callable[[pymysql.connections.Connection[Any]], T]) -> T:
        try:
            return await asyncio.to_thread(self._run, fn)
        except pymysql.MySQLError as e:
            code, msg = _err(e)
            if isinstance(e, pymysql.err.OperationalError):
                await asyncio.to_thread(self._close_sync)  # e.g. killed session: reconnect next time
            raise ConnectorError(f"MySQL error {code}: {msg}", hint=_mysql_hint(code, msg, self.settings)) from None

    async def close(self) -> None:
        pumps, self._pumps = list(self._pumps), set()
        for p in pumps:
            await p.stop()
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        with self._lock:
            conn, self._conn = self._conn, None
        if conn is not None and conn.open:
            with contextlib.suppress(pymysql.MySQLError, OSError):
                conn.close()

    # -- contract ---------------------------------------------------------

    async def test(self) -> TestReport:
        started = time.monotonic()
        steps: list[TestStep] = []
        where = f"{self.settings['host']}:{self.settings.get('port', 3306)}"
        try:
            info = await asyncio.to_thread(self._run, _server_info)
        except ConnectorError as e:  # connected, but without TLS
            steps.append(TestStep(name="Reach the server", ok=True, detail=where))
            steps.append(TestStep(name="Encryption", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        except pymysql.MySQLError as e:
            code, msg = _err(e)
            hint = _mysql_hint(code, msg, self.settings)
            if code == 1045:  # reached the server, sign-in refused
                steps.append(TestStep(name="Reach the server", ok=True, detail=where))
                steps.append(TestStep(name="Sign in", ok=False, detail=f"access denied (error {code})", hint=hint))
            else:
                steps.append(TestStep(name="Reach the server", ok=False, detail=f"error {code}: {msg}", hint=hint))
            return TestReport.from_steps(steps, started)
        except OSError as e:
            steps.append(TestStep(name="Reach the server", ok=False, detail=str(e) or "connection failed"))
            return TestReport.from_steps(steps, started)

        steps.append(TestStep(name="Reach the server", ok=True, detail=f"{where}, MySQL {info['version']}"))
        steps.append(TestStep(name="Sign in", ok=True, detail=f"as {info['user']}"))
        enc = bool(info["cipher"])
        want = self.settings.get("encryption", "required")
        steps.append(
            TestStep(
                name="Encryption",
                ok=enc or want == "off",
                detail=(
                    "not encrypted"
                    if not enc
                    else f"encrypted (TLS, {info['cipher']}), server certificate verified"
                    if want == "verify"
                    else f"encrypted (TLS, {info['cipher']}), server certificate NOT verified "
                    "(use Verify for servers outside your network)"
                ),
                hint="" if enc or want == "off" else "Turn on TLS on the server.",
            )
        )
        ro = bool(info["read_only"])
        steps.append(
            TestStep(
                name="Read-only session",
                ok=ro,
                detail="on" if ro else "off",
                hint="" if ro else "The server ignored SET SESSION TRANSACTION READ ONLY; check for a proxy.",
            )
        )
        try:
            ds = await self.discover()
            steps.append(
                TestStep(
                    name="List tables",
                    ok=bool(ds),
                    detail=f"{len(ds)} tables or views readable in {self.settings['database']}",
                    hint=""
                    if ds
                    else f"Grant SELECT: GRANT SELECT ON {_quote(self.settings['database'])}.* TO '<user>'@'%';",
                )
            )
        except ConnectorError as e:
            steps.append(TestStep(name="List tables", ok=False, detail=str(e), hint=e.hint))

        mode = self.settings.get("mode", "auto")
        if mode != "poll":
            problems = _binlog_problems(info)
            steps.extend(_binlog_steps(info, problems, strict=mode == "cdc"))
        return TestReport.from_steps(steps, started)

    async def discover(self) -> list[Dataset]:
        db = self.settings["database"]

        def q(conn: pymysql.connections.Connection[Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS t, c.COLUMN_NAME AS col, c.DATA_TYPE AS type,
                           c.COLUMN_TYPE AS full_type,
                           c.IS_NULLABLE AS nullable, t.TABLE_TYPE AS kind
                    FROM information_schema.COLUMNS c
                    JOIN information_schema.TABLES t
                      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
                    WHERE c.TABLE_SCHEMA = %s
                    ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
                    """,
                    (db,),
                )
                cols = list(cur.fetchall())
                cur.execute(
                    """
                    SELECT TABLE_NAME AS t, COLUMN_NAME AS col FROM information_schema.KEY_COLUMN_USAGE
                    WHERE TABLE_SCHEMA = %s AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION
                    """,
                    (db,),
                )
                return cols, list(cur.fetchall())

        cols, pks = await self._call(q)
        pk_map: dict[str, list[str]] = {}
        for p in pks:
            pk_map.setdefault(f"{db}.{p['t']}", []).append(p["col"])
        out: dict[str, Dataset] = {}
        unsigned: dict[str, dict[str, int]] = {}
        for c in cols:
            name = f"{c['s']}.{c['t']}"
            d = out.setdefault(
                name,
                Dataset(
                    name=name, columns=[], primary_key=pk_map.get(name, []), supports_cdc=c["kind"] == "BASE TABLE"
                ),
            )
            d.columns.append(Column(name=c["col"], type=c["type"], nullable=c["nullable"] == "YES"))
            bits = INT_BITS.get(str(c["type"]).lower())
            if bits and "unsigned" in str(c["full_type"]).lower():
                unsigned.setdefault(name, {})[c["col"]] = bits
        self._datasets = out
        self._unsigned = unsigned
        return list(out.values())

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        query = await self._select_sql(dataset, max(0, min(int(limit), 1000)))
        json_cols = self._json_columns(dataset)

        def q(conn: pymysql.connections.Connection[Any]) -> list[dict[str, Any]]:
            with conn.cursor() as cur:
                cur.execute(query)
                return list(cur.fetchall())

        return [_record(r, json_cols) for r in await self._call(q)]

    async def snapshot(self, dataset: str) -> list[Record]:
        query = await self._select_sql(dataset, MAX_ROWS + 1)  # one extra row tells "too many" from "exactly cap"
        json_cols = self._json_columns(dataset)
        self.snapshot_queries += 1

        def q(conn: pymysql.connections.Connection[Any]) -> list[dict[str, Any]]:
            with conn.cursor() as cur:
                cur.execute(query)
                return list(cur.fetchall())

        rows = await self._call(q)
        check_row_cap(len(rows), dataset, MAX_ROWS)
        return [_record(r, json_cols) for r in rows]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        await self._resolve(dataset)
        mode = await self._choose_mode()
        self.active_mode = mode
        if mode == "poll":
            async for change in super().stream(dataset, key_fields, options):
                yield change
            return
        async for change in self._stream_binlog(dataset, key_fields):
            yield change

    # -- CDC --------------------------------------------------------------

    async def _choose_mode(self) -> str:
        mode = self.settings.get("mode", "auto")
        if mode == "poll":
            return "poll"
        info = await self._call(_server_info)
        problems = _binlog_problems(info)
        if not problems:
            return "cdc"
        if mode == "cdc":
            raise ConnectorError(
                "Can't read live changes from the binary log: " + "; ".join(p for p, _ in problems),
                hint=" ".join(h for _, h in problems),
            )
        log.info("mysql source %s: binlog not usable (%s); polling", self.settings["host"], problems[0][0])
        return "poll"

    async def _stream_binlog(self, dataset: str, key_fields: list[str]) -> AsyncIterator[Change]:
        query = await self._select_sql(dataset, MAX_ROWS + 1)
        json_cols = self._json_columns(dataset)
        unsigned = dict(self._unsigned.get(dataset, {}))
        schema, table = _split(dataset)
        ds = await self._resolve(dataset)
        needs_lookup = any(c.type.lower() in LOOKUP_TYPES for c in ds.columns)

        def snap(conn: pymysql.connections.Connection[Any]) -> tuple[str, int, list[dict[str, Any]]]:
            with conn.cursor() as cur:
                # Position first, then the snapshot: anything committed in between is
                # replayed from the binlog (full row images), so nothing is missed.
                file, pos = _binlog_position(cur)
                cur.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
                try:
                    cur.execute(query)
                    rows = list(cur.fetchall())
                finally:
                    cur.execute("COMMIT")
            return file, pos, rows

        self.snapshot_queries += 1
        log_file, log_pos, rows = await self._call(snap)
        _cdc_row_cap(len(rows), dataset)  # CDC wording, not "too many to poll" (LIVEOPS-88)
        ts = time.time()
        snapshot_skipped = 0
        for row in rows:
            rec = _record(row, json_cols)
            try:
                key = record_key(rec, key_fields)
            except KeyError:
                snapshot_skipped += 1
                continue
            yield Change(op=ChangeOp.UPSERT, dataset=dataset, key=key, record=rec, source_ts=ts)
        self.skipped_records = snapshot_skipped
        yield snapshot_end(dataset)

        server_id = int(self.settings.get("server_id") or random.randint(100_000, 2**31 - 1))  # noqa: S311
        pump = _BinlogPump(
            self._connect_kwargs(),
            server_id,
            schema,
            table,
            log_file,
            log_pos,
            lambda ev, on_skip: _changes(ev, dataset, key_fields, json_cols, unsigned, on_skip),
            asyncio.get_running_loop(),
            ignore_decode_errors=needs_lookup,
        )
        self._pumps.add(pump)
        pump.start()
        try:
            while True:
                item = await pump.queue.get()
                if isinstance(item, BaseException):
                    code, msg = _err(item) if isinstance(item, pymysql.MySQLError) else (0, str(item))
                    raise ConnectorError(
                        f"Binary log stream stopped: {msg or type(item).__name__}",
                        hint=(_mysql_hint(code, msg, self.settings) if code != 2013 else "")
                        or "The connection to the binary log dropped; Live Ops reloads the table and reconnects.",
                    ) from item
                self.skipped_records = snapshot_skipped + pump.skipped
                for change in item:
                    if needs_lookup and change.op == ChangeOp.UPSERT:
                        fresh = await self._row_by_key(dataset, key_fields, change.record, json_cols)
                        if fresh is None:
                            continue  # deleted since; its DELETE event follows
                        change = change.model_copy(update={"record": fresh})
                    yield change
        finally:
            self._pumps.discard(pump)
            await pump.stop()

    # -- helpers ----------------------------------------------------------

    async def _resolve(self, dataset: str) -> Dataset:
        if self._datasets is None or dataset not in self._datasets:
            await self.discover()
        assert self._datasets is not None
        if dataset not in self._datasets:
            raise ConnectorError(
                f"Table {dataset!r} isn't readable with this user",
                hint="Check the table name and that the user has SELECT on it.",
            )
        return self._datasets[dataset]

    async def _row_by_key(
        self, dataset: str, key_fields: list[str], record: Record, json_cols: set[str]
    ) -> Record | None:
        """One-row lookup by key (not a table scan); see LOOKUP_TYPES."""
        await self._resolve(dataset)
        schema, table = _split(dataset)
        where = " AND ".join(f"{_quote(k)} = %s" for k in key_fields)
        query = f"SELECT * FROM {_quote(schema)}.{_quote(table)} WHERE {where} LIMIT 1"  # noqa: S608 - quoted
        params = tuple(record.get(k) for k in key_fields)
        self.row_lookups += 1

        def q(conn: pymysql.connections.Connection[Any]) -> dict[str, Any] | None:
            with conn.cursor() as cur:
                cur.execute(query, params)
                row: dict[str, Any] | None = cur.fetchone()
                return row

        row = await self._call(q)
        return _record(row, json_cols) if row is not None else None

    async def _select_sql(self, dataset: str, limit: int) -> str:
        await self._resolve(dataset)  # only names discover() returned get this far
        schema, table = _split(dataset)
        return f"SELECT * FROM {_quote(schema)}.{_quote(table)} LIMIT {int(limit)}"  # noqa: S608 - quoted, from discover()

    def _json_columns(self, dataset: str) -> set[str]:
        ds = (self._datasets or {}).get(dataset)
        return {c.name for c in ds.columns if c.type.lower() == "json"} if ds else set()


# --------------------------------------------------------------------------
# Binlog pump: replication stream -> asyncio queue, on a worker thread
# --------------------------------------------------------------------------


class _BinlogPump:
    def __init__(
        self,
        conn_kwargs: dict[str, Any],
        server_id: int,
        schema: str,
        table: str,
        log_file: str,
        log_pos: int,
        convert: Callable[[Any, Callable[[], None]], list[Change]],
        loop: asyncio.AbstractEventLoop,
        *,
        ignore_decode_errors: bool = False,
    ) -> None:
        settings = {k: v for k, v in conn_kwargs.items() if k != "charset"}
        settings["password"] = conn_kwargs["password"]
        self._reader = BinLogStreamReader(
            connection_settings=settings,
            server_id=server_id,
            resume_stream=True,
            blocking=True,
            log_file=log_file,
            log_pos=log_pos,
            only_events=[WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent, HeartbeatLogEvent],
            only_schemas=[schema],
            only_tables=[table],
            slave_heartbeat=1,  # wakes the reader every second when idle, so stop() is prompt
            use_column_name_cache=True,
            ignore_decode_errors=ignore_decode_errors,
            enable_logging=False,
            pymysql_wrapper=self._connection,
        )
        self.skipped = 0  # rows in change events without a key value
        self._stream_connections = 0
        self._convert = convert
        self._loop = loop
        self.queue: asyncio.Queue[list[Change] | BaseException] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"mysql-binlog-{server_id}", daemon=True)

    def _connection(self, **kwargs: Any) -> pymysql.connections.Connection[Any]:
        """Connection factory for the binlog library.

        The library silently reconnects the binlog stream inside ``fetchone()`` after
        a dropped or killed connection, and then delivers nothing for our table
        (LIVEOPS-39). A second stream connection is refused here instead, so the
        error reaches the runner, which restarts with a fresh snapshot.
        """
        if "db" not in kwargs and "database" not in kwargs:  # the stream (the control conn uses a db)
            self._stream_connections += 1
            if self._stream_connections > 1:
                raise pymysql.err.OperationalError(2013, "Lost connection to the binary log stream")
        return _SafeConnection(**kwargs)

    def _skip(self) -> None:
        self.skipped += 1

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                event = self._reader.fetchone()
                if self._stop.is_set():
                    return
                if event is None or isinstance(event, HeartbeatLogEvent):
                    continue
                changes = self._convert(event, self._skip)
                if changes and not self._put(changes):
                    return
        except Exception as e:  # noqa: BLE001 - surfaced to the stream as a ConnectorError
            if not self._stop.is_set():
                self._put(e)
        finally:
            with contextlib.suppress(Exception):
                self._reader.close()

    def _put(self, item: list[Change] | BaseException) -> bool:
        fut = asyncio.run_coroutine_threadsafe(self.queue.put(item), self._loop)
        while not self._stop.is_set():
            try:
                fut.result(timeout=0.5)
                return True
            except TimeoutError:
                continue
        fut.cancel()
        return False

    async def stop(self) -> None:
        self._stop.set()
        conn = getattr(self._reader, "_stream_connection", None)
        sock = getattr(conn, "_sock", None)
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)  # unblocks a reader waiting for the next event
        if self._thread.is_alive():
            await asyncio.to_thread(self._thread.join, 5.0)


def _changes(
    event: Any,
    dataset: str,
    key_fields: list[str],
    json_cols: set[str],
    unsigned: dict[str, int],
    on_skip: Callable[[], None],
) -> list[Change]:
    ts = float(event.timestamp) if getattr(event, "timestamp", None) else None

    def rec_of(values: dict[str, Any]) -> Record:
        # Without binlog_row_metadata=FULL the binlog doesn't say which ints are unsigned.
        for col, bits in unsigned.items():
            v = values.get(col)
            if isinstance(v, int) and v < 0:
                values[col] = v + (1 << bits)
        return _record(values, json_cols)

    out: list[Change] = []
    for row in event.rows:
        if isinstance(event, UpdateRowsEvent):
            before, after = rec_of(row["before_values"]), rec_of(row["after_values"])
            old: str | None = None
            with contextlib.suppress(KeyError):
                old = record_key(before, key_fields)
            try:
                key = record_key(after, key_fields)
            except KeyError:  # the row lost its key value: it leaves the map
                on_skip()
                if old is not None:
                    out.append(Change(op=ChangeOp.DELETE, dataset=dataset, key=old, record={}, source_ts=ts))
                continue
            if old is not None and old != key:  # mapping key changed: drop the old asset
                out.append(Change(op=ChangeOp.DELETE, dataset=dataset, key=old, record={}, source_ts=ts))
            out.append(Change(op=ChangeOp.UPSERT, dataset=dataset, key=key, record=after, source_ts=ts))
            continue
        rec = rec_of(row["values"])
        try:
            key = record_key(rec, key_fields)
        except KeyError:
            on_skip()
            continue
        if isinstance(event, DeleteRowsEvent):
            out.append(Change(op=ChangeOp.DELETE, dataset=dataset, key=key, record={}, source_ts=ts))
        else:
            out.append(Change(op=ChangeOp.UPSERT, dataset=dataset, key=key, record=rec, source_ts=ts))
    return out


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def _cdc_row_cap(count: int, dataset: str) -> None:
    if count > MAX_ROWS:
        raise ConnectorError(
            f"{dataset} has more than {MAX_ROWS:,} rows",
            hint=f"Live Ops shows up to {MAX_ROWS:,} records per table. Map a smaller table, or switch "
            "'How to read changes' to poll and map a view that filters to the rows you need.",
        )


def _quote(identifier: str) -> str:
    return "`" + identifier.replace("`", "``") + "`"


def _split(dataset: str) -> tuple[str, str]:
    schema, _, table = dataset.partition(".")
    return schema, table


def _record(row: dict[str, Any], json_cols: set[str]) -> Record:
    """Normalise a row the same way whether it came from a query or the binlog."""
    fixed: dict[str, Any] = {}
    for k, v in row.items():
        if k in json_cols and v is not None:
            v = _json_value(v)
        fixed[k] = v
    return normalize_record(fixed)


def _json_value(v: Any) -> Any:
    if isinstance(v, (str, bytes)):  # from a query: JSON text
        try:
            return json.loads(v)
        except ValueError:
            return v.decode("utf-8", "replace") if isinstance(v, bytes) else v
    return _decode_bytes(v)  # from the binlog: already parsed, strings may be bytes


def _decode_bytes(v: Any) -> Any:
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    if isinstance(v, dict):
        return {_decode_bytes(k): _decode_bytes(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_decode_bytes(x) for x in v]
    return v


def _cipher(conn: pymysql.connections.Connection[Any]) -> str:
    with conn.cursor() as cur:
        cur.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
        row = cur.fetchone()
    if not row:
        return ""
    return str(row["Value"] if isinstance(row, dict) else row[1])


def _binlog_position(cur: Any) -> tuple[str, int]:
    try:
        cur.execute("SHOW BINARY LOG STATUS")  # MySQL 8.2+
    except pymysql.err.ProgrammingError:
        cur.execute("SHOW MASTER STATUS")
    row = cur.fetchone()
    if not row:
        raise ConnectorError(
            "The binary log is off on this server", hint="Enable log_bin, or set How to read changes to poll."
        )
    return str(row["File"]), int(row["Position"])


def _server_info(conn: pymysql.connections.Connection[Any]) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT VERSION() AS version, CURRENT_USER() AS user, @@session.transaction_read_only AS read_only,"
            " @@global.log_bin AS log_bin, @@global.binlog_format AS binlog_format,"
            " @@global.binlog_row_image AS row_image"
        )
        info: dict[str, Any] = dict(cur.fetchone() or {})
        cur.execute("SHOW GRANTS FOR CURRENT_USER()")
        info["grants"] = [str(next(iter(r.values()))) for r in cur.fetchall()]
    info["cipher"] = _cipher(conn)
    return info


def _has_grant(grants: list[str], privilege: str) -> bool:
    for g in grants:
        m = re.match(r"GRANT (.+) ON \*\.\* TO", g, re.IGNORECASE)
        if m and ("ALL PRIVILEGES" in m.group(1).upper() or privilege in m.group(1).upper()):
            return True
    return False


def _binlog_problems(info: dict[str, Any]) -> list[tuple[str, str]]:
    """(problem, how to fix) for each reason the binlog can't be streamed."""
    out: list[tuple[str, str]] = []
    if not info.get("log_bin"):
        out.append(("binary log is off", "Start MySQL with log_bin enabled (the default in MySQL 8)."))
    if str(info.get("binlog_format", "")).upper() != "ROW":
        out.append(
            (f"binlog_format is {info.get('binlog_format')}", "Ask your DBA to SET GLOBAL binlog_format = 'ROW'.")
        )
    if str(info.get("row_image", "")).upper() != "FULL":
        out.append(
            (f"binlog_row_image is {info.get('row_image')}", "Ask your DBA to SET GLOBAL binlog_row_image = 'FULL'.")
        )
    grants = info.get("grants", [])
    missing = [p for p in ("REPLICATION SLAVE", "REPLICATION CLIENT") if not _has_grant(grants, p)]
    if missing:
        out.append(
            (
                f"user lacks {' and '.join(missing)}",
                f"Run as an admin: GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO {info.get('user', '<user>')};",
            )
        )
    return out


def _binlog_steps(info: dict[str, Any], problems: list[tuple[str, str]], *, strict: bool) -> list[TestStep]:
    log_problems = [p for p in problems if not p[0].startswith("user lacks")]
    grant_problems = [p for p in problems if p[0].startswith("user lacks")]
    fallback = " Live Ops will poll instead (changes appear within a few seconds)." if not strict else ""
    steps = []
    for name, found, ok_detail in (
        ("Binary log (ROW format)", log_problems, f"binlog_format={info.get('binlog_format')}, row image FULL"),
        ("Replication permission", grant_problems, "REPLICATION SLAVE and REPLICATION CLIENT granted"),
    ):
        if not found:
            steps.append(TestStep(name=name, ok=True, detail=ok_detail))
        else:
            steps.append(
                TestStep(
                    name=name,
                    ok=not strict,
                    detail="; ".join(p for p, _ in found) + ("" if strict else " (falling back to polling)"),
                    hint=" ".join(h for _, h in found) + fallback,
                )
            )
    return steps


def _err(e: BaseException) -> tuple[int, str]:
    args: tuple[Any, ...] = tuple(e.args)
    if len(args) >= 2 and isinstance(args[0], int):
        return args[0], str(args[1])
    return 0, str(e)


def _mysql_hint(code: int, message: str, settings: dict[str, Any]) -> str:
    m = message.lower()
    if code == 1045:
        return "Check the user name and password, and that the user may connect from this host ('user'@'%')."
    if code == 1049:
        return "Check the database name."
    if code in (1044, 1142, 1143):
        return "Grant SELECT on the database: GRANT SELECT ON `<database>`.* TO '<user>'@'%';"
    if code == 1236 or "purged" in m:
        return "The binary log position is gone (purged). Raise binlog_expire_logs_seconds; it will restart cleanly."
    if code == 1227:
        return "Grant replication access: GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '<user>'@'%';"
    if code == 3159 or "secure transport" in m:
        return "The server requires TLS. Set Encryption to Required."
    if code == 2026 or "ssl" in m:
        if settings.get("encryption") == "verify":
            return "The server certificate couldn't be verified. Set the CA certificate file, or use Required."
        return (
            "The server doesn't accept encrypted connections. Turn TLS on, or set Encryption to Off for local testing."
        )
    if code == 2003 and ("name or service not known" in m or "nodename" in m or "getaddrinfo" in m):
        return (
            "Check the host name. From Docker on Windows or Mac, "
            "use host.docker.internal for a database on your own computer."
        )
    if code in (2003, 2013) or "timed out" in m:
        return "Check the host and port, and that a firewall allows the connection."
    return ""
