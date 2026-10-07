"""Oracle Database connector, poll mode.

Driver: ``oracledb`` in thin mode (pure Python, no Oracle Client libraries).
Calls run in a worker thread behind a lock so the event loop never blocks.
The driver is imported lazily so the app starts even when it isn't installed.

Safety:
- Every snapshot runs inside ``SET TRANSACTION READ ONLY``; nothing else is
  ever executed against tables.
- Dataset names are only accepted if ``discover()`` (``ALL_TAB_COLUMNS`` for
  the configured schemas) returned them; owner and table come from that
  result and are double-quoted. Values are always bind variables.
- Encryption defaults to ``required``: TCPS, but the server certificate is
  NOT verified (eavesdropping protection only). ``verify`` checks the
  certificate chain (system CAs or ``ca_file``) and that the certificate name
  matches the host (oracledb ``ssl_server_dn_match``). ``off`` uses plain TCP
  (testing only).
- Poll snapshots are complete or raise (``check_row_cap``); rows without a key
  are skipped and counted by ``PollingConnector`` (ADR 0004).
"""

from __future__ import annotations

import asyncio
import contextlib
import ssl
import time
from collections.abc import Callable
from typing import Any, TypeVar

from app.connectors.base import (
    MAX_SNAPSHOT_ROWS,
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
    check_row_cap,
    normalize_record,
)
from app.connectors.registry import register

MAX_ROWS = MAX_SNAPSHOT_ROWS
CONNECT_TIMEOUT_S = 10
CALL_TIMEOUT_MS = 15_000

T = TypeVar("T")


def _driver() -> Any:
    try:
        import oracledb
    except ImportError as e:  # pragma: no cover - depends on the install
        raise ConnectorError(
            "The Oracle driver (oracledb) isn't installed on the Live Ops server",
            hint="Install it with: pip install oracledb, then restart Live Ops.",
        ) from e
    return oracledb


async def _in_thread[R](fn: Callable[..., R], *args: Any) -> R:
    """Run blocking ``fn`` in a worker thread. If the caller is cancelled, still
    wait for the thread to finish before re-raising, so the connection lock is
    held until the driver is really done (``close()`` never closes a connection
    a thread is still using)."""
    fut = asyncio.ensure_future(asyncio.to_thread(fn, *args))
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        while not fut.done():
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait({fut})
        raise


def quote_ident(name: str) -> str:
    """Double-quote one Oracle identifier. Oracle names can't contain quotes."""
    if not isinstance(name, str) or not name or len(name) > 128 or '"' in name or "\x00" in name:
        raise ConnectorError(f"Invalid Oracle identifier {name!r}", hint="Pick a table from the list.")
    return '"' + name + '"'


def _bind_list(prefix: str, values: list[str]) -> tuple[str, dict[str, str]]:
    """``:s0, :s1`` placeholders and their bind values (names are generated, never user input)."""
    binds = {f"{prefix}{i}": v for i, v in enumerate(values)}
    return ", ".join(f":{k}" for k in binds), binds


def _fetch_dicts(cur: Any) -> list[dict[str, Any]]:
    names = [d[0] for d in cur.description or []]
    return [dict(zip(names, row, strict=False)) for row in cur.fetchall()]


@register
class OracleConnector(PollingConnector):
    spec = ConnectorSpec(
        type="oracle",
        display_name="Oracle Database",
        category=Category.DATABASE,
        modes=[Mode.POLL],
        description=(
            "Reads tables and views from Oracle 12c+ with a read-only user. No Oracle Client needed. "
            "Encryption 'required' uses TCPS but does NOT verify the server certificate; choose 'verify' to "
            "check the certificate and host name."
        ),
        maturity="needs_real_test",
        settings_schema={
            "type": "object",
            "required": ["host", "port", "service_name", "user"],
            "properties": {
                "host": {"type": "string", "title": "Host", "examples": ["oracle.example.com"]},
                "port": {
                    "type": "integer",
                    "title": "Port",
                    "default": 1521,
                    "description": "Usually 1521 for plain TCP and 2484 for TCPS (encrypted).",
                },
                "service_name": {"type": "string", "title": "Service name", "examples": ["ORCLPDB1", "FREEPDB1"]},
                "user": {"type": "string", "title": "Read-only user"},
                "encryption": {
                    "type": "string",
                    "title": "Encryption",
                    "enum": ["required", "verify", "off"],
                    "default": "required",
                    "description": (
                        "'required' connects over TCPS (TLS) but does NOT verify the server certificate. "
                        "'verify' also checks the certificate chain and that it matches the host name. "
                        "'off' uses plain TCP: local testing only."
                    ),
                },
                "ca_file": {
                    "type": "string",
                    "title": "CA certificate file (verify only)",
                    "description": "Path on the Live Ops server to a PEM file. Empty uses the system certificates.",
                },
                "schemas": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Schemas (owners) to list",
                    "description": "Empty lists the user's own schema. Names are case-sensitive, usually UPPER CASE.",
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
        enc = s.get("encryption", "required")
        kw: dict[str, Any] = {
            "user": s["user"],
            "password": self.secrets.get("password", ""),
            "host": s["host"],
            "port": int(s.get("port", 1521)),
            "service_name": s["service_name"],
            "tcp_connect_timeout": CONNECT_TIMEOUT_S,
            "program": "liveops",
        }
        if enc == "off":
            kw["protocol"] = "tcp"
        else:
            kw["protocol"] = "tcps"
            if enc == "verify":
                kw["ssl_context"] = ssl.create_default_context(cafile=s.get("ca_file") or None)
                kw["ssl_server_dn_match"] = True
            else:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE  # encrypted, certificate not checked ('required')
                kw["ssl_context"] = ctx
                kw["ssl_server_dn_match"] = False
        return kw

    def _open(self) -> Any:
        conn = _driver().connect(**self._connect_kwargs())
        conn.call_timeout = CALL_TIMEOUT_MS
        return conn

    def _scrub(self, text: str) -> str:
        pw = str(self.secrets.get("password") or "")
        # Very short passwords would garble every message; they can't be told apart from normal text anyway.
        return text.replace(pw, "***") if len(pw) >= 4 else text

    def _error_text(self, e: BaseException) -> str:
        # oracledb puts the useful reason on later lines (e.g. "DPY-6005: cannot connect ... | [SSL: ...]").
        lines = [ln.strip() for ln in str(e).splitlines() if ln.strip() and not ln.strip().startswith("Help:")]
        return self._scrub(" | ".join(lines)[:500] if lines else type(e).__name__)

    async def _ensure(self) -> Any:
        if self._conn is None:
            await _in_thread(self._open_into_self)
        return self._conn

    def _open_into_self(self) -> None:
        # Stored from the worker thread, so a cancelled caller can't leak the connection.
        self._conn = self._open()

    async def _run(self, fn: Callable[[Any], T]) -> T:
        async with self._lock:
            conn = await self._ensure()
            try:
                return await _in_thread(fn, conn)
            except ConnectorError:
                raise
            except Exception as e:  # noqa: BLE001 - driver errors become ConnectorError
                if type(e).__name__ in {"OperationalError", "InterfaceError"}:
                    self._conn = None
                    await _in_thread(_close_quietly, conn)
                raise ConnectorError(
                    f"Oracle query failed: {self._error_text(e)}",
                    hint="Check the database is up and the user still has SELECT on the table.",
                ) from None

    async def close(self) -> None:
        # Holding the lock means any in-flight call has finished with the connection.
        async with self._lock:
            conn, self._conn = self._conn, None
            if conn is not None:
                await _in_thread(_close_quietly, conn)

    def _schemas(self) -> list[str]:
        given = [str(x) for x in (self.settings.get("schemas") or []) if str(x)]
        return given or [str(self.settings.get("user", "")).upper()]

    # -- contract ---------------------------------------------------------

    async def test(self) -> TestReport:
        started = time.monotonic()
        steps: list[TestStep] = []
        try:
            return await self._test(steps, started)
        except Exception as e:  # noqa: BLE001 - test() must never raise
            msg = self._scrub(str(e)) if isinstance(e, ConnectorError) else self._error_text(e)
            hint = e.hint if isinstance(e, ConnectorError) else "Check the settings and try again."
            steps.append(TestStep(name="Unexpected error", ok=False, detail=msg, hint=hint))
            return TestReport.from_steps(steps, started)

    async def _test(self, steps: list[TestStep], started: float) -> TestReport:
        s = self.settings
        where = f"{s.get('host')}:{s.get('port', 1521)}/{s.get('service_name')}"
        try:
            async with self._lock:
                await self._ensure()
        except ConnectorError as e:
            steps.append(TestStep(name="Reach the server", ok=False, detail=self._scrub(str(e)), hint=e.hint))
            return TestReport.from_steps(steps, started)
        except Exception as e:  # noqa: BLE001 - driver errors on connect
            msg = self._error_text(e)
            if "ORA-01017" in msg or "ORA-28000" in msg:
                steps.append(TestStep(name="Reach the server", ok=True, detail=where))
                steps.append(
                    TestStep(
                        name="Sign in",
                        ok=False,
                        detail=msg,
                        hint="Check the user name and password (Oracle passwords are case-sensitive), "
                        "and that the account isn't locked.",
                    )
                )
            else:
                steps.append(
                    TestStep(
                        name="Reach the server",
                        ok=False,
                        detail=msg,
                        hint=_connection_hint(msg, s.get("encryption", "required")),
                    )
                )
            return TestReport.from_steps(steps, started)
        steps.append(TestStep(name="Reach the server", ok=True, detail=where))

        def who(c: Any) -> dict[str, Any]:
            cur = c.cursor()
            cur.execute("SELECT USER AS U, SYS_CONTEXT('USERENV', 'NETWORK_PROTOCOL') AS P FROM DUAL")
            rows = _fetch_dicts(cur)
            return rows[0] if rows else {}

        info = await self._run(who)
        steps.append(TestStep(name="Sign in", ok=True, detail=f"as {info.get('U')}"))

        enc = str(info.get("P") or "").lower() == "tcps"
        want = s.get("encryption", "required")
        steps.append(
            TestStep(
                name="Encryption",
                ok=enc or want == "off",
                detail=(
                    "not encrypted (TCP)"
                    if not enc
                    else "encrypted (TCPS); server certificate verified"
                    if want == "verify"
                    else "encrypted (TCPS); server certificate NOT verified"
                ),
                hint=""
                if enc or want == "off"
                else "Configure a TCPS listener on the database (usually port 2484) or set Encryption "
                "to Off for local testing only.",
            )
        )

        def read_only(c: Any) -> None:
            c.rollback()
            cur = c.cursor()
            cur.execute("SET TRANSACTION READ ONLY")
            c.rollback()

        await self._run(read_only)
        steps.append(TestStep(name="Read-only transactions", ok=True, detail="every read runs READ ONLY"))

        datasets = await self.discover()
        steps.append(
            TestStep(
                name="List tables",
                ok=bool(datasets),
                detail=f"{len(datasets)} tables or views readable in {', '.join(self._schemas())}",
                hint=""
                if datasets
                else "Grant SELECT on the tables you want to show (GRANT SELECT ON owner.table TO user), "
                "and check the schema names (usually UPPER CASE).",
            )
        )
        return TestReport.from_steps(steps, started)

    async def discover(self) -> list[Dataset]:
        owners, binds = _bind_list("s", self._schemas())

        def load(c: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
            cur = c.cursor()
            cur.execute(
                "SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE "  # noqa: S608 - bind names
                f"FROM ALL_TAB_COLUMNS c WHERE c.OWNER IN ({owners}) AND c.TABLE_NAME NOT LIKE 'BIN$%' "
                "ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID",
                binds,
            )
            cols = _fetch_dicts(cur)
            cur.execute(
                "SELECT cc.OWNER, cc.TABLE_NAME, cc.COLUMN_NAME FROM ALL_CONSTRAINTS k "  # noqa: S608 - bind names
                "JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = k.OWNER AND cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME "
                f"WHERE k.CONSTRAINT_TYPE = 'P' AND k.OWNER IN ({owners}) "
                "ORDER BY cc.OWNER, cc.TABLE_NAME, cc.POSITION",
                binds,
            )
            return cols, _fetch_dicts(cur)

        cols, pks = await self._run(load)
        pk_map: dict[tuple[str, str], list[str]] = {}
        for p in pks:
            pk_map.setdefault((p["OWNER"], p["TABLE_NAME"]), []).append(p["COLUMN_NAME"])
        out: dict[str, Dataset] = {}
        names: dict[str, tuple[str, str]] = {}
        for c in cols:
            ident = (str(c["OWNER"]), str(c["TABLE_NAME"]))
            name = f"{ident[0]}.{ident[1]}"
            d = out.get(name)
            if d is None:
                d = out[name] = Dataset(name=name, columns=[], primary_key=pk_map.get(ident, []))
                names[name] = ident
            d.columns.append(
                Column(name=str(c["COLUMN_NAME"]), type=str(c["DATA_TYPE"]), nullable=c["NULLABLE"] == "Y")
            )
        self._datasets = out
        self._names = names
        return list(out.values())

    async def snapshot(self, dataset: str) -> list[Record]:
        """The whole table, or ConnectorError if it has more than MAX_ROWS rows (never truncated)."""
        rows = await self._read(dataset, MAX_ROWS + 1)
        check_row_cap(len(rows), dataset, MAX_ROWS)
        return rows

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        return await self._read(dataset, max(0, min(int(limit), MAX_ROWS)))

    async def _read(self, dataset: str, n: int) -> list[Record]:
        owner, table = await self._resolve(dataset)
        query = f"SELECT * FROM {quote_ident(owner)}.{quote_ident(table)} FETCH FIRST :n ROWS ONLY"  # noqa: S608

        def read(c: Any) -> list[dict[str, Any]]:
            c.rollback()  # SET TRANSACTION must start a fresh transaction
            cur = c.cursor()
            cur.execute("SET TRANSACTION READ ONLY")
            try:
                cur.execute(query, {"n": n}, fetch_lobs=False)
                return _fetch_dicts(cur)
            finally:
                c.rollback()

        return [normalize_record(r) for r in await self._run(read)]

    # -- helpers ----------------------------------------------------------

    async def _resolve(self, dataset: str) -> tuple[str, str]:
        if self._datasets is None or dataset not in self._names:
            await self.discover()
        if dataset not in self._names:
            raise ConnectorError(
                f"Table {dataset!r} isn't readable with this user",
                hint="Check the table name (usually OWNER.TABLE in UPPER CASE) and that the user has SELECT on it.",
            )
        return self._names[dataset]


def _close_quietly(conn: Any) -> None:
    try:
        conn.close()
    except Exception:  # noqa: BLE001, S110 - closing a broken connection
        pass


def _connection_hint(message: str, encryption: str) -> str:
    m = message.lower()
    # Resolver errors first: "Name or service not known" mentions "service" (LIVEOPS-47).
    if any(
        w in m
        for w in (
            "getaddrinfo",
            "name or service not known",
            "nodename nor servname",
            "temporary failure in name resolution",
            "no address associated",
            "errno -2",
            "errno -3",
            "errno -5",
        )
    ):
        return (
            "Check the host name. From Docker on Windows or Mac, "
            "use host.docker.internal for a database on your own computer."
        )
    if encryption != "off" and ("ssl" in m or "tls" in m or "certificate" in m or "tcps" in m):
        if encryption == "verify":
            return (
                "The server certificate couldn't be verified. Set 'CA certificate file' to the CA that "
                "signed it, check the host name matches the certificate, or use Encryption 'required'."
            )
        return (
            "The server didn't accept an encrypted (TCPS) connection. Use the TCPS port (often 2484), "
            "or set Encryption to Off for local testing only."
        )
    if "ora-12514" in m or "dpy-6001" in m or "ora-12505" in m:
        return "Check the service name (for example FREEPDB1 or ORCLPDB1); ask your DBA for the right one."
    if "refused" in m or "timed out" in m or "timeout" in m or "dpy-6005" in m:
        return "Check the host and port (default 1521, TCPS often 2484) and that a firewall allows the connection."
    return "Check the host, port, service name, user and password."
