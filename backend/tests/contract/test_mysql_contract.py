"""MySQL connector against a real MySQL 8 (``LIVEOPS_TEST_MYSQL_DSN``, e.g.
``mysql://root:root@127.0.0.1:3306/``). Skipped when unset; CI always sets it."""

from __future__ import annotations

import asyncio
import os
import statistics
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import unquote, urlparse

import pymysql
import pytest

from app.connectors.base import ChangeOp, Connector, ConnectorError
from app.connectors.mysql import MySQLConnector
from tests.contract.kit import SEED_ROWS, ConnectorContract

MYSQL_DSN = os.environ.get("LIVEOPS_TEST_MYSQL_DSN")
requires_mysql = pytest.mark.skipif(not MYSQL_DSN, reason="LIVEOPS_TEST_MYSQL_DSN not set")
READER_PW = "Reader_pw_1"


def mysql_admin() -> dict[str, Any]:
    assert MYSQL_DSN
    u = urlparse(MYSQL_DSN)
    return {
        "host": u.hostname or "127.0.0.1",
        "port": u.port or 3306,
        "user": unquote(u.username or "root"),
        "password": unquote(u.password or ""),
        "autocommit": True,
        "charset": "utf8mb4",
    }


class MySQLDriver:
    def __init__(self, *, grant_replication: bool = True) -> None:
        suffix = uuid.uuid4().hex[:8]
        self.db = f"lo_test_{suffix}"
        self.user = f"lo_reader_{suffix}"  # users are server-wide: keep unique
        self.dataset = f"{self.db}.assets"
        self.grant_replication = grant_replication

    def _exec_sync(self, statements: list[tuple[str, tuple[Any, ...]]], db: str | None = None) -> None:
        conn = pymysql.connect(**mysql_admin(), database=db)
        try:
            with conn.cursor() as cur:
                for q, params in statements:
                    cur.execute(q, params or None)
        finally:
            conn.close()

    async def _exec(self, q: str, params: tuple[Any, ...] = ()) -> None:
        await asyncio.to_thread(self._exec_sync, [(q, params)], self.db)

    async def setup(self) -> None:
        stmts: list[tuple[str, tuple[Any, ...]]] = [
            (f"CREATE DATABASE `{self.db}` CHARACTER SET utf8mb4", ()),
            (
                f"""CREATE TABLE `{self.db}`.assets (pk BIGINT AUTO_INCREMENT PRIMARY KEY,
                id VARCHAR(64) NULL UNIQUE, status VARCHAR(64), zone TEXT,
                updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), seen DATETIME(3) NULL,
                amount DECIMAL(10,2) DEFAULT 1.50, blob_col VARBINARY(16), doc JSON NULL,
                kind ENUM('bed', 'chair') NULL, tags SET('a', 'b') NULL)""",
                (),
            ),
            (f"CREATE USER '{self.user}'@'%' IDENTIFIED BY '{READER_PW}'", ()),
            (f"GRANT SELECT ON `{self.db}`.* TO '{self.user}'@'%'", ()),
        ]
        if self.grant_replication:
            stmts.append((f"GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '{self.user}'@'%'", ()))
        for r in SEED_ROWS:
            stmts.append(
                (
                    f"INSERT INTO `{self.db}`.assets (id, status, zone) VALUES (%s, %s, %s)",
                    (r["id"], r["status"], r["zone"]),
                )
            )
        await asyncio.to_thread(self._exec_sync, stmts)

    async def teardown(self) -> None:
        def run() -> None:
            conn = pymysql.connect(**mysql_admin())
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT id FROM information_schema.PROCESSLIST WHERE USER = %s", (self.user,))
                    for (pid,) in cur.fetchall():
                        try:
                            cur.execute(f"KILL {int(pid)}")
                        except pymysql.MySQLError:
                            pass
                    cur.execute(f"DROP USER IF EXISTS '{self.user}'@'%'")
                    cur.execute(f"DROP DATABASE IF EXISTS `{self.db}`")
            finally:
                conn.close()

        await asyncio.to_thread(run)

    async def binlog_dump_sessions(self) -> int:
        def run() -> int:
            conn = pymysql.connect(**mysql_admin())
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = %s AND COMMAND LIKE %s",
                        (self.user, "Binlog Dump%"),
                    )
                    return int(cur.fetchone()[0])
            finally:
                conn.close()

        return await asyncio.to_thread(run)

    async def insert_null_key(self, row: dict[str, Any]) -> None:
        await self._exec("INSERT INTO assets (id, status, zone) VALUES (NULL, %s, %s)", (row["status"], row["zone"]))

    async def binlog_dump_ids(self) -> list[int]:
        def run() -> list[int]:
            conn = pymysql.connect(**mysql_admin())
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT ID FROM information_schema.PROCESSLIST WHERE USER = %s AND COMMAND LIKE %s",
                        (self.user, "Binlog Dump%"),
                    )
                    return [int(r[0]) for r in cur.fetchall()]
            finally:
                conn.close()

        return await asyncio.to_thread(run)

    async def kill(self, ids: list[int]) -> None:
        def run() -> None:
            conn = pymysql.connect(**mysql_admin())
            try:
                with conn.cursor() as cur:
                    for i in ids:
                        cur.execute(f"KILL {int(i)}")
            finally:
                conn.close()

        await asyncio.to_thread(run)

    async def insert(self, row: dict[str, Any]) -> None:
        await self._exec(
            "INSERT INTO assets (id, status, zone) VALUES (%s, %s, %s)", (row["id"], row["status"], row["zone"])
        )

    async def update(self, key: str, changes: dict[str, Any]) -> None:
        await self._exec(
            "UPDATE assets SET status = %s, updated_at = CURRENT_TIMESTAMP(6) WHERE id = %s", (changes["status"], key)
        )

    async def delete(self, key: str) -> None:
        await self._exec("DELETE FROM assets WHERE id = %s", (key,))

    def settings(self, **extra: Any) -> dict[str, Any]:
        a = mysql_admin()
        return {
            "host": a["host"],
            "port": a["port"],
            "database": self.db,
            "user": self.user,
            "encryption": "required",  # the local server has TLS on; exercise the default
            **extra,
        }


async def _initial(gen: AsyncIterator[Any], n: int = len(SEED_ROWS)) -> dict[str, Any]:
    """Consume the initial state and the one SNAPSHOT_END marker."""
    seen: dict[str, Any] = {}
    while True:
        ch = await asyncio.wait_for(gen.__anext__(), 10)
        if ch.op == ChangeOp.SNAPSHOT_END:
            break
        assert ch.op == ChangeOp.UPSERT
        seen[ch.key] = ch
    assert len(seen) == n
    return seen


@requires_mysql
class TestMySQLCdcContract(ConnectorContract):
    latency_budget_s = 2.0
    stream_options: dict[str, Any] = {}

    @pytest.fixture
    async def driver(self) -> AsyncIterator[MySQLDriver]:
        d = MySQLDriver()
        await d.setup()
        try:
            yield d
        finally:
            await d.teardown()

    def make_connector(self, driver: MySQLDriver) -> Connector:  # type: ignore[override]
        return MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})

    def make_bad_connector(self, driver: MySQLDriver) -> Connector:  # type: ignore[override]
        return MySQLConnector(driver.settings(mode="cdc"), {"password": "wrong-password"})

    async def test_auto_mode_picks_binlog(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await _initial(gen)
            assert c.active_mode == "cdc"
        finally:
            await gen.aclose()
            await c.close()

    async def test_no_full_table_reread_per_change(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await _initial(gen)
            assert c.snapshot_queries == 1
            for i in range(5):
                await driver.update("A1", {"status": f"s{i}"})
                ch = await asyncio.wait_for(gen.__anext__(), 5)
                assert ch.key == "A1" and ch.record["status"] == f"s{i}"
            assert c.snapshot_queries == 1, "the table must be read once, then only the binlog"
        finally:
            await gen.aclose()
            await c.close()

    async def test_binlog_records_match_snapshot_records(self, driver: MySQLDriver) -> None:
        await driver._exec(
            "UPDATE assets SET seen = '2026-10-06 08:00:00.123', doc = %s, blob_col = x'00ff', kind = 'chair',"
            " tags = 'a,b' WHERE id = 'A2'",
            ('{"beds": 3, "tags": ["ü", "x"]}',),
        )
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            initial = (await _initial(gen))["A2"].record
            before = time.time()
            await driver._exec("UPDATE assets SET zone = 'Zoné' WHERE id = 'A2'")
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.key == "A2" and ch.record["zone"] == "Zoné"
            assert ch.source_ts is not None and before - 2 <= ch.source_ts <= time.time() + 1
            for col in ("updated_at", "seen", "amount", "doc", "blob_col", "status", "kind", "tags"):
                assert ch.record[col] == initial[col], col
            assert initial["doc"] == {"beds": 3, "tags": ["ü", "x"]} and initial["amount"] == 1.5
            assert initial["kind"] == "chair" and initial["blob_col"] == "AP8="  # base64 of 00ff
            assert c.row_lookups >= 1, "binary/ENUM/SET tables are re-read by key, not decoded from the binlog"
            await driver._exec("UPDATE assets SET id = 'A2b' WHERE id = 'A2'")
            ops = [await asyncio.wait_for(gen.__anext__(), 5) for _ in range(2)]
            assert [(x.op, x.key) for x in ops] == [(ChangeOp.DELETE, "A2"), (ChangeOp.UPSERT, "A2b")]
        finally:
            await gen.aclose()
            await c.close()

    async def test_binlog_values_without_binary_columns_match_snapshot(self, driver: MySQLDriver) -> None:
        await driver._exec(
            """CREATE TABLE plain (id INT PRIMARY KEY, status VARCHAR(32), zone TEXT,
            updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), seen DATETIME(3) NULL,
            amount DECIMAL(10,2) DEFAULT 1.50, big BIGINT UNSIGNED, doc JSON NULL, flag TINYINT(1))"""
        )
        await driver._exec(
            "INSERT INTO plain VALUES (1, 'free', 'Zoné ✓', DEFAULT, '2026-10-06 08:00:00.123', 2.25,"
            " 18446744073709551615, %s, 1)",
            ('{"beds": 3, "tags": ["ü", "x"], "n": null}',),
        )
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(f"{driver.db}.plain", ["id"]).__aiter__()
        try:
            initial = (await _initial(gen, 1))["1"].record
            await driver._exec("UPDATE plain SET status = 'occupied' WHERE id = 1")
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.key == "1" and ch.record["status"] == "occupied"
            assert {k: v for k, v in ch.record.items() if k != "status"} == {
                k: v for k, v in initial.items() if k != "status"
            }
            assert initial["big"] == 18446744073709551615 and initial["zone"] == "Zoné ✓"
            await driver._exec("DELETE FROM plain WHERE id = 1")
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.op == ChangeOp.DELETE and ch.key == "1"
            assert c.row_lookups == 0 and c.snapshot_queries == 1
        finally:
            await gen.aclose()
            await c.close()

    async def test_other_tables_are_filtered_out(self, driver: MySQLDriver) -> None:
        await driver._exec("CREATE TABLE other (id INT PRIMARY KEY, v TEXT)")
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await _initial(gen)
            await driver._exec("INSERT INTO other VALUES (1, 'x')")
            await driver.update("A3", {"status": "free"})
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.dataset == driver.dataset and ch.key == "A3"
        finally:
            await gen.aclose()
            await c.close()

    async def test_cdc_latency_p95_under_budget(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        lats: list[float] = []
        try:
            await _initial(gen)
            for i in range(30):
                t0 = time.monotonic()
                await driver.update("A1", {"status": f"p{i}"})
                ch = await asyncio.wait_for(gen.__anext__(), 5)
                assert ch.record["status"] == f"p{i}"
                lats.append(time.monotonic() - t0)
        finally:
            await gen.aclose()
            await c.close()
        p95 = statistics.quantiles(lats, n=20)[18]
        print(f"mysql cdc latency p50={statistics.median(lats) * 1000:.1f}ms p95={p95 * 1000:.1f}ms n={len(lats)}")
        assert p95 < self.latency_budget_s

    async def test_close_stops_binlog_reader(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        await _initial(gen)
        await driver.update("A1", {"status": "x"})
        await asyncio.wait_for(gen.__anext__(), 5)
        assert await driver.binlog_dump_sessions() == 1
        t0 = time.monotonic()
        await c.close()  # the runner closes the connector without closing the generator
        assert time.monotonic() - t0 < 3
        for _ in range(30):
            if await driver.binlog_dump_sessions() == 0:
                break
            await asyncio.sleep(0.1)
        assert await driver.binlog_dump_sessions() == 0
        await gen.aclose()

    async def test_session_is_read_only(self, driver: MySQLDriver) -> None:
        await driver._exec(f"GRANT INSERT ON `{driver.db}`.* TO '{driver.user}'@'%'")
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        try:

            def write(conn: Any) -> None:
                with conn.cursor() as cur:
                    cur.execute(f"INSERT INTO `{driver.db}`.assets (id) VALUES ('evil')")

            with pytest.raises(ConnectorError) as e:
                await c._call(write)
            assert "READ ONLY" in str(e.value).upper()
        finally:
            await c.close()

    async def test_unknown_table_is_rejected(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        try:
            with pytest.raises(ConnectorError):
                await c.preview(f"{driver.db}.assets`; DROP TABLE assets; --")
            with pytest.raises(ConnectorError):
                await c.stream(f"{driver.db}.nope", ["id"]).__anext__()
        finally:
            await c.close()


@requires_mysql
class TestMySQLCdcFixes:
    """Fix round: LIVEOPS-39, 28, 26, 29, 34 and ADR 0004 for the mysql connector."""

    @pytest.fixture
    async def driver(self) -> AsyncIterator[MySQLDriver]:
        d = MySQLDriver()
        await d.setup()
        try:
            yield d
        finally:
            await d.teardown()

    async def test_killed_binlog_connection_raises_so_the_runner_restarts(self, driver: MySQLDriver) -> None:
        """LIVEOPS-39: no silent reconnect that then delivers nothing."""
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await _initial(gen)
            await driver.update("A1", {"status": "before-kill"})
            assert (await asyncio.wait_for(gen.__anext__(), 5)).record["status"] == "before-kill"
            ids = await driver.binlog_dump_ids()
            assert len(ids) == 1
            await driver.kill(ids)
            t0 = time.monotonic()
            with pytest.raises(ConnectorError) as e:
                await asyncio.wait_for(gen.__anext__(), 10)
            took = time.monotonic() - t0
            assert "binary log" in str(e.value).lower() and e.value.hint
            assert took < 3, took
            print(f"mysql binlog kill detected in {took * 1000:.0f}ms")
        finally:
            await gen.aclose()
            await c.close()
        # What the runner does next: a new connector, fresh snapshot + marker, then live changes again.
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await _initial(gen)
            await driver.update("A2", {"status": "after-kill"})
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert (ch.key, ch.record["status"]) == ("A2", "after-kill")
        finally:
            await gen.aclose()
            await c.close()

    async def test_killed_sessions_through_the_runner_show_error_then_recover(self, driver: MySQLDriver) -> None:
        """LIVEOPS-39 end to end: Health shows the error, then the runner's retry delivers changes."""
        from app.core.mapping import MappingConfig
        from app.core.runner import MappingSpec, RunnerManager
        from app.core.state import InMemoryStateStore

        state = InMemoryStateStore()
        runner = RunnerManager(state)
        spec = MappingSpec(
            mapping_id="m1",
            site_id="s1",
            source_id="src1",
            source_type="mysql",
            settings=driver.settings(mode="cdc"),
            secrets={"password": READER_PW},
            dataset=driver.dataset,
            config=MappingConfig(id_field="id", fields={"state": "status"}),
            options={},
        )

        async def asset_state(asset: str) -> object:
            for a in await state.site_assets("s1"):
                if a.asset_id == asset:
                    return a.flat().get("state")
            return None

        async def wait_for(pred: Any, within: float) -> bool:
            end = time.monotonic() + within
            while time.monotonic() < end:
                if await pred():
                    return True
                await asyncio.sleep(0.05)
            return False

        await runner.start(spec)
        try:
            assert await wait_for(lambda: _is(asset_state("A1"), "free"), 10)
            assert await wait_for(lambda: _true_async(driver.binlog_dump_ids()), 5)
            await driver.kill(await driver.binlog_dump_ids())
            h = runner.health["m1"]
            assert await wait_for(lambda: _true(h.last_error is not None), 5), "Health must show the failure"
            assert "binary log" in (h.last_error or "").lower()
            await asyncio.sleep(1.5)  # runner backoff (1 s) and reconnect
            await driver.update("A1", {"status": "k0"})
            assert await wait_for(lambda: _is(asset_state("A1"), "k0"), 5), "changes must flow again"
        finally:
            await runner.stop_all()

    async def test_mapping_key_change_and_key_to_null(self, driver: MySQLDriver) -> None:
        """LIVEOPS-28 (MySQL side): ``id`` is not the PK; before/after images give the old key."""
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await _initial(gen)
            await driver._exec("UPDATE assets SET id = 'A1x' WHERE id = 'A1'")
            ops = [await asyncio.wait_for(gen.__anext__(), 5) for _ in range(2)]
            assert [(x.op, x.key) for x in ops] == [(ChangeOp.DELETE, "A1"), (ChangeOp.UPSERT, "A1x")]
            await driver._exec("UPDATE assets SET id = NULL WHERE id = 'A2'")
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert (ch.op, ch.key) == (ChangeOp.DELETE, "A2")
            await driver.insert_null_key({"status": "free", "zone": "ER"})
            await driver.update("A3", {"status": "next"})
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.key == "A3" and c.skipped_records == 2
        finally:
            await gen.aclose()
            await c.close()

    @pytest.mark.parametrize("mode", ["cdc", "poll"])
    async def test_more_rows_than_the_cap_raise_instead_of_truncating(
        self, driver: MySQLDriver, mode: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """LIVEOPS-34: 3 rows with a cap of 2 must fail loudly; exactly the cap is fine."""
        import app.connectors.mysql as mysql_mod

        monkeypatch.setattr(mysql_mod, "MAX_ROWS", 2)
        c = MySQLConnector(driver.settings(mode=mode), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"], {"poll_interval_s": 0.5}).__aiter__()
        try:
            with pytest.raises(ConnectorError) as e:
                await asyncio.wait_for(gen.__anext__(), 10)
            assert "more than 2 rows" in str(e.value) and e.value.hint
        finally:
            await gen.aclose()
            await c.close()
        await driver.delete("A3")
        c = MySQLConnector(driver.settings(mode=mode), {"password": READER_PW})
        gen = c.stream(driver.dataset, ["id"], {"poll_interval_s": 0.5}).__aiter__()
        try:
            await _initial(gen, 2)
        finally:
            await gen.aclose()
            await c.close()

    async def test_verify_checks_the_server_certificate(self, driver: MySQLDriver) -> None:
        """LIVEOPS-29: the local server's auto-generated certificate is not trusted, so 'verify' fails."""
        c = MySQLConnector(driver.settings(encryption="verify"), {"password": READER_PW})
        try:
            report = await c.test()
        finally:
            await c.close()
        assert not report.ok and report.steps[0].name == "Reach the server" and not report.steps[0].ok
        assert "certificate" in (report.steps[0].detail + report.steps[0].hint).lower()
        c = MySQLConnector(driver.settings(), {"password": READER_PW})
        try:
            report = await c.test()
        finally:
            await c.close()
        enc = next(s for s in report.steps if s.name == "Encryption")
        assert enc.ok and "NOT verified" in enc.detail


async def _is(value: Any, expected: object) -> bool:
    return bool(await value == expected)


async def _true(v: bool) -> bool:
    return v


async def _true_async(v: Any) -> bool:
    return bool(await v)


@requires_mysql
class TestMySQLPollContract(ConnectorContract):
    latency_budget_s = 5.0
    stream_options: dict[str, Any] = {"poll_interval_s": 0.5}

    @pytest.fixture
    async def driver(self) -> AsyncIterator[MySQLDriver]:
        d = MySQLDriver(grant_replication=False)
        await d.setup()
        try:
            yield d
        finally:
            await d.teardown()

    def make_connector(self, driver: MySQLDriver) -> Connector:  # type: ignore[override]
        return MySQLConnector(driver.settings(mode="poll", encryption="off"), {"password": READER_PW})

    def make_bad_connector(self, driver: MySQLDriver) -> Connector:  # type: ignore[override]
        return MySQLConnector(driver.settings(mode="poll", encryption="off"), {"password": "wrong-password"})

    async def test_auto_falls_back_to_poll_without_replication_grants(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(), {"password": READER_PW})
        try:
            report = await c.test()
            assert report.ok, report.steps
            step = next(s for s in report.steps if s.name == "Replication permission")
            assert "REPLICATION SLAVE" in step.hint and "poll" in step.hint
            gen = c.stream(driver.dataset, ["id"], {"poll_interval_s": 0.5}).__aiter__()
            try:
                await _initial(gen)
                assert c.active_mode == "poll"
            finally:
                await gen.aclose()
        finally:
            await c.close()

    async def test_cdc_mode_explains_missing_grants(self, driver: MySQLDriver) -> None:
        c = MySQLConnector(driver.settings(mode="cdc"), {"password": READER_PW})
        try:
            report = await c.test()
            step = next(s for s in report.steps if s.name == "Replication permission")
            assert not report.ok and not step.ok and "GRANT REPLICATION SLAVE" in step.hint
            assert READER_PW not in report.model_dump_json()
            with pytest.raises(ConnectorError) as e:
                await c.stream(driver.dataset, ["id"]).__anext__()
            assert "GRANT REPLICATION" in e.value.hint
        finally:
            await c.close()

    async def test_unreachable_server_is_explained(self, driver: MySQLDriver) -> None:
        c = MySQLConnector({**driver.settings(), "port": 1}, {"password": READER_PW})
        try:
            report = await c.test()
        finally:
            await c.close()
        assert not report.ok and report.steps[0].name == "Reach the server" and report.steps[0].hint
