"""Shared connector contract kit.

Every connector gets a test module that subclasses ``ConnectorContract`` and
implements three hooks. The kit then runs the same checks on every connector,
so all sources behave the same way for the rest of the system.

    class TestMyConnector(ConnectorContract):
        latency_budget_s = 5.0

        @pytest.fixture
        async def driver(self) -> AsyncIterator[SourceDriver]:
            ...  # create a real dataset in a real (or local) system

        def make_connector(self, driver) -> Connector: ...
        def make_bad_connector(self, driver) -> Connector: ...  # wrong password

The fixture dataset has these columns (types as the source allows):
    id (key, text or int), status (text), zone (text), updated_at (timestamp),
    amount (decimal/numeric)
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any, Protocol

import pytest

from app.connectors.base import Change, ChangeOp, Connector, ConnectorSpec

SEED_ROWS: list[dict[str, Any]] = [
    {"id": "A1", "status": "free", "zone": "ER"},
    {"id": "A2", "status": "occupied", "zone": "ICU"},
    {"id": "A3", "status": "cleaning", "zone": "General"},
]


class SourceDriver(Protocol):
    """Manipulates the real source system for the test (not via the connector)."""

    dataset: str  # dataset name as discover() will report it

    async def insert(self, row: dict[str, Any]) -> None: ...
    async def update(self, key: str, changes: dict[str, Any]) -> None: ...
    async def delete(self, key: str) -> None: ...


async def _next_matching(gen: AsyncIterator[Change], pred: Any, within: float) -> tuple[Change, float]:
    started = time.monotonic()
    while True:
        remaining = within - (time.monotonic() - started)
        if remaining <= 0:
            raise AssertionError(f"no matching change within {within}s")
        ch = await asyncio.wait_for(gen.__anext__(), remaining)
        if pred(ch):
            return ch, time.monotonic() - started


class ConnectorContract:
    """Subclass me. See module docstring."""

    latency_budget_s: float = 10.0
    stream_options: dict[str, Any] = {"poll_interval_s": 0.5}

    # -- hooks ------------------------------------------------------------

    def make_connector(self, driver: SourceDriver) -> Connector:
        raise NotImplementedError

    def make_bad_connector(self, driver: SourceDriver) -> Connector:
        raise NotImplementedError

    # -- checks -----------------------------------------------------------

    @pytest.mark.contract
    def test_spec_is_valid(self, driver: SourceDriver) -> None:
        spec: ConnectorSpec = type(self.make_connector(driver)).spec
        props = spec.settings_schema.get("properties", {})
        assert props, "settings_schema needs properties so the UI can render a form"
        assert set(spec.settings_schema.get("required", [])) <= set(props)
        secret_names = set(spec.secrets_schema.get("properties", {}))
        assert not (secret_names & set(props)), "secret fields must not also be plain settings"
        for name in ("password", "token", "secret", "api_key"):
            assert name not in props, f"{name!r} must be in secrets_schema, not settings_schema"
        assert spec.modes, "declare at least one mode"

    @pytest.mark.contract
    async def test_test_passes_with_good_settings(self, driver: SourceDriver) -> None:
        c = self.make_connector(driver)
        try:
            report = await c.test()
        finally:
            await c.close()
        failed = [s for s in report.steps if not s.ok]
        assert report.ok, f"test() failed: {failed}"
        assert len(report.steps) >= 2, "test() should report each check as its own step"

    @pytest.mark.contract
    async def test_test_reports_bad_credentials_without_raising(self, driver: SourceDriver) -> None:
        c = self.make_bad_connector(driver)
        try:
            report = await c.test()
        finally:
            await c.close()
        assert not report.ok
        assert any(not s.ok and s.detail for s in report.steps), "a failed step must say what went wrong"
        dumped = report.model_dump_json()
        for v in c.secrets.values():
            if v:
                assert str(v) not in dumped, "test report must never contain secret values"

    @pytest.mark.contract
    async def test_discover_lists_fixture_dataset(self, driver: SourceDriver) -> None:
        c = self.make_connector(driver)
        try:
            names = {d.name: d for d in await c.discover()}
        finally:
            await c.close()
        assert driver.dataset in names, f"{driver.dataset} not in {sorted(names)[:20]}"
        cols = {col.name for col in names[driver.dataset].columns}
        assert {"id", "status", "zone"} <= cols

    @pytest.mark.contract
    async def test_preview_is_json_safe(self, driver: SourceDriver) -> None:
        c = self.make_connector(driver)
        try:
            rows = await c.preview(driver.dataset, limit=2)
        finally:
            await c.close()
        assert 1 <= len(rows) <= 2
        json.dumps(rows)  # datetimes, decimals, bytes must already be normalised

    @pytest.mark.contract
    async def test_stream_initial_state_then_changes(self, driver: SourceDriver) -> None:
        c = self.make_connector(driver)
        gen = c.stream(driver.dataset, ["id"], self.stream_options).__aiter__()
        try:
            seen: dict[str, Change] = {}
            while len(seen) < len(SEED_ROWS):
                ch = await asyncio.wait_for(gen.__anext__(), self.latency_budget_s * 2)
                assert ch.op == ChangeOp.UPSERT, "initial state must arrive as upserts"
                seen[ch.key] = ch
            assert set(seen) >= {r["id"] for r in SEED_ROWS}
            json.dumps([s.record for s in seen.values()])

            await driver.insert({"id": "A9", "status": "free", "zone": "ER"})
            ch, lat_insert = await _next_matching(
                gen, lambda x: x.key == "A9" and x.op == ChangeOp.UPSERT, self.latency_budget_s
            )
            assert ch.record.get("status") == "free"

            await driver.update("A1", {"status": "occupied"})
            ch, lat_update = await _next_matching(
                gen, lambda x: x.key == "A1" and x.record.get("status") == "occupied", self.latency_budget_s
            )

            await driver.delete("A3")
            ch, lat_delete = await _next_matching(
                gen, lambda x: x.key == "A3" and x.op == ChangeOp.DELETE, self.latency_budget_s
            )
            print(f"latency insert={lat_insert:.2f}s update={lat_update:.2f}s delete={lat_delete:.2f}s")
        finally:
            await gen.aclose()
            await c.close()

    @pytest.mark.contract
    async def test_close_is_idempotent(self, driver: SourceDriver) -> None:
        c = self.make_connector(driver)
        await c.close()
        await c.close()
