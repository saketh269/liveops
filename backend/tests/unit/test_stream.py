"""WebSocket stream and event-log API, in-process with the in-memory store
(the integration test covers both stores end to end)."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.api import stream
from app.core.events import AssetEvent, AssetOp


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("LIVEOPS_START_RUNNERS", "false")
    monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    monkeypatch.setattr(stream, "PING_INTERVAL_S", 0.3)
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


def _apply(client: TestClient, fields: dict, *, op: AssetOp = AssetOp.UPSERT) -> None:
    store = client.app.state.store  # type: ignore[attr-defined]
    event = AssetEvent(
        site_id="w2", asset_id="B01", op=op, source_id="ehr", mapping_id="m1", dataset="d", fields=fields
    )
    assert client.portal is not None
    client.portal.call(store.apply, event)


def test_ws_snapshot_live_feed_ping_and_unsubscribe(client: TestClient) -> None:
    _apply(client, {"state": "free"})
    store = client.app.state.store  # type: ignore[attr-defined]
    with client.websocket_connect("/ws/sites/w2") as ws:
        snap = json.loads(ws.receive_text())
        assert snap["type"] == "snapshot" and snap["assets"][0]["state"] == "free"
        _apply(client, {"state": "in_use"})
        up = json.loads(ws.receive_text())
        assert up["type"] == "upsert" and up["assets"][0]["state"] == "in_use"
        feed = json.loads(ws.receive_text())
        assert feed["type"] == "event"
        assert feed["event"]["text"] == "B01 is in use (was free)"
        assert feed["event"]["source_id"] == "ehr" and feed["event"]["asset_id"] == "B01"
        started = time.monotonic()
        ping = json.loads(ws.receive_text())
        assert ping["type"] == "ping" and ping["site_id"] == "w2"
        assert time.monotonic() - started < 2
        assert store._fanout.count("w2") == 1
    deadline = time.monotonic() + 3
    while store._fanout.count("w2") and time.monotonic() < deadline:
        time.sleep(0.02)
    assert store._fanout.count("w2") == 0, "subscriber not removed after disconnect"


def test_events_endpoint(client: TestClient) -> None:
    _apply(client, {"state": "free"})
    _apply(client, {"state": "in_use"})
    _apply(client, {}, op=AssetOp.REMOVE)
    all_events = client.get("/api/sites/w2/events").json()
    assert [e["text"] for e in all_events] == ["B01 is now free", "B01 is in use (was free)", "B01 left the map"]
    since = client.get("/api/sites/w2/events", params={"since": all_events[0]["ts"], "limit": 1}).json()
    assert [e["text"] for e in since] == ["B01 is in use (was free)"]
    assert client.get("/api/sites/w2/events", params={"limit": 999999}).status_code == 200
    assert client.get("/api/sites/w2/events", params={"limit": 0}).status_code == 422
    assert client.get("/api/sites/other/events").json() == []
