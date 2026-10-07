"""SQL Server connector unit tests against a fake DB-API connection.

These check the SQL we generate, identifier quoting, value normalisation,
the change-tracking cursor and that test() never raises or leaks secrets.
They do NOT talk to a real SQL Server; see tests/contract/test_sqlserver_contract.py.
"""

from __future__ import annotations

import datetime as dt
import decimal
import json
import uuid
from typing import Any

import pytest

from app.connectors.base import ChangeOp, ConnectorError
from app.connectors.sqlserver import MAX_ROWS, ChangeTracker, SqlServerConnector, quote_ident
from tests.unit.fake_dbapi import FakeConnection, Result

PASSWORD = "S3cret-Pa55word!"
COLS = ["id", "status", "zone"]


class FakeMssql:
    """Just enough SQL Server to drive discover/snapshot/change tracking."""

    def __init__(self, table: str = "assets", tracked: bool = True) -> None:
        self.table = table
        self.tracked = tracked
        self.rows: dict[str, tuple[Any, ...]] = {
            "A1": ("A1", "free", "ER"),
            "A2": ("A2", "occupied", "ICU"),
            "A3": ("A3", "cleaning", "General"),
        }
        self.version: int | None = 10
        self.min_valid: int | None = 1
        self.changes: list[tuple[int, str]] = []  # (version, id)
        self.whoami: dict[str, Any] = {
            "login_name": "reader",
            "db": "ops",
            "encrypted": "TRUE",
            "is_sysadmin": 0,
            "can_insert": 0,
            "can_update": 0,
            "can_delete": 0,
            "ct_version": 10,
        }

    def change(self, id_: str, row: tuple[Any, ...] | None) -> None:
        assert self.version is not None
        self.version += 1
        if row is None:
            self.rows.pop(id_, None)
        else:
            self.rows[id_] = row
        self.changes.append((self.version, id_))

    def __call__(self, sql: str, params: Any) -> Result:
        if "SUSER_SNAME()" in sql:
            return list(self.whoami), [tuple(self.whoami.values())]
        if "INFORMATION_SCHEMA.COLUMNS" in sql:
            return ["s", "t", "col", "data_type", "nullable"], [
                ("dbo", self.table, c, "nvarchar", "NO" if c == "id" else "YES") for c in COLS
            ]
        if "TABLE_CONSTRAINTS" in sql:
            return ["s", "t", "col"], [("dbo", self.table, "id")]
        if "INFORMATION_SCHEMA.TABLES" in sql:
            return ["s", "t"], [("dbo", self.table)] if self.tracked else []
        if sql == "SELECT CHANGE_TRACKING_CURRENT_VERSION()":
            return ["v"], [(self.version,)]
        if "CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID" in sql:
            return ["c", "m"], [(self.version, self.min_valid)]
        if "CHANGETABLE" in sql:
            limit, since = params
            out = []
            latest: dict[str, int] = {}
            for v, i in self.changes:
                if v > since:
                    latest[i] = v
            for i, v in sorted(latest.items(), key=lambda kv: kv[1]):
                row = self.rows.get(i, (None, None, None))
                out.append((v, i, *row))
            return ["SYS_CHANGE_VERSION", "id", *COLS], out[:limit]
        if sql.startswith("SELECT TOP (%s) * FROM"):
            return COLS, list(self.rows.values())[: params[0]]
        raise AssertionError(f"unexpected SQL: {sql}")


def make(db: Any, **settings: Any) -> tuple[SqlServerConnector, FakeConnection]:
    base = {"host": "sql.example.com", "port": 1433, "database": "ops", "user": "reader"}
    c = SqlServerConnector({**base, **settings}, {"password": PASSWORD})
    fake = FakeConnection(db)
    c._open = lambda: fake  # type: ignore[method-assign]
    return c, fake


# -- quoting / SQL -----------------------------------------------------------


def test_quote_ident_escapes_closing_bracket() -> None:
    assert quote_ident("assets") == "[assets]"
    assert quote_ident("we]ird") == "[we]]ird]"
    assert quote_ident("x]; DROP TABLE y; --") == "[x]]; DROP TABLE y; --]"


@pytest.mark.parametrize("bad", ["", "a\x00b", "x" * 129])
def test_quote_ident_rejects_bad_names(bad: str) -> None:
    with pytest.raises(ConnectorError):
        quote_ident(bad)


def test_connect_settings_are_safe_by_default() -> None:
    c = SqlServerConnector({"host": "h", "port": 1433, "database": "d", "user": "u"}, {"password": PASSWORD})
    kw = c._connect_kwargs()
    assert kw["encryption"] == "require"
    assert kw["read_only"] is True  # ApplicationIntent=ReadOnly
    assert kw["login_timeout"] > 0 and kw["timeout"] > 0
    off = SqlServerConnector({"host": "h", "database": "d", "user": "u", "encryption": "off"}, {})._connect_kwargs()
    assert off["encryption"] == "off"
    assert "password" not in SqlServerConnector.spec.settings_schema["properties"]
    assert SqlServerConnector.spec.maturity == "needs_real_test"


async def test_discover_binds_schemas_and_snapshot_sql_is_quoted() -> None:
    db = FakeMssql(table="we]ird")
    c, fake = make(db, schemas=["dbo", "o'brien"])
    ds = await c.discover()
    assert [d.name for d in ds] == ["dbo.we]ird"]
    assert ds[0].primary_key == ["id"] and ds[0].supports_cdc
    for sql, params, _ in fake.executed:
        assert "o'brien" not in sql  # schema names are only ever bound
        assert params == (json.dumps(["dbo", "o'brien"]),)
    await c.snapshot("dbo.we]ird")
    sql, params, _ = fake.executed[-1]
    assert sql == "SELECT TOP (%s) * FROM [dbo].[we]]ird]"
    assert params == (MAX_ROWS,)


async def test_unknown_dataset_is_rejected_without_running_it() -> None:
    c, fake = make(FakeMssql())
    with pytest.raises(ConnectorError):
        await c.preview("dbo.assets]; DROP TABLE assets; --")
    assert not any("DROP" in s for s in fake.sql())


async def test_snapshot_values_are_json_safe() -> None:
    db = FakeMssql()
    db.rows = {
        "A1": (
            "A1",
            dt.datetime(2026, 1, 2, 3, 4, 5, tzinfo=dt.UTC),
            decimal.Decimal("1.50"),
        )
    }
    weird = {"A1": ("A1", uuid.UUID(int=1), b"\x00\xff"), "A2": ("A2", float("nan"), "Zürich ✓")}
    c, _ = make(db)
    rows = await c.snapshot("dbo.assets")
    assert rows == [{"id": "A1", "status": "2026-01-02T03:04:05+00:00", "zone": 1.5}]
    db.rows = weird
    rows = await c.snapshot("dbo.assets")
    json.dumps(rows)
    assert rows[0] == {"id": "A1", "status": "00000000-0000-0000-0000-000000000001", "zone": "AP8="}
    assert rows[1] == {"id": "A2", "status": None, "zone": "Zürich ✓"}


# -- test() ------------------------------------------------------------------


async def test_test_reports_every_check_when_good() -> None:
    c, _ = make(FakeMssql(), mode="cdc")
    report = await c.test()
    names = [s.name for s in report.steps]
    assert report.ok, report.steps
    assert names == [
        "Reach the server",
        "Sign in",
        "Encryption",
        "Read-only login",
        "List tables",
        "Change tracking on the database",
        "Change tracking on tables",
    ]


async def test_test_flags_writable_login_and_unencrypted_session() -> None:
    db = FakeMssql()
    db.whoami.update(encrypted="FALSE", can_insert=1, is_sysadmin=1)
    c, _ = make(db)
    report = await c.test()
    steps = {s.name: s for s in report.steps}
    assert not report.ok
    assert not steps["Encryption"].ok and "TLS" in steps["Encryption"].hint
    assert not steps["Read-only login"].ok
    assert "sysadmin" in steps["Read-only login"].detail
    assert "db_datareader" in steps["Read-only login"].hint


async def test_test_gives_exact_sql_to_enable_change_tracking() -> None:
    db = FakeMssql(tracked=False)
    db.whoami["ct_version"] = None
    c, _ = make(db, mode="cdc", database="ops")
    report = await c.test()
    steps = {s.name: s for s in report.steps}
    assert not steps["Change tracking on the database"].ok
    assert (
        "ALTER DATABASE [ops] SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);"
        in steps["Change tracking on the database"].hint
    )
    assert not steps["Change tracking on tables"].ok
    assert "ENABLE CHANGE_TRACKING" in steps["Change tracking on tables"].hint
    assert "GRANT VIEW CHANGE TRACKING" in steps["Change tracking on tables"].hint


class FakeDriverError(Exception):
    pass


FakeDriverError.__name__ = "OperationalError"


@pytest.mark.parametrize(
    ("message", "first_failed"),
    [
        (b"Login failed for user 'reader'. (18456) password=" + PASSWORD.encode(), "Sign in"),
        (b"Unable to connect: TDS server is unavailable or does not exist " + PASSWORD.encode(), "Reach the server"),
    ],
)
async def test_test_never_raises_or_leaks_password_on_connect_errors(message: bytes, first_failed: str) -> None:
    c = SqlServerConnector({"host": "h", "port": 1, "database": "d", "user": "u"}, {"password": PASSWORD})

    def boom() -> Any:
        raise FakeDriverError(20002, message)

    c._open = boom  # type: ignore[method-assign]
    report = await c.test()
    assert not report.ok
    failed = next(s for s in report.steps if not s.ok)
    assert failed.name == first_failed and failed.detail and failed.hint
    assert PASSWORD not in report.model_dump_json()


async def test_test_never_raises_when_a_query_fails() -> None:
    def responder(sql: str, params: Any) -> Result:
        raise FakeDriverError(208, f"Invalid object name; pw {PASSWORD}".encode())

    c, _ = make(responder)
    report = await c.test()
    assert not report.ok
    assert any(not s.ok and s.detail for s in report.steps)
    assert PASSWORD not in report.model_dump_json()


async def test_close_is_idempotent_and_closes_connection() -> None:
    c, fake = make(FakeMssql())
    await c.discover()
    await c.close()
    await c.close()
    assert fake.closed == 1


# -- change tracking ---------------------------------------------------------


async def start_tracker(db: FakeMssql) -> tuple[ChangeTracker, FakeConnection, list[Any]]:
    c, fake = make(db, mode="cdc")
    t = ChangeTracker(c, "dbo.assets", ["id"])
    await t.start()
    return t, fake, t.initial()


async def test_cdc_initial_state_then_changes_and_cursor_advances() -> None:
    db = FakeMssql()
    t, fake, first = await start_tracker(db)
    assert [(ch.op, ch.key) for ch in first] == [(ChangeOp.UPSERT, k) for k in ("A1", "A2", "A3")]
    assert t.version == 10

    db.change("A9", ("A9", "free", "ER"))
    db.change("A1", ("A1", "occupied", "ER"))
    db.change("A3", None)
    out = await t.poll()
    assert [(ch.op, ch.key, ch.record.get("status")) for ch in out] == [
        (ChangeOp.UPSERT, "A9", "free"),
        (ChangeOp.UPSERT, "A1", "occupied"),
        (ChangeOp.DELETE, "A3", None),
    ]
    assert t.version == 13
    sql, params, _ = fake.executed[-1]
    assert "FROM CHANGETABLE(CHANGES [dbo].[assets], %s) AS ct" in sql
    assert "LEFT OUTER JOIN [dbo].[assets] AS t ON t.[id] = ct.[id]" in sql
    assert params == (MAX_ROWS + 1, 10)
    assert await t.poll() == []  # nothing new
    assert fake.executed[-1][1] == (MAX_ROWS + 1, 13)


async def test_cdc_dedupes_rows_seen_again_and_deletes_of_unknown_rows() -> None:
    db = FakeMssql()
    t, _, _ = await start_tracker(db)
    db.change("A1", ("A1", "free", "ER"))  # same values as the snapshot
    db.change("ZZ", None)  # deleted before we ever saw it
    assert await t.poll() == []


async def test_cdc_cursor_older_than_retention_triggers_full_resync() -> None:
    db = FakeMssql()
    t, _, _ = await start_tracker(db)
    # Cleanup removed history past our cursor; meanwhile rows changed.
    db.rows.pop("A2")
    db.rows["A1"] = ("A1", "occupied", "ER")
    db.rows["A7"] = ("A7", "free", "ER")
    db.version, db.min_valid = 50, 40
    out = await t.poll()
    assert t.resyncs == 1 and t.version == 50
    assert sorted((ch.op.value, ch.key) for ch in out) == [("delete", "A2"), ("upsert", "A1"), ("upsert", "A7")]
    assert all(ch.key != "A3" for ch in out)  # unchanged rows are not re-sent


async def test_cdc_version_going_backwards_triggers_resync() -> None:
    db = FakeMssql()
    t, _, _ = await start_tracker(db)
    db.version, db.min_valid = 3, 0  # database restored from an older backup
    db.rows["A2"] = ("A2", "free", "ICU")
    out = await t.poll()
    assert t.resyncs == 1 and t.version == 3
    assert [(ch.op, ch.key) for ch in out] == [(ChangeOp.UPSERT, "A2")]


async def test_cdc_raises_clear_error_when_tracking_turned_off() -> None:
    db = FakeMssql()
    t, _, _ = await start_tracker(db)
    db.min_valid = None
    with pytest.raises(ConnectorError) as e:
        await t.poll()
    assert "poll mode" in e.value.hint


async def test_cdc_on_untracked_table_explains_how_to_enable() -> None:
    c, _ = make(FakeMssql(tracked=False), mode="cdc")
    gen = c.stream("dbo.assets", ["id"], {"poll_interval_s": 0})
    with pytest.raises(ConnectorError) as e:
        await gen.__anext__()
    assert "ALTER TABLE [dbo].[assets] ENABLE CHANGE_TRACKING" in e.value.hint


async def test_cdc_stream_yields_initial_state_then_diffs() -> None:
    db = FakeMssql()
    c, _ = make(db, mode="cdc")
    gen = c.stream("dbo.assets", ["id"], {"poll_interval_s": 0})
    first = [await gen.__anext__() for _ in range(3)]
    assert {ch.key for ch in first} == {"A1", "A2", "A3"}
    db.change("A2", ("A2", "free", "ICU"))
    ch = await gen.__anext__()
    assert (ch.op, ch.key, ch.record["status"]) == (ChangeOp.UPSERT, "A2", "free")
    await gen.aclose()
    await c.close()


async def test_poll_mode_stream_uses_snapshots() -> None:
    db = FakeMssql()
    c, fake = make(db)  # mode defaults to poll
    gen = c.stream("dbo.assets", ["id"], {"poll_interval_s": 0})
    first = [await gen.__anext__() for _ in range(3)]
    assert {ch.key for ch in first} == {"A1", "A2", "A3"}
    db.rows.pop("A1")
    ch = await gen.__anext__()
    assert (ch.op, ch.key) == (ChangeOp.DELETE, "A1")
    assert not any("CHANGETABLE" in s for s in fake.sql())
    await gen.aclose()
