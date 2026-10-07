"""Platform behaviour fixed after Sprint 1 review (LIVEOPS-22, 23/42, 24, 27, 33, 35, 40, 41, 15)."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from typing import Any, ClassVar

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

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
)
from app.connectors.registry import register
from app.core.events import AssetEvent
from app.core.mapping import MappingConfig
from app.core.runner import MappingSpec, RunnerManager
from app.core.state import InMemoryStateStore
from tests.conftest import requires_pg

ROWS: dict[str, list[Record]] = {}


@register
class FakeConnector(PollingConnector):
    spec: ClassVar[ConnectorSpec] = ConnectorSpec(
        type="fake_test",
        display_name="Fake (tests)",
        category=Category.DATABASE,
        modes=[Mode.POLL],
        settings_schema={"type": "object", "required": ["host"], "properties": {"host": {"type": "string"}}},
        secrets_schema={"type": "object", "properties": {"password": {"type": "string"}}},
    )

    async def test(self) -> TestReport:
        return TestReport(ok=True, steps=[TestStep(name="ok", ok=True), TestStep(name="ok2", ok=True)])

    async def discover(self) -> list[Dataset]:
        if self.settings["host"] == "down":
            raise OSError("connection refused")
        return [Dataset(name="t", columns=[Column(name=c, type="text") for c in ("id", "status", "zone")])]

    async def snapshot(self, dataset: str) -> list[Record]:
        if self.settings["host"] == "down":
            raise ConnectorError("unreachable", hint="check host")
        return list(ROWS.get(self.settings["host"], []))


def spec_for(host: str, mapping_id: str = "m1") -> MappingSpec:
    return MappingSpec(
        mapping_id=mapping_id,
        site_id="s",
        source_id="src",
        source_type="fake_test",
        settings={"host": host},
        secrets={},
        dataset="t",
        config=MappingConfig(id_field="id", fields={"state": "status"}),
        options={"poll_interval_s": 0.5},
    )


async def _wait(cond: Any, within: float = 5.0) -> None:
    end = asyncio.get_running_loop().time() + within
    while not await cond():
        assert asyncio.get_running_loop().time() < end, "timed out"
        await asyncio.sleep(0.05)


async def test_snapshot_reconciles_stale_assets() -> None:
    """An asset this mapping set earlier but missing from a fresh snapshot is removed (LIVEOPS-40)."""
    store = InMemoryStateStore()
    await store.apply(
        AssetEvent(
            site_id="s", asset_id="GONE", source_id="src", mapping_id="m1", dataset="t", fields={"state": "free"}
        )
    )
    await store.apply(
        AssetEvent(site_id="s", asset_id="OTHER", source_id="x", mapping_id="m2", dataset="t", fields={"state": "free"})
    )
    ROWS["h1"] = [{"id": "A", "status": "free", "zone": "ER"}]
    rm = RunnerManager(store)
    await rm.start(spec_for("h1"))
    try:

        async def ok() -> bool:
            ids = {a.asset_id for a in await store.site_assets("s")}
            return ids == {"A", "OTHER"}

        await _wait(ok)
        assert rm.health["m1"].status == "running"
    finally:
        await rm.stop_all()


async def test_null_key_rows_are_skipped_and_counted() -> None:
    store = InMemoryStateStore()
    ROWS["h2"] = [{"id": None, "status": "free"}, {"id": "B", "status": "busy"}]
    rm = RunnerManager(store)
    await rm.start(spec_for("h2"))
    try:

        async def ok() -> bool:
            return [a.asset_id for a in await store.site_assets("s")] == ["B"]

        await _wait(ok)
        assert rm.health["m1"].as_dict()["skipped_records"] >= 1
    finally:
        await rm.stop_all()


async def test_connector_error_hint_reaches_health() -> None:
    rm = RunnerManager(InMemoryStateStore())
    await rm.start(spec_for("down"))
    try:

        async def ok() -> bool:
            return rm.health["m1"].status == "error"

        await _wait(ok)
        assert rm.health["m1"].last_error_hint == "check host"
    finally:
        await rm.stop_all()


def test_change_op_marker_exists() -> None:
    assert Change(op=ChangeOp.SNAPSHOT_END, dataset="t", key="", record={}).op == "snapshot_end"


# ---------------------------------------------------------------- API level


@pytest.fixture
def client(portal_db: str) -> AsyncIterator[TestClient]:  # type: ignore[misc]
    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c


@requires_pg
def test_api_platform_rules(client: TestClient) -> None:
    ROWS["h3"] = [{"id": "A", "status": "free", "zone": "ER"}]
    src = client.post(
        "/api/sources",
        json={"name": "f", "type": "fake_test", "settings": {"host": "h3"}, "secrets": {"password": "s3cret-value"}},
    ).json()
    # 422 must not echo submitted secrets (LIVEOPS-33)
    bad = client.post(
        "/api/sources",
        json={"name": "", "type": "fake_test", "settings": {"host": "h3"}, "secrets": {"password": "s3cret-value"}},
    )
    assert bad.status_code == 422 and "s3cret-value" not in bad.text

    # Changing the host requires re-entering secrets (LIVEOPS-24)
    moved = client.put(f"/api/sources/{src['id']}", json={"settings": {"host": "evil"}})
    assert moved.status_code == 422 and "Re-enter" in moved.json()["detail"]["message"]
    ok = client.put(f"/api/sources/{src['id']}", json={"settings": {"host": "h3"}, "secrets": {"password": None}})
    assert ok.status_code == 200 and ok.json()["secrets_set"] == {}

    site = client.post("/api/sites", json={"name": "S"}).json()
    # poll interval floor (LIVEOPS-35)
    fast = client.post(
        "/api/mappings",
        json={
            "site_id": site["id"],
            "source_id": src["id"],
            "dataset": "t",
            "config": {"id_field": "id"},
            "options": {"poll_interval_s": 0},
        },
    )
    assert fast.status_code == 422

    # Unreachable source gives 502 with a hint, not 500 (LIVEOPS-27)
    down = client.post("/api/sources", json={"name": "d", "type": "fake_test", "settings": {"host": "down"}}).json()
    r = client.post(
        "/api/mappings",
        json={"site_id": site["id"], "source_id": down["id"], "dataset": "t", "config": {"id_field": "id"}},
    )
    assert r.status_code == 502 and r.json()["detail"]["hint"]

    # Unknown Host header refused (LIVEOPS-15, DNS rebinding)
    assert client.get("/api/health", headers={"host": "attacker.example"}).status_code == 400


@requires_pg
def test_websocket_rejects_foreign_origin(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/sites/x", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_text()
    with client.websocket_connect("/ws/sites/x", headers={"origin": "http://localhost:8080"}) as ws:
        assert '"snapshot"' in ws.receive_text()


@requires_pg
def test_changed_secret_key_gives_clear_error(portal_db: str) -> None:
    """LIVEOPS-41: a different LIVEOPS_SECRET_KEY must not crash startup or return 500s."""
    from app.config import get_settings
    from app.main import create_app

    ROWS["h4"] = [{"id": "A", "status": "free", "zone": "ER"}]
    with TestClient(create_app()) as c:
        src = c.post(
            "/api/sources",
            json={"name": "f", "type": "fake_test", "settings": {"host": "h4"}, "secrets": {"password": "x"}},
        ).json()
        site = c.post("/api/sites", json={"name": "S"}).json()
        assert (
            c.post(
                "/api/mappings",
                json={"site_id": site["id"], "source_id": src["id"], "dataset": "t", "config": {"id_field": "id"}},
            ).status_code
            == 201
        )
    old = os.environ["LIVEOPS_SECRET_KEY"]
    os.environ["LIVEOPS_SECRET_KEY"] = Fernet.generate_key().decode()
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as c:  # starts even though secrets can't be read
            r = c.get(f"/api/sources/{src['id']}")  # still listed so the password can be re-entered
            assert r.status_code == 200 and r.json()["secrets_unreadable"] is True and r.json()["warnings"]
            assert c.get("/api/sources").status_code == 200
            health = c.get("/api/health/mappings").json()
            assert health and health[0]["status"] == "error"
            fixed = c.put(f"/api/sources/{src['id']}", json={"secrets": {"password": "x"}})
            assert fixed.status_code == 200 and fixed.json()["secrets_unreadable"] is False
    finally:
        os.environ["LIVEOPS_SECRET_KEY"] = old
        get_settings.cache_clear()
