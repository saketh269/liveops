"""Oracle connector unit tests against a fake DB-API connection.

They check generated SQL, quoting, read-only transactions, TLS settings,
value normalisation, and that test() never raises or leaks secrets. They do
NOT talk to a real Oracle; see tests/contract/test_oracle_contract.py.
"""

from __future__ import annotations

import datetime as dt
import decimal
import json
import ssl
from typing import Any

import pytest

from app.connectors.base import ConnectorError
from app.connectors.oracle import MAX_ROWS, OracleConnector, quote_ident
from tests.unit.fake_dbapi import FakeConnection, Result

PASSWORD = "Or4cle-Secret-pw"


class FakeOracle:
    def __init__(self, table: str = "ASSETS") -> None:
        self.table = table
        self.rows: list[tuple[Any, ...]] = [("A1", "free", "ER"), ("A2", "occupied", "ICU")]
        self.protocol = "tcps"

    def __call__(self, sql: str, params: Any) -> Result:
        if "FROM DUAL" in sql:
            return ["U", "P"], [("READER", self.protocol)]
        if sql == "SET TRANSACTION READ ONLY":
            return [], []
        if "ALL_TAB_COLUMNS" in sql:
            return ["OWNER", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "NULLABLE"], [
                ("APP", self.table, c, "VARCHAR2", "N" if c == "id" else "Y") for c in ("id", "status", "zone")
            ]
        if "ALL_CONSTRAINTS" in sql:
            return ["OWNER", "TABLE_NAME", "COLUMN_NAME"], [("APP", self.table, "id")]
        if "FETCH FIRST :n ROWS ONLY" in sql:
            return ["id", "status", "zone"], self.rows[: params["n"]]
        raise AssertionError(f"unexpected SQL: {sql}")


def make(db: Any, **settings: Any) -> tuple[OracleConnector, FakeConnection]:
    base = {"host": "ora.example.com", "port": 2484, "service_name": "FREEPDB1", "user": "reader", "schemas": ["APP"]}
    c = OracleConnector({**base, **settings}, {"password": PASSWORD})
    fake = FakeConnection(db)
    c._open = lambda: fake  # type: ignore[method-assign]
    return c, fake


def test_quote_ident() -> None:
    assert quote_ident("ASSETS") == '"ASSETS"'
    assert quote_ident("mixed Case") == '"mixed Case"'


@pytest.mark.parametrize("bad", ["", 'X"; DROP TABLE Y; --', "a\x00", "x" * 129])
def test_quote_ident_rejects_injection(bad: str) -> None:
    with pytest.raises(ConnectorError):
        quote_ident(bad)


def test_encryption_settings() -> None:
    def kw(enc: str, **extra: Any) -> dict[str, Any]:
        s = {"host": "h", "port": 2484, "service_name": "S", "user": "u", "encryption": enc, **extra}
        return OracleConnector(s, {"password": PASSWORD})._connect_kwargs()

    default = OracleConnector({"host": "h", "service_name": "S", "user": "u"}, {})._connect_kwargs()
    assert default["protocol"] == "tcps"
    assert default["tcp_connect_timeout"] > 0
    required = kw("required")
    assert required["protocol"] == "tcps" and required["ssl_context"].verify_mode == ssl.CERT_NONE
    verify = kw("verify")
    assert verify["protocol"] == "tcps" and verify["ssl_server_dn_match"] is True
    assert verify["ssl_context"].verify_mode == ssl.CERT_REQUIRED and verify["ssl_context"].check_hostname
    off = kw("off")
    assert off["protocol"] == "tcp" and "ssl_context" not in off
    assert OracleConnector.spec.maturity == "needs_real_test"


async def test_discover_binds_owners() -> None:
    c, fake = make(FakeOracle(), schemas=["APP", "O'BRIEN"])
    ds = await c.discover()
    assert [d.name for d in ds] == ["APP.ASSETS"] and ds[0].primary_key == ["id"]
    sql, params, _ = fake.executed[0]
    assert "OWNER IN (:s0, :s1)" in sql and "O'BRIEN" not in sql
    assert params == {"s0": "APP", "s1": "O'BRIEN"}


async def test_default_schema_is_the_users_own() -> None:
    c, fake = make(FakeOracle(), schemas=[])
    await c.discover()
    assert fake.executed[0][1] == {"s0": "READER"}


async def test_snapshot_is_read_only_quoted_and_bounded() -> None:
    c, fake = make(FakeOracle(table="Mixed Case"))
    rows = await c.snapshot("APP.Mixed Case")
    assert rows == [{"id": "A1", "status": "free", "zone": "ER"}, {"id": "A2", "status": "occupied", "zone": "ICU"}]
    tail = fake.executed[-4:]
    assert [s for s, _, _ in tail] == [
        "ROLLBACK",
        "SET TRANSACTION READ ONLY",
        'SELECT * FROM "APP"."Mixed Case" FETCH FIRST :n ROWS ONLY',
        "ROLLBACK",
    ]
    assert tail[2][1] == {"n": MAX_ROWS} and tail[2][2] == {"fetch_lobs": False}


async def test_discovered_name_with_quote_is_never_executed() -> None:
    c, fake = make(FakeOracle(table='X"; DROP TABLE Y; --'))
    with pytest.raises(ConnectorError):
        await c.snapshot('APP.X"; DROP TABLE Y; --')
    assert not any("DROP" in s for s in fake.sql())


async def test_unknown_dataset_rejected() -> None:
    c, fake = make(FakeOracle())
    with pytest.raises(ConnectorError):
        await c.preview("APP.OTHER")
    assert not any("FETCH FIRST" in s for s in fake.sql())


async def test_values_are_json_safe() -> None:
    db = FakeOracle()
    db.rows = [
        ("A1", dt.datetime(2026, 5, 1, 12, 0), decimal.Decimal("10.25")),
        ("A2", dt.timedelta(minutes=2), b"\x01\x02"),
        ("A3", None, "日本語"),
    ]
    c, _ = make(db)
    rows = await c.snapshot("APP.ASSETS")
    json.dumps(rows)
    assert rows[0] == {"id": "A1", "status": "2026-05-01T12:00:00", "zone": 10.25}
    assert rows[1] == {"id": "A2", "status": 120.0, "zone": "AQI="}
    assert rows[2] == {"id": "A3", "status": None, "zone": "日本語"}


async def test_test_passes_and_lists_steps() -> None:
    c, _ = make(FakeOracle())
    report = await c.test()
    assert report.ok, report.steps
    assert [s.name for s in report.steps] == [
        "Reach the server",
        "Sign in",
        "Encryption",
        "Read-only transactions",
        "List tables",
    ]


async def test_test_flags_plain_tcp_when_encryption_required() -> None:
    db = FakeOracle()
    db.protocol = "tcp"
    c, _ = make(db)
    report = await c.test()
    enc = next(s for s in report.steps if s.name == "Encryption")
    assert not enc.ok and "TCPS" in enc.hint
    c2, _ = make(db, encryption="off")
    assert (await c2.test()).ok


class FakeOraError(Exception):
    pass


@pytest.mark.parametrize(
    ("message", "first_failed"),
    [
        (f"ORA-01017: invalid username/password; logon denied ({PASSWORD})", "Sign in"),
        (f"DPY-6005: cannot connect to database. Connection refused {PASSWORD}", "Reach the server"),
    ],
)
async def test_test_never_raises_or_leaks_password(message: str, first_failed: str) -> None:
    c = OracleConnector({"host": "h", "port": 1, "service_name": "S", "user": "u"}, {"password": PASSWORD})

    def boom() -> Any:
        raise FakeOraError(message)

    c._open = boom  # type: ignore[method-assign]
    report = await c.test()
    assert not report.ok
    failed = next(s for s in report.steps if not s.ok)
    assert failed.name == first_failed and failed.detail and failed.hint
    assert PASSWORD not in report.model_dump_json()


async def test_test_never_raises_when_a_query_fails() -> None:
    def responder(sql: str, params: Any) -> Result:
        raise FakeOraError(f"ORA-00942: table or view does not exist {PASSWORD}")

    c, _ = make(responder)
    report = await c.test()
    assert not report.ok and any(not s.ok and s.detail for s in report.steps)
    assert PASSWORD not in report.model_dump_json()


async def test_close_is_idempotent() -> None:
    c, fake = make(FakeOracle())
    await c.discover()
    await c.close()
    await c.close()
    assert fake.closed == 1


def test_open_sets_call_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    import types

    from app.connectors import oracle

    seen: dict[str, Any] = {}

    def connect(**kw: Any) -> FakeConnection:
        seen.update(kw)
        return FakeConnection(FakeOracle())

    monkeypatch.setattr(oracle, "_driver", lambda: types.SimpleNamespace(connect=connect))
    c = OracleConnector({"host": "h", "service_name": "S", "user": "u"}, {"password": PASSWORD})
    conn = c._open()
    assert conn.call_timeout == oracle.CALL_TIMEOUT_MS
    assert seen["service_name"] == "S" and seen["protocol"] == "tcps"
