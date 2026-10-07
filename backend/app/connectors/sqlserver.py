"""Microsoft SQL Server connector: poll mode and CDC via Change Tracking.

Driver: ``pymssql`` (bundles FreeTDS, no ODBC install). It is a blocking
DB-API driver, so every call runs in a worker thread (``asyncio.to_thread``)
behind a lock; the event loop never blocks. The driver is imported lazily so
the app starts even when it isn't installed.

Safety:
- Connections declare ``ApplicationIntent=ReadOnly`` and only ever run SELECTs.
  SQL Server has no per-session read-only switch, so ``test()`` also fails
  when the login can write (sysadmin, INSERT/UPDATE/DELETE on the database).
- Dataset names are only accepted if ``discover()`` returned them; the schema
  and table come from that discovery result and are bracket-quoted with the
  same rules as ``QUOTENAME`` (``]`` doubled). Values are always parameters.
- Encryption defaults to ``required`` (TLS for the whole session). FreeTDS
  can't verify the server certificate per connection, so there is no
  ``verify`` option here (noted on LIVEOPS-5).

CDC mode reads ``CHANGETABLE(CHANGES ...)`` from a version cursor. The first
batch is the full current state (version read *before* the snapshot, so no
change is lost; re-seen rows are deduplicated). When the cursor falls behind
``CHANGE_TRACKING_MIN_VALID_VERSION`` (retention cleanup) or the database
version goes backwards (restore), the connector resyncs: it re-reads the table
and emits only the differences.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable
from typing import Any, TypeVar

from app.connectors.base import (
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
    diff_snapshots,
    normalize_record,
    normalize_value,
    record_key,
)
from app.connectors.registry import register

MAX_ROWS = 50_000  # cap per snapshot and per change batch
CONNECT_TIMEOUT_S = 10
QUERY_TIMEOUT_S = 15
ENCRYPTION = {"required": "require", "off": "off"}

T = TypeVar("T")


def _driver() -> Any:
    try:
        import pymssql
    except ImportError as e:  # pragma: no cover - depends on the install
        raise ConnectorError(
            "The SQL Server driver (pymssql) isn't installed on the Live Ops server",
            hint="Install it with: pip install pymssql, then restart Live Ops.",
        ) from e
    return pymssql


def quote_ident(name: str) -> str:
    """Bracket-quote one identifier the way QUOTENAME does."""
    if not isinstance(name, str) or not name or len(name) > 128 or "\x00" in name:
        raise ConnectorError(f"Invalid SQL Server identifier {name!r}", hint="Pick a table from the list.")
    return "[" + name.replace("]", "]]") + "]"


def _fetch_dicts(cur: Any) -> list[dict[str, Any]]:
    names = [d[0] for d in cur.description or []]
    return [dict(zip(names, row, strict=False)) for row in cur.fetchall()]


@register
class SqlServerConnector(PollingConnector):
    spec = ConnectorSpec(
        type="sqlserver",
        display_name="Microsoft SQL Server",
        category=Category.DATABASE,
        modes=[Mode.POLL, Mode.CDC],
        description=(
            "Reads tables and views from SQL Server 2016+ / Azure SQL with a read-only login. "
            "CDC mode uses Change Tracking."
        ),
        maturity="needs_real_test",
        settings_schema={
            "type": "object",
            "required": ["host", "port", "database", "user"],
            "properties": {
                "host": {"type": "string", "title": "Host", "examples": ["sql.example.com"]},
                "port": {"type": "integer", "title": "Port", "default": 1433},
                "database": {"type": "string", "title": "Database"},
                "user": {"type": "string", "title": "Read-only login"},
                "encryption": {
                    "type": "string",
                    "title": "Encryption",
                    "enum": ["required", "off"],
                    "default": "required",
                    "description": (
                        "'required' encrypts the whole session with TLS. The driver does not check the "
                        "server certificate. Use 'off' only for local testing."
                    ),
                },
                "mode": {
                    "type": "string",
                    "title": "How to read changes",
                    "enum": ["poll", "cdc"],
                    "default": "poll",
                    "description": "'cdc' reads SQL Server Change Tracking (faster, needs it turned on).",
                },
                "schemas": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Schemas to list",
                    "default": ["dbo"],
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
        self._conn: Any = None
        self._lock = asyncio.Lock()
        self._datasets: dict[str, Dataset] | None = None
        self._names: dict[str, tuple[str, str]] = {}

    # -- connection -------------------------------------------------------

    def _connect_kwargs(self) -> dict[str, Any]:
        s = self.settings
        return {
            "server": s["host"],
            "port": str(int(s.get("port", 1433))),
            "user": s["user"],
            "password": self.secrets.get("password", ""),
            "database": s["database"],
            "login_timeout": CONNECT_TIMEOUT_S,
            "timeout": QUERY_TIMEOUT_S,
            "encryption": ENCRYPTION.get(s.get("encryption", "required"), "require"),
            "read_only": True,  # ApplicationIntent=ReadOnly
            "appname": "liveops",
            "autocommit": True,
        }

    def _open(self) -> Any:
        return _driver().connect(**self._connect_kwargs())

    def _scrub(self, text: str) -> str:
        pw = str(self.secrets.get("password") or "")
        # Very short passwords would garble every message; they can't be told apart from normal text anyway.
        return text.replace(pw, "***") if len(pw) >= 4 else text

    def _error_text(self, e: BaseException) -> str:
        args: tuple[Any, ...] = tuple(getattr(e, "args", ()))
        raw: Any = args[1] if len(args) >= 2 else (args[0] if args else e)
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8", "replace")
        lines = [ln.strip() for ln in str(raw).splitlines() if ln.strip() and not ln.startswith("DB-Lib error")]
        return self._scrub(lines[0] if lines else (str(raw).strip() or type(e).__name__))

    async def _run(self, fn: Callable[[Any], T]) -> T:
        """Run ``fn(connection)`` in a worker thread, one call at a time."""
        async with self._lock:
            conn = await self._ensure()
            try:
                return await asyncio.to_thread(fn, conn)
            except ConnectorError:
                raise
            except Exception as e:  # noqa: BLE001 - driver errors become ConnectorError
                if _is_disconnect(e):
                    self._conn = None
                    await asyncio.to_thread(_close_quietly, conn)
                raise ConnectorError(
                    f"SQL Server query failed: {self._error_text(e)}",
                    hint="Check the server is up and the login still has SELECT on the table.",
                ) from None

    async def _ensure(self) -> Any:
        """Open the connection if needed. Driver errors pass through unchanged."""
        if self._conn is None:
            self._conn = await asyncio.to_thread(self._open)
        return self._conn

    async def close(self) -> None:
        async with self._lock:
            conn, self._conn = self._conn, None
        if conn is not None:
            await asyncio.to_thread(_close_quietly, conn)

    def _mode(self, options: dict[str, Any] | None) -> str:
        return str((options or {}).get("mode") or self.settings.get("mode") or "poll")

    # -- contract ---------------------------------------------------------

    async def test(self) -> TestReport:
        started = time.monotonic()
        steps: list[TestStep] = []
        try:
            return await self._test(steps, started)
        except Exception as e:  # noqa: BLE001 - test() must never raise
            msg = self._error_text(e) if not isinstance(e, ConnectorError) else self._scrub(str(e))
            hint = e.hint if isinstance(e, ConnectorError) else "Check the settings and try again."
            steps.append(TestStep(name="Unexpected error", ok=False, detail=msg, hint=hint))
            return TestReport.from_steps(steps, started)

    async def _test(self, steps: list[TestStep], started: float) -> TestReport:
        s = self.settings
        where = f"{s.get('host')}:{s.get('port', 1433)}"
        try:
            async with self._lock:
                await self._ensure()
        except ConnectorError as e:  # driver not installed
            steps.append(TestStep(name="Reach the server", ok=False, detail=self._scrub(str(e)), hint=e.hint))
            return TestReport.from_steps(steps, started)
        except Exception as e:  # noqa: BLE001 - driver errors on connect
            msg = self._error_text(e)
            low = msg.lower()
            full = self._scrub(str(e)).lower()
            if "18456" in full or "login failed" in full:
                steps.append(TestStep(name="Reach the server", ok=True, detail=where))
                steps.append(
                    TestStep(
                        name="Sign in",
                        ok=False,
                        detail="Login failed",
                        hint="Check the login name and password, and that SQL Server authentication is enabled.",
                    )
                )
            else:
                steps.append(
                    TestStep(
                        name="Reach the server",
                        ok=False,
                        detail=msg,
                        hint=_connection_hint(low + " " + full, s.get("encryption", "required")),
                    )
                )
            return TestReport.from_steps(steps, started)
        steps.append(TestStep(name="Reach the server", ok=True, detail=where))

        def who(c: Any) -> dict[str, Any]:
            cur = c.cursor()
            cur.execute(
                "SELECT SUSER_SNAME() AS login_name, DB_NAME() AS db, "
                "CONVERT(nvarchar(10), CONNECTIONPROPERTY('encrypt_option')) AS encrypted, "
                "IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin, "
                "HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS can_insert, "
                "HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS can_update, "
                "HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') AS can_delete, "
                "CHANGE_TRACKING_CURRENT_VERSION() AS ct_version"
            )
            rows = _fetch_dicts(cur)
            return rows[0] if rows else {}

        info = await self._run(who)
        steps.append(TestStep(name="Sign in", ok=True, detail=f"as {info.get('login_name')} in {info.get('db')}"))

        enc = str(info.get("encrypted") or "").upper() == "TRUE"
        want = s.get("encryption", "required")
        steps.append(
            TestStep(
                name="Encryption",
                ok=enc or want == "off",
                detail="encrypted (TLS)" if enc else "not encrypted",
                hint=""
                if enc or want == "off"
                else "The server didn't encrypt the session. Install a TLS certificate on SQL Server "
                "or set Encryption to Off for local testing only.",
            )
        )

        writes = [
            name
            for name, flag in (
                ("sysadmin", info.get("is_sysadmin")),
                ("INSERT", info.get("can_insert")),
                ("UPDATE", info.get("can_update")),
                ("DELETE", info.get("can_delete")),
            )
            if flag == 1
        ]
        login = s.get("user", "liveops_reader")
        steps.append(
            TestStep(
                name="Read-only login",
                ok=not writes,
                detail="no write permissions" if not writes else "login can write: " + ", ".join(writes),
                hint=""
                if not writes
                else "Live Ops only reads, so use a login that can't write. For example: "
                f"CREATE USER [{login}] FOR LOGIN [{login}]; ALTER ROLE db_datareader ADD MEMBER [{login}];",
            )
        )

        datasets = await self.discover()
        steps.append(
            TestStep(
                name="List tables",
                ok=bool(datasets),
                detail=f"{len(datasets)} tables or views readable",
                hint="" if datasets else "Grant SELECT on the tables you want to show, or check the schema list.",
            )
        )

        if self._mode(None) == "cdc":
            db = s.get("database", "your_database")
            db_on = info.get("ct_version") is not None
            steps.append(
                TestStep(
                    name="Change tracking on the database",
                    ok=db_on,
                    detail="on" if db_on else "off",
                    hint=""
                    if db_on
                    else "Ask a DBA to run: ALTER DATABASE "
                    + quote_ident(db)
                    + " SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);",
                )
            )
            tracked = [d for d in datasets if d.supports_cdc]
            steps.append(
                TestStep(
                    name="Change tracking on tables",
                    ok=bool(tracked),
                    detail=f"{len(tracked)} of {len(datasets)} tables tracked and readable",
                    hint=""
                    if tracked
                    else "For each table, ask a DBA to run: ALTER TABLE [dbo].[your_table] ENABLE CHANGE_TRACKING; "
                    f"GRANT VIEW CHANGE TRACKING ON [dbo].[your_table] TO [{login}]; "
                    "(the table needs a primary key).",
                )
            )
        return TestReport.from_steps(steps, started)

    async def discover(self) -> list[Dataset]:
        schemas = json.dumps([str(x) for x in (self.settings.get("schemas") or ["dbo"])])

        def load(c: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
            cur = c.cursor()
            cur.execute(
                "SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS t, c.COLUMN_NAME AS col, "
                "c.DATA_TYPE AS data_type, c.IS_NULLABLE AS nullable "
                "FROM INFORMATION_SCHEMA.COLUMNS c "
                "WHERE c.TABLE_SCHEMA IN (SELECT value FROM OPENJSON(%s)) "
                "AND HAS_PERMS_BY_NAME(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME), "
                "'OBJECT', 'SELECT') = 1 "
                "ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
                (schemas,),
            )
            cols = _fetch_dicts(cur)
            cur.execute(
                "SELECT k.TABLE_SCHEMA AS s, k.TABLE_NAME AS t, k.COLUMN_NAME AS col "
                "FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc "
                "JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k "
                "ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME "
                "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA IN (SELECT value FROM OPENJSON(%s)) "
                "ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.ORDINAL_POSITION",
                (schemas,),
            )
            pks = _fetch_dicts(cur)
            cur.execute(
                "SELECT t.TABLE_SCHEMA AS s, t.TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES t "
                "WHERE t.TABLE_SCHEMA IN (SELECT value FROM OPENJSON(%s)) AND t.TABLE_TYPE = 'BASE TABLE' "
                "AND CHANGE_TRACKING_MIN_VALID_VERSION("
                "OBJECT_ID(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME))) IS NOT NULL "
                "AND HAS_PERMS_BY_NAME(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME), "
                "'OBJECT', 'VIEW CHANGE TRACKING') = 1",
                (schemas,),
            )
            tracked = _fetch_dicts(cur)
            return cols, pks, tracked

        cols, pks, tracked = await self._run(load)
        pk_map: dict[tuple[str, str], list[str]] = {}
        for p in pks:
            pk_map.setdefault((p["s"], p["t"]), []).append(p["col"])
        tracked_set = {(r["s"], r["t"]) for r in tracked}
        out: dict[str, Dataset] = {}
        names: dict[str, tuple[str, str]] = {}
        for c in cols:
            ident = (str(c["s"]), str(c["t"]))
            name = f"{ident[0]}.{ident[1]}"
            d = out.get(name)
            if d is None:
                pk = pk_map.get(ident, [])
                d = out[name] = Dataset(
                    name=name, columns=[], primary_key=pk, supports_cdc=bool(pk) and ident in tracked_set
                )
                names[name] = ident
            d.columns.append(Column(name=str(c["col"]), type=str(c["data_type"]), nullable=c["nullable"] == "YES"))
        self._datasets = out
        self._names = names
        return list(out.values())

    async def snapshot(self, dataset: str) -> list[Record]:
        schema, table = await self._resolve(dataset)
        query = f"SELECT TOP (%s) * FROM {quote_ident(schema)}.{quote_ident(table)}"  # noqa: S608 - quoted identifiers

        def read(c: Any) -> list[dict[str, Any]]:
            cur = c.cursor()
            cur.execute(query, (MAX_ROWS,))
            return _fetch_dicts(cur)

        return [normalize_record(r) for r in await self._run(read)]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        if self._mode(options) != "cdc":
            async for ch in super().stream(dataset, key_fields, options):
                yield ch
            return
        tracker = ChangeTracker(self, dataset, key_fields)
        await tracker.start()
        for ch in tracker.initial():
            yield ch
        interval = float((options or {}).get("poll_interval_s", 1.0))
        while True:
            await asyncio.sleep(interval)
            for ch in await tracker.poll():
                yield ch

    # -- helpers ----------------------------------------------------------

    async def _resolve(self, dataset: str) -> tuple[str, str]:
        if self._datasets is None or dataset not in self._names:
            await self.discover()
        if dataset not in self._names:
            raise ConnectorError(
                f"Table {dataset!r} isn't readable with this login",
                hint="Check the table name and that the login has SELECT on it.",
            )
        return self._names[dataset]

    async def _dataset(self, dataset: str) -> Dataset:
        await self._resolve(dataset)
        assert self._datasets is not None
        return self._datasets[dataset]


class ChangeTracker:
    """Keeps the version cursor and the last known state of one table."""

    def __init__(self, conn: SqlServerConnector, dataset: str, key_fields: list[str]) -> None:
        self.c = conn
        self.dataset = dataset
        self.key_fields = key_fields
        self.version: int | None = None
        self.known: dict[str, Record] = {}
        self.pk_to_key: dict[str, str] = {}
        self._pending: list[Change] = []
        self.schema = ""
        self.table = ""
        self.pk: list[str] = []
        self.resyncs = 0

    async def start(self) -> None:
        ds = await self.c._dataset(self.dataset)
        if not ds.supports_cdc:
            login = self.c.settings.get("user", "your_login")
            raise ConnectorError(
                f"Change tracking isn't available for {self.dataset}",
                hint="Ask a DBA to run: ALTER TABLE "
                + ".".join(quote_ident(x) for x in self.c._names[self.dataset])
                + f" ENABLE CHANGE_TRACKING; GRANT VIEW CHANGE TRACKING ON that table TO [{login}]; "
                "(the table needs a primary key), or switch the source to poll mode.",
            )
        self.schema, self.table = self.c._names[self.dataset]
        self.pk = list(ds.primary_key)
        self._pending = await self._resync()

    def initial(self) -> list[Change]:
        out, self._pending = self._pending, []
        return out

    @property
    def qualified(self) -> str:
        return f"{quote_ident(self.schema)}.{quote_ident(self.table)}"

    def changes_sql(self) -> str:
        q = self.qualified
        pk_cols = ", ".join(f"ct.{quote_ident(p)}" for p in self.pk)
        join = " AND ".join(f"t.{quote_ident(p)} = ct.{quote_ident(p)}" for p in self.pk)
        return (
            f"SELECT TOP (%s) ct.SYS_CHANGE_VERSION, {pk_cols}, t.* "  # noqa: S608 - quoted identifiers
            f"FROM CHANGETABLE(CHANGES {q}, %s) AS ct "
            f"LEFT OUTER JOIN {q} AS t ON {join} "
            "ORDER BY ct.SYS_CHANGE_VERSION"
        )

    def _pk_key(self, values: list[Any]) -> str:
        return "|".join(str(normalize_value(v)) for v in values)

    async def _resync(self) -> list[Change]:
        """Read version + full table; emit the difference to what we knew."""
        q = self.qualified
        pk = self.pk

        def read(c: Any) -> tuple[int | None, list[dict[str, Any]]]:
            cur = c.cursor()
            cur.execute("SELECT CHANGE_TRACKING_CURRENT_VERSION()")
            row = cur.fetchone()
            version = row[0] if row else None
            cur.execute(f"SELECT TOP (%s) * FROM {q}", (MAX_ROWS,))  # noqa: S608 - quoted identifiers
            return version, _fetch_dicts(cur)

        version, rows = await self.c._run(read)
        if version is None:
            raise ConnectorError(
                "Change tracking is off for this database",
                hint="Ask a DBA to run: ALTER DATABASE "
                + quote_ident(str(self.c.settings.get("database", "your_database")))
                + " SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);",
            )
        current: dict[str, Record] = {}
        pk_to_key: dict[str, str] = {}
        for raw in rows:
            rec = normalize_record(raw)
            key = record_key(rec, self.key_fields)
            current[key] = rec
            pk_to_key[self._pk_key([raw[p] for p in pk])] = key
        changes = diff_snapshots(self.dataset, self.known if self.version is not None else None, current)
        self.known, self.pk_to_key, self.version = current, pk_to_key, int(version)
        return changes

    async def poll(self) -> list[Change]:
        assert self.version is not None
        since = self.version
        obj = self.qualified
        sql = self.changes_sql()
        npk = len(self.pk)

        def read(c: Any) -> tuple[Any, Any, list[str], list[tuple[Any, ...]]]:
            cur = c.cursor()
            cur.execute(
                "SELECT CHANGE_TRACKING_CURRENT_VERSION(), CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(%s))",
                (obj,),
            )
            row = cur.fetchone() or (None, None)
            cur_v, min_v = row[0], row[1]
            if cur_v is None or min_v is None or since < min_v or cur_v < since:
                return cur_v, min_v, [], []
            cur.execute(sql, (MAX_ROWS + 1, since))
            names = [d[0] for d in cur.description or []]
            return cur_v, min_v, names, list(cur.fetchall())

        cur_v, min_v, names, rows = await self.c._run(read)
        if cur_v is None or min_v is None:
            raise ConnectorError(
                f"Change tracking was turned off for {self.dataset}",
                hint="Turn change tracking back on for the database and table, or switch the source to poll mode.",
            )
        if since < min_v or cur_v < since or len(rows) > MAX_ROWS:
            # Cursor too old (retention cleanup), database restored, or too many
            # changes to read in one go: re-read the table and send differences.
            self.resyncs += 1
            return await self._resync()

        out: list[Change] = []
        row_cols = names[1 + npk :]
        pk_idx = [row_cols.index(p) for p in self.pk]
        for row in rows:
            pk_vals = list(row[1 : 1 + npk])
            pk_key = self._pk_key(pk_vals)
            values = row[1 + npk :]
            exists = values[pk_idx[0]] is not None
            if not exists:
                old = self.pk_to_key.pop(pk_key, None)
                if old is not None and self.known.pop(old, None) is not None:
                    out.append(Change(op=ChangeOp.DELETE, dataset=self.dataset, key=old, record={}))
                continue
            rec = normalize_record(dict(zip(row_cols, values, strict=False)))
            key = record_key(rec, self.key_fields)
            old = self.pk_to_key.get(pk_key)
            if old is not None and old != key and self.known.pop(old, None) is not None:
                out.append(Change(op=ChangeOp.DELETE, dataset=self.dataset, key=old, record={}))
            self.pk_to_key[pk_key] = key
            if self.known.get(key) != rec:
                self.known[key] = rec
                out.append(Change(op=ChangeOp.UPSERT, dataset=self.dataset, key=key, record=rec))
        self.version = int(cur_v)
        return out


def _close_quietly(conn: Any) -> None:
    try:
        conn.close()
    except Exception:  # noqa: BLE001, S110 - closing a broken connection
        pass


def _is_disconnect(e: BaseException) -> bool:
    text = repr(e).lower()
    return type(e).__name__ in {"OperationalError", "InterfaceError"} or any(
        w in text for w in ("connection", "dbprocess is dead", "not connected", "write to the server failed")
    )


def _connection_hint(message: str, encryption: str) -> str:
    m = message
    if ("ssl" in m or "tls" in m or "encrypt" in m) and encryption != "off":
        return (
            "The server didn't accept an encrypted connection. Install a TLS certificate on SQL Server, "
            "or set Encryption to Off for local testing only."
        )
    if "unknown host" in m or "name or service not known" in m or "unable to resolve" in m:
        return (
            "Check the host name. From Docker on Windows or Mac, "
            "use host.docker.internal for a database on your own computer."
        )
    if "4060" in m or "cannot open database" in m:
        return "Check the database name and that the login has access to it."
    if "unavailable or does not exist" in m or "refused" in m or "timed out" in m or "timeout" in m:
        return (
            "Check the host and port (default 1433), that TCP/IP is enabled in SQL Server Configuration "
            "Manager, and that a firewall allows the connection."
        )
    return "Check the host, port, login and password."
