"""Webhook connector: events go through the real HTTP route
(``POST /api/webhooks/{id}``) and the real portal DB, signed like a sender would."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.connectors.base import ChangeOp, Connector
from app.connectors.webhook import SIGNATURE_HEADER, TIMESTAMP_HEADER, SignatureError, WebhookConnector, sign, verify
from tests.conftest import requires_pg
from tests.contract.kit import SEED_ROWS, ConnectorContract
from tests.contract.portal import portal_app


def signed_headers(secret: str, body: bytes, ts: int | None = None) -> dict[str, str]:
    t = str(int(time.time()) if ts is None else ts)
    return {"Content-Type": "application/json", TIMESTAMP_HEADER: t, SIGNATURE_HEADER: sign(secret, t, body)}


class WebhookDriver:
    dataset = "events"

    def __init__(self, client: httpx.AsyncClient, source_id: str, secret: str) -> None:
        self.client, self.source_id, self.secret = client, source_id, secret
        self.rows: dict[str, dict[str, Any]] = {}

    async def post(self, payload: Any, *, secret: str | None = None, ts: int | None = None) -> httpx.Response:
        body = json.dumps(payload).encode()
        return await self.client.post(
            f"/api/webhooks/{self.source_id}", content=body, headers=signed_headers(secret or self.secret, body, ts)
        )

    async def _send(self, payload: Any) -> None:
        r = await self.post(payload)
        assert r.status_code == 202, r.text

    async def insert(self, row: dict[str, Any]) -> None:
        self.rows[row["id"]] = {**row, "updated_at": time.time(), "amount": 1.5}
        await self._send(self.rows[row["id"]])

    async def update(self, key: str, changes: dict[str, Any]) -> None:
        self.rows[key] = {**self.rows[key], **changes, "updated_at": time.time()}
        await self._send(self.rows[key])

    async def delete(self, key: str) -> None:
        self.rows.pop(key, None)
        await self._send({"id": key, "_deleted": True})


@pytest.fixture
def app(temp_database: str) -> Iterator[FastAPI]:
    with portal_app(temp_database) as a:
        yield a


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as c:
        yield c


async def make_source(client: httpx.AsyncClient, **settings: Any) -> tuple[str, str]:
    secret = uuid.uuid4().hex  # unique per test: the in-process buffer is global
    r = await client.post(
        "/api/sources",
        json={
            "name": "pushed",
            "type": "webhook",
            "settings": {"key_field": "id", **settings},
            "secrets": {"signing_secret": secret},
        },
    )
    assert r.status_code == 201, r.text
    assert secret not in r.text
    return r.json()["id"], secret


@pytest.fixture
async def wh(client: httpx.AsyncClient) -> WebhookDriver:
    source_id, secret = await make_source(client)
    return WebhookDriver(client, source_id, secret)


@requires_pg
class TestWebhookContract(ConnectorContract):
    latency_budget_s = 2.0

    @pytest.fixture
    async def driver(self, wh: WebhookDriver) -> AsyncIterator[WebhookDriver]:
        for r in SEED_ROWS:
            await wh.insert(dict(r))
        yield wh

    def make_connector(self, driver: WebhookDriver) -> Connector:  # type: ignore[override]
        return WebhookConnector({"key_field": "id"}, {"signing_secret": driver.secret})

    def make_bad_connector(self, driver: WebhookDriver) -> Connector:  # type: ignore[override]
        return WebhookConnector({"key_field": "id"}, {"signing_secret": "short"})


# -- focused tests through the route ------------------------------------------

pg = requires_pg


@pg
async def test_bad_signature_is_401(wh: WebhookDriver) -> None:
    r = await wh.post({"id": "X"}, secret="0" * 32)
    assert r.status_code == 401
    assert "Signature doesn't match" in r.json()["detail"]["message"]


@pg
async def test_missing_headers_is_401(wh: WebhookDriver) -> None:
    r = await wh.client.post(f"/api/webhooks/{wh.source_id}", json={"id": "X"})
    assert r.status_code == 401
    assert TIMESTAMP_HEADER in r.json()["detail"]["message"]


@pg
async def test_old_timestamp_is_401(wh: WebhookDriver) -> None:
    r = await wh.post({"id": "X"}, ts=int(time.time()) - 6 * 60)
    assert r.status_code == 401
    assert "5 minutes" in r.json()["detail"]["message"]


@pg
async def test_future_timestamp_is_401(wh: WebhookDriver) -> None:
    r = await wh.post({"id": "X"}, ts=int(time.time()) + 6 * 60)
    assert r.status_code == 401


@pg
async def test_replayed_request_is_401(wh: WebhookDriver) -> None:
    body = json.dumps({"id": "X", "status": "free"}).encode()
    headers = signed_headers(wh.secret, body)
    first = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=headers)
    again = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=headers)
    assert first.status_code == 202
    assert again.status_code == 401
    assert "already received" in again.json()["detail"]["message"]


@pg
async def test_changed_timestamp_breaks_signature(wh: WebhookDriver) -> None:
    body = json.dumps({"id": "X"}).encode()
    headers = signed_headers(wh.secret, body, ts=int(time.time()) - 60)
    headers[TIMESTAMP_HEADER] = str(int(time.time()))  # replayer refreshes the timestamp
    r = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=headers)
    assert r.status_code == 401


@pg
async def test_oversized_body_is_413(client: httpx.AsyncClient) -> None:
    source_id, secret = await make_source(client, max_body_kb=1)
    d = WebhookDriver(client, source_id, secret)
    r = await d.post([{"id": str(i), "pad": "x" * 100} for i in range(20)])
    assert r.status_code == 413
    assert "1 KB" in r.json()["detail"]["message"]
    assert r.json()["detail"]["hint"]


@pg
async def test_invalid_json_is_422(wh: WebhookDriver) -> None:
    body = b"{not json"
    r = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=signed_headers(wh.secret, body))
    assert r.status_code == 422
    assert "not valid JSON" in r.json()["detail"]["message"]


@pg
async def test_record_without_key_is_422(wh: WebhookDriver) -> None:
    r = await wh.post([{"id": "ok"}, {"status": "free"}])
    assert r.status_code == 422
    assert "Record 1 has no 'id'" in r.json()["detail"]["message"]


@pg
async def test_unknown_source_is_404(wh: WebhookDriver) -> None:
    body = b"{}"
    r = await wh.client.post("/api/webhooks/doesnotexist", content=body, headers=signed_headers(wh.secret, body))
    assert r.status_code == 404


@pg
async def test_list_body_and_delete_reach_stream(wh: WebhookDriver) -> None:
    r = await wh.post([{"id": "B1", "status": "free"}, {"id": "B2", "status": "in_use"}])
    assert r.json() == {"accepted": 2}
    await wh.post({"id": "B1", "_deleted": True})
    c = WebhookConnector({"key_field": "id"}, {"signing_secret": wh.secret})
    gen = c.stream("events", ["id"]).__aiter__()
    try:
        first = await gen.__anext__()
        assert first.key == "B2" and first.op == ChangeOp.UPSERT and "_deleted" not in first.record
        t0 = time.monotonic()
        await wh.post({"id": "B2", "_deleted": True})
        ch = await gen.__anext__()
        assert ch.op == ChangeOp.DELETE and ch.key == "B2"
        assert time.monotonic() - t0 < 1.0
    finally:
        await gen.aclose()


@pg
async def test_state_buffer_is_bounded(client: httpx.AsyncClient) -> None:
    source_id, secret = await make_source(client, max_records=5)
    d = WebhookDriver(client, source_id, secret)
    await d.post([{"id": str(i)} for i in range(20)])
    c = WebhookConnector({"key_field": "id", "max_records": 5}, {"signing_secret": secret})
    assert [r["id"] for r in await c.preview("events")] == ["15", "16", "17", "18", "19"]


# -- pure unit tests ----------------------------------------------------------


def test_verify_accepts_good_and_rejects_tampered_body() -> None:
    now = 1_800_000_000
    sig = sign("s" * 20, str(now), b'{"id":1}')
    verify("s" * 20, str(now), sig, b'{"id":1}', now=now)
    with pytest.raises(SignatureError):
        verify("s" * 20, str(now), sig, b'{"id":2}', now=now)
    with pytest.raises(SignatureError):
        verify("s" * 20, "not-a-number", sig, b'{"id":1}', now=now)
    with pytest.raises(SignatureError):
        verify("s" * 20, str(now - 301), sign("s" * 20, str(now - 301), b"{}"), b"{}", now=now)
    verify("s" * 20, str(now - 299), sign("s" * 20, str(now - 299), b"{}"), b"{}", now=now)


async def test_slow_consumer_gets_clear_error_then_restarts_from_state(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from app.connectors import webhook as wmod
    from app.connectors.base import ConnectorError

    monkeypatch.setattr(wmod, "SUBSCRIBER_QUEUE", 3)
    secret = uuid.uuid4().hex
    c = WebhookConnector({"key_field": "id"}, {"signing_secret": secret})
    gen = c.stream("events", ["id"]).__aiter__()
    first = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0)  # subscribed, waiting for events
    wmod.HUB.publish(c.channel, "id", [{"id": "1"}], time.time())
    assert (await first).key == "1"
    wmod.HUB.publish(c.channel, "id", [{"id": str(i)} for i in range(10)], time.time())
    await asyncio.sleep(0.05)
    with pytest.raises(ConnectorError, match="fell behind"):
        await gen.__anext__()
    restarted = c.stream("events", ["id"]).__aiter__()
    keys = {(await restarted.__anext__()).key for _ in range(10)}
    assert keys == {str(i) for i in range(10)}
    await restarted.aclose()
