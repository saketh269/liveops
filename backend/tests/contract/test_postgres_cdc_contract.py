from __future__ import annotations

import asyncio
import statistics
import time
import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest

from app.connectors.base import ChangeOp, Connector, ConnectorError
from app.connectors.postgres_cdc import PostgresCdcConnector
from tests.conftest import requires_pg
from tests.contract.kit import SEED_ROWS, ConnectorContract
from tests.contract.test_postgres_contract import PgDriver


class PgCdcDriver(PgDriver):
    """The poll driver's table and reader role, plus REPLICATION and a publication.

    The mapping key ``id`` is a nullable UNIQUE column and the primary key is a
    separate ``pk``: this exercises keyless rows and key changes that don't touch
    the replica identity (LIVEOPS-28)."""

    key_ddl = "UNIQUE"

    def __init__(self, dbname: str) -> None:
        super().__init__(dbname)
        self.publication = f"lo_pub_{uuid.uuid4().hex[:8]}"

    async def setup(self) -> None:
        await super().setup()
        async with await psycopg.AsyncConnection.connect(**self.admin, autocommit=True) as c:
            await c.execute("ALTER TABLE assets ADD COLUMN pk bigserial PRIMARY KEY")
            await c.execute(f"ALTER ROLE {self.role} WITH REPLICATION")
            await c.execute(f"CREATE PUBLICATION {self.publication} FOR TABLE assets")

    async def teardown(self) -> None:
        # Ending the role's sessions drops any temporary slot it still holds; then
        # make sure nothing is left behind in this database, even after a failure.
        async with await psycopg.AsyncConnection.connect(**{**self.admin, "dbname": "postgres"}, autocommit=True) as c:
            await c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = %s", (self.role,))
            for _ in range(50):
                cur = await c.execute(
                    "SELECT slot_name, active FROM pg_replication_slots WHERE database = %s", (self.dbname,)
                )
                slots = await cur.fetchall()
                if not slots:
                    break
                for name, active in slots:
                    if not active:
                        await c.execute("SELECT pg_drop_replication_slot(%s)", (name,))
                await asyncio.sleep(0.1)
        await super().teardown()

    async def insert_null_key(self, row: dict[str, object]) -> None:
        await self._insert_null_key(row)

    async def slots(self) -> list[str]:
        async with await psycopg.AsyncConnection.connect(**{**self.admin, "dbname": "postgres"}, autocommit=True) as c:
            cur = await c.execute("SELECT slot_name FROM pg_replication_slots WHERE database = %s", (self.dbname,))
            return [r[0] for r in await cur.fetchall()]

    def cdc_settings(self) -> dict[str, object]:
        return {**self.settings(), "publication": self.publication}


@requires_pg
class TestPostgresCdcContract(ConnectorContract):
    latency_budget_s = 2.0
    stream_options: dict[str, object] = {}

    @pytest.fixture
    async def driver(self, temp_database: str) -> AsyncIterator[PgCdcDriver]:
        d = PgCdcDriver(temp_database)
        await d.setup()
        try:
            yield d
        finally:
            await d.teardown()

    def make_connector(self, driver: PgCdcDriver) -> Connector:  # type: ignore[override]
        return PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})

    def make_bad_connector(self, driver: PgCdcDriver) -> Connector:  # type: ignore[override]
        return PostgresCdcConnector(driver.cdc_settings(), {"password": "wrong-password"})

    # -- extra checks -----------------------------------------------------

    async def _initial(self, gen: AsyncIterator, n: int = len(SEED_ROWS)) -> dict[str, object]:
        """Consume the initial state and the one SNAPSHOT_END marker."""
        seen = {}
        while True:
            ch = await asyncio.wait_for(gen.__anext__(), 10)
            if ch.op == ChangeOp.SNAPSHOT_END:
                break
            assert ch.op == ChangeOp.UPSERT
            seen[ch.key] = ch
        assert len(seen) == n
        return seen

    async def test_no_full_table_reread_per_change(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await self._initial(gen)
            assert c.snapshot_queries == 1
            for i in range(5):
                await driver.update("A1", {"status": f"s{i}"})
                ch = await asyncio.wait_for(gen.__anext__(), 5)
                assert ch.key == "A1" and ch.record["status"] == f"s{i}"
            assert c.snapshot_queries == 1, "the table must be read once, then only the change log"
        finally:
            await gen.aclose()
            await c.close()

    async def test_slot_is_temporary_and_gone_after_close(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        await self._initial(gen)
        assert c.last_slot_name in await driver.slots()
        # The runner calls close() without closing the generator: that alone must drop the slot.
        await c.close()
        for _ in range(50):
            if c.last_slot_name not in await driver.slots():
                break
            await asyncio.sleep(0.1)
        assert c.last_slot_name not in await driver.slots()
        await gen.aclose()
        await c.close()

    async def test_changes_carry_commit_time_and_full_record(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            initial = await self._initial(gen)
            before = time.time()
            await driver.update("A2", {"status": "free"})
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.op == ChangeOp.UPSERT and ch.key == "A2"
            assert ch.source_ts is not None and before - 1 <= ch.source_ts <= time.time() + 1
            # Same shape and value types as the initial snapshot (numeric -> number, timestamptz -> ISO).
            assert set(ch.record) == set(initial["A2"].record)  # type: ignore[attr-defined]
            assert ch.record["amount"] == 1.5 and ch.record["zone"] == "ICU"
            assert isinstance(ch.record["updated_at"], str) and "T" in ch.record["updated_at"]
            await driver._exec("INSERT INTO assets (id, status, zone) VALUES (%s, %s, %s)", ("Ü-1", "frei", "Zoné"))
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.key == "Ü-1" and ch.record["zone"] == "Zoné" and ch.record["blob"] is None
            await driver._exec("UPDATE assets SET id = 'A2b' WHERE id = 'A2'", ())
            ops = [await asyncio.wait_for(gen.__anext__(), 5) for _ in range(2)]
            assert [(x.op, x.key) for x in ops] == [(ChangeOp.DELETE, "A2"), (ChangeOp.UPSERT, "A2b")]
            await driver._exec("TRUNCATE assets", ())
            gone = {(await asyncio.wait_for(gen.__anext__(), 5)).key for _ in range(4)}
            assert gone == {"A1", "A3", "A2b", "Ü-1"}
        finally:
            await gen.aclose()
            await c.close()

    async def test_large_toasted_value_survives_unrelated_update(self, driver: PgCdcDriver) -> None:
        big = "x" * 200_000
        await driver._exec("UPDATE assets SET zone = %s WHERE id = 'A1'", (big,))
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await self._initial(gen)
            await driver.update("A1", {"status": "occupied"})
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert ch.record["status"] == "occupied" and ch.record["zone"] == big
        finally:
            await gen.aclose()
            await c.close()

    async def test_cdc_latency_p95_under_budget(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        lats: list[float] = []
        try:
            await self._initial(gen)
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
        print(f"postgres_cdc latency p50={statistics.median(lats) * 1000:.1f}ms p95={p95 * 1000:.1f}ms n={len(lats)}")
        assert p95 < self.latency_budget_s

    async def test_snapshot_session_is_read_only(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        try:
            conn = await c._connect()
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                await conn.execute("CREATE TEMP TABLE t (x int)")
        finally:
            await c.close()

    async def test_unknown_table_is_rejected(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        try:
            with pytest.raises(ConnectorError):
                await c.preview('public.assets"; DROP TABLE assets; --')
            with pytest.raises(ConnectorError):
                await c.stream('public.assets"; --', ["id"]).__anext__()
        finally:
            await c.close()

    async def test_missing_publication_and_replication_explained(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector({**driver.cdc_settings(), "publication": "nope"}, {"password": "reader_pw"})
        try:
            report = await c.test()
            pub = next(s for s in report.steps if s.name == "Publication")
            assert not pub.ok and "CREATE PUBLICATION" in pub.hint
            with pytest.raises(ConnectorError) as e:
                await c.stream(driver.dataset, ["id"]).__anext__()
            assert "PUBLICATION" in e.value.hint
        finally:
            await c.close()
        async with await psycopg.AsyncConnection.connect(**driver.admin, autocommit=True) as a:
            await a.execute(f"ALTER ROLE {driver.role} WITH NOREPLICATION")
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        try:
            report = await c.test()
            step = next(s for s in report.steps if s.name == "Replication permission")
            assert not report.ok and not step.ok and "REPLICATION" in step.hint
            assert "reader_pw" not in report.model_dump_json()
        finally:
            await c.close()

    # -- fix round (LIVEOPS-28, 43, 29, ADR 0004) ----------------------------

    async def test_key_change_without_pk_change_deletes_old_key(self, driver: PgCdcDriver) -> None:
        """LIVEOPS-28: the mapping key is not the PK, so pgoutput sends no old tuple."""
        await driver._exec("UPDATE assets SET zone = %s WHERE id = 'A1'", ("z" * 100_000,))  # TOAST
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await self._initial(gen)
            await driver._exec("UPDATE assets SET id = 'A1-renamed' WHERE id = 'A1'", ())
            ops = [await asyncio.wait_for(gen.__anext__(), 5) for _ in range(2)]
            assert [(x.op, x.key) for x in ops] == [(ChangeOp.DELETE, "A1"), (ChangeOp.UPSERT, "A1-renamed")]
            assert ops[1].record["zone"] == "z" * 100_000  # unchanged TOAST value carried over
            await driver._exec("UPDATE assets SET id = NULL WHERE id = 'A2'", ())
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            assert (ch.op, ch.key) == (ChangeOp.DELETE, "A2") and c.skipped_records == 1
        finally:
            await gen.aclose()
            await c.close()

    async def test_dropped_table_is_reported(self, driver: PgCdcDriver) -> None:
        """LIVEOPS-43: pgoutput is silent about DROP TABLE; the periodic check raises."""
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await self._initial(gen)
            await driver._exec("DROP TABLE assets", ())
            t0 = time.monotonic()
            with pytest.raises(ConnectorError) as e:
                await asyncio.wait_for(gen.__anext__(), 10)
            assert "no longer exists" in str(e.value) and e.value.hint
            assert time.monotonic() - t0 < 7
        finally:
            await gen.aclose()
            await c.close()
        await driver._exec("CREATE TABLE assets (id text)", ())  # teardown revokes on it

    async def test_renamed_table_is_reported(self, driver: PgCdcDriver) -> None:
        """LIVEOPS-43: a change on the renamed table arrives with a new Relation message."""
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await self._initial(gen)
            await driver._exec("ALTER TABLE assets RENAME TO assets_old", ())
            await driver._exec("UPDATE assets_old SET status = 'renamed' WHERE id = 'A1'", ())
            t0 = time.monotonic()
            with pytest.raises(ConnectorError) as e:
                await asyncio.wait_for(gen.__anext__(), 10)
            assert "renamed to public.assets_old" in str(e.value) and "mapping" in e.value.hint
            assert time.monotonic() - t0 < 2
        finally:
            await gen.aclose()
            await c.close()
        await driver._exec("ALTER TABLE assets_old RENAME TO assets", ())

    async def test_renamed_table_without_changes_is_reported(self, driver: PgCdcDriver) -> None:
        c = PostgresCdcConnector(driver.cdc_settings(), {"password": "reader_pw"})
        gen = c.stream(driver.dataset, ["id"]).__aiter__()
        try:
            await self._initial(gen)
            await driver._exec("ALTER TABLE assets RENAME TO assets_old", ())
            with pytest.raises(ConnectorError) as e:
                await asyncio.wait_for(gen.__anext__(), 10)
            assert "renamed" in str(e.value)
        finally:
            await gen.aclose()
            await c.close()
        await driver._exec("ALTER TABLE assets_old RENAME TO assets", ())

    async def test_verify_checks_the_server_certificate(self, driver: PgCdcDriver) -> None:
        """LIVEOPS-29: the local server's self-signed certificate must not pass 'verify'."""
        c = PostgresCdcConnector({**driver.cdc_settings(), "encryption": "verify"}, {"password": "reader_pw"})
        try:
            report = await c.test()
        finally:
            await c.close()
        assert not report.ok and report.steps[0].name == "Reach the server" and not report.steps[0].ok
        assert "certificate" in report.steps[0].detail.lower() or "ssl" in report.steps[0].detail.lower()
        assert "reader_pw" not in report.model_dump_json()
        c = PostgresCdcConnector({**driver.cdc_settings(), "encryption": "required"}, {"password": "reader_pw"})
        try:
            report = await c.test()
        finally:
            await c.close()
        enc = next(s for s in report.steps if s.name == "Encryption")
        assert enc.ok and "NOT verified" in enc.detail
