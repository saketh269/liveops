"""Webhook connector: events go through the real HTTP route
(``POST /api/webhooks/{id}``) and the real portal DB, signed like a sender would."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.connectors.base import ChangeOp, Connector
from app.connectors.webhook import SIGNATURE_HEADER, TIMESTAMP_HEADER, SignatureError, WebhookConnector, sign, verify
from tests.conftest import requires_pg
from tests.contract.kit import SEED_ROWS, ConnectorContract
from tests.contract.portal import portal_app


def signed_headers(secret: str, body: bytes, ts: int | None = None, *, source_id: str) -> dict[str, str]:
    t = str(int(time.time()) if ts is None else ts)
    sig = sign(secret, t, body, source_id=source_id)
    return {"Content-Type": "application/json", TIMESTAMP_HEADER: t, SIGNATURE_HEADER: sig}


class WebhookDriver:
    dataset = "events"

    def __init__(self, client: httpx.AsyncClient, source_id: str, secret: str) -> None:
        self.client, self.source_id, self.secret = client, source_id, secret
        self.rows: dict[str, dict[str, Any]] = {}

    async def post(self, payload: Any, *, secret: str | None = None, ts: int | None = None) -> httpx.Response:
        body = json.dumps(payload).encode()
        return await self.client.post(
            f"/api/webhooks/{self.source_id}",
            content=body,
            headers=signed_headers(secret or self.secret, body, ts, source_id=self.source_id),
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


REDIS_URL = os.environ.get("LIVEOPS_TEST_REDIS_URL")


@pytest.fixture(autouse=True, params=["memory", "redis"])
def webhook_store_mode(
    request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[str]:
    """Run every webhook test against both stores, each isolated (own data dir / Redis prefix)."""
    from app.config import get_settings
    from app.connectors.webhook_store import reset_stores

    monkeypatch.setenv("LIVEOPS_DATA_DIR", str(tmp_path / "data"))
    prefix = f"lo-test-{uuid.uuid4().hex[:8]}"
    if request.param == "redis":
        if not REDIS_URL:
            pytest.skip("LIVEOPS_TEST_REDIS_URL not set")
        monkeypatch.setenv("LIVEOPS_REDIS_URL", REDIS_URL)
        monkeypatch.setenv("LIVEOPS_REDIS_KEY_PREFIX", prefix)
    else:
        monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    get_settings.cache_clear()
    reset_stores()
    yield request.param
    reset_stores()
    get_settings.cache_clear()
    if request.param == "redis":
        import redis

        r = redis.Redis.from_url(REDIS_URL)
        keys = list(r.scan_iter(f"{prefix}:*"))
        if keys:
            r.delete(*keys)
        r.close()


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
        return WebhookConnector({"key_field": "id"}, {"signing_secret": driver.secret}, source_id=driver.source_id)

    def make_bad_connector(self, driver: WebhookDriver) -> Connector:  # type: ignore[override]
        return WebhookConnector({"key_field": "id"}, {"signing_secret": "short"}, source_id=driver.source_id)


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
    headers = signed_headers(wh.secret, body, source_id=wh.source_id)
    first = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=headers)
    again = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=headers)
    assert first.status_code == 202
    assert again.status_code == 401
    assert "already received" in again.json()["detail"]["message"]


@pg
async def test_changed_timestamp_breaks_signature(wh: WebhookDriver) -> None:
    body = json.dumps({"id": "X"}).encode()
    headers = signed_headers(wh.secret, body, ts=int(time.time()) - 60, source_id=wh.source_id)
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
    r = await wh.client.post(
        f"/api/webhooks/{wh.source_id}", content=body, headers=signed_headers(wh.secret, body, source_id=wh.source_id)
    )
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
    r = await wh.client.post(
        "/api/webhooks/doesnotexist", content=body, headers=signed_headers(wh.secret, body, source_id=wh.source_id)
    )
    assert r.status_code == 404


@pg
async def test_list_body_and_delete_reach_stream(wh: WebhookDriver) -> None:
    r = await wh.post([{"id": "B1", "status": "free"}, {"id": "B2", "status": "in_use"}])
    assert r.json() == {"accepted": 2}
    await wh.post({"id": "B1", "_deleted": True})
    c = WebhookConnector({"key_field": "id"}, {"signing_secret": wh.secret}, source_id=wh.source_id)
    gen = c.stream("events", ["id"]).__aiter__()
    try:
        first = await gen.__anext__()
        assert first.key == "B2" and first.op == ChangeOp.UPSERT and "_deleted" not in first.record
        assert (await gen.__anext__()).op == ChangeOp.SNAPSHOT_END
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
    c = WebhookConnector({"key_field": "id", "max_records": 5}, {"signing_secret": secret}, source_id=source_id)
    assert [r["id"] for r in await c.preview("events")] == ["15", "16", "17", "18", "19"]


# -- pure unit tests ----------------------------------------------------------


def test_verify_accepts_good_and_rejects_tampered_body() -> None:
    now = 1_800_000_000
    sig = sign("s" * 20, str(now), b'{"id":1}', source_id="S1")
    verify("s" * 20, str(now), sig, b'{"id":1}', source_id="S1", now=now)
    with pytest.raises(SignatureError):
        verify("s" * 20, str(now), sig, b'{"id":2}', source_id="S1", now=now)
    with pytest.raises(SignatureError):
        verify("s" * 20, "not-a-number", sig, b'{"id":1}', source_id="S1", now=now)
    with pytest.raises(SignatureError):
        verify(
            "s" * 20,
            str(now - 301),
            sign("s" * 20, str(now - 301), b"{}", source_id="S1"),
            b"{}",
            source_id="S1",
            now=now,
        )
    verify(
        "s" * 20, str(now - 299), sign("s" * 20, str(now - 299), b"{}", source_id="S1"), b"{}", source_id="S1", now=now
    )


async def test_slow_consumer_gets_clear_error_then_restarts_from_state(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from app.connectors import webhook_store
    from app.connectors.base import ConnectorError

    secret = uuid.uuid4().hex
    c = WebhookConnector({"key_field": "id"}, {"signing_secret": secret}, source_id=uuid.uuid4().hex)
    if not isinstance(c.store, webhook_store.MemoryWebhookStore):
        pytest.skip("queue overflow is specific to the in-process store")
    monkeypatch.setattr(webhook_store, "SUBSCRIBER_QUEUE", 3)
    gen = c.stream("events", ["id"]).__aiter__()
    assert (await gen.__anext__()).op == ChangeOp.SNAPSHOT_END  # empty state, then the marker
    first = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0)  # subscribed, waiting for events
    await c.store.publish(c.channel, "id", [{"id": "1"}], time.time(), 100)
    assert (await first).key == "1"
    await c.store.publish(c.channel, "id", [{"id": str(i)} for i in range(10)], time.time(), 100)
    await asyncio.sleep(0.05)
    with pytest.raises(ConnectorError, match="fell behind"):
        await gen.__anext__()
    restarted = c.stream("events", ["id"]).__aiter__()
    keys = {(await restarted.__anext__()).key for _ in range(10)}
    assert keys == {str(i) for i in range(10)}
    assert (await restarted.__anext__()).op == ChangeOp.SNAPSHOT_END
    await restarted.aclose()


# -- LIVEOPS-17: strict signature header, no padded replays --------------------


@pg
@pytest.mark.parametrize("pad", [b"\xa0", b"\x85", b" ", b"\t", b"\xa0\xa0"])
async def test_padded_signature_replay_is_refused(wh: WebhookDriver, pad: bytes) -> None:
    body = json.dumps({"id": "P1", "status": "free"}).encode()
    headers = signed_headers(wh.secret, body, source_id=wh.source_id)
    url = f"/api/webhooks/{wh.source_id}"
    assert (await wh.client.post(url, content=body, headers=headers)).status_code == 202
    padded = {**headers, SIGNATURE_HEADER: headers[SIGNATURE_HEADER].encode() + pad}
    r = await wh.client.post(url, content=body, headers=padded)  # type: ignore[arg-type]
    assert r.status_code == 401, r.text
    assert "64 lowercase hex" in r.json()["detail"]["message"]


@pg
async def test_padded_signature_is_refused_even_on_first_use(wh: WebhookDriver) -> None:
    body = b'{"id":"P2"}'
    headers = signed_headers(wh.secret, body, source_id=wh.source_id)
    headers[SIGNATURE_HEADER] = headers[SIGNATURE_HEADER] + " "
    r = await wh.client.post(f"/api/webhooks/{wh.source_id}", content=body, headers=headers)
    assert r.status_code == 401


def test_signature_format_is_strict() -> None:
    now = 1_800_000_000
    good = sign("s" * 20, str(now), b"{}", source_id="S1")
    assert verify("s" * 20, str(now), good, b"{}", source_id="S1", now=now) == good.removeprefix("sha256=")
    hexpart = good.removeprefix("sha256=")
    for bad in (
        good.upper(),
        "SHA256=" + hexpart,
        "sha256=" + hexpart.upper(),
        good + "\xa0",
        "\x85" + good,
        good[:-1],
        "sha256=" + "١" * 64,  # Arabic-Indic digits are not hex
    ):
        with pytest.raises(SignatureError):
            verify("s" * 20, str(now), bad, b"{}", source_id="S1", now=now)
    for bad_ts in (f" {now}", f"{now}\xa0", f"+{now}", "١٢", f"{now}.0"):
        with pytest.raises(SignatureError):
            verify("s" * 20, bad_ts, good, b"{}", source_id="S1", now=now)


# -- LIVEOPS-31: buffers are per source id, not per secret ----------------------


@pg
async def test_sources_sharing_a_secret_do_not_share_data(client: httpx.AsyncClient) -> None:
    secret = uuid.uuid4().hex
    ids = []
    for name in ("wh-a", "wh-b"):
        r = await client.post(
            "/api/sources",
            json={
                "name": name,
                "type": "webhook",
                "settings": {"key_field": "id"},
                "secrets": {"signing_secret": secret},
            },
        )
        ids.append(r.json()["id"])
    a = WebhookDriver(client, ids[0], secret)
    assert (await a.post({"id": "X1", "status": "in_use"})).status_code == 202
    prev_a = await client.get(f"/api/sources/{ids[0]}/preview", params={"dataset": "events"})
    prev_b = await client.get(f"/api/sources/{ids[1]}/preview", params={"dataset": "events"})
    assert [r["id"] for r in prev_a.json()] == ["X1"]
    assert prev_b.json() == []


async def test_unsaved_webhook_source_reports_clearly() -> None:
    c = WebhookConnector({"key_field": "id"}, {"signing_secret": "x" * 20})
    report = await c.test()
    assert not report.ok and "Save the source" in report.steps[-1].hint


# -- LIVEOPS-89: last known state survives a restart --------------------------------


@pg
async def test_state_survives_restart(wh: WebhookDriver, webhook_store_mode: str) -> None:
    from app.connectors.webhook_store import reset_stores

    await wh.post([{"id": f"R{i}", "status": "free"} for i in range(5)])
    await wh.post({"id": "R2", "_deleted": True})
    await wh.post({"id": "R3", "status": "in_use"})
    reset_stores()  # a new backend process: nothing cached in memory
    c = WebhookConnector({"key_field": "id"}, {"signing_secret": wh.secret}, source_id=wh.source_id)
    gen = c.stream("events", ["id"]).__aiter__()
    try:
        state = {}
        while True:
            ch = await asyncio.wait_for(gen.__anext__(), 5)
            if ch.op == ChangeOp.SNAPSHOT_END:
                break
            state[ch.key] = ch.record["status"]
        assert state == {"R0": "free", "R1": "free", "R3": "in_use", "R4": "free"}
    finally:
        await gen.aclose()
    report = await c.test()
    events = next(s for s in report.steps if s.name == "Events received")
    if webhook_store_mode == "memory":
        assert "kept from before the restart" in events.detail and "4 records" in events.detail
    else:
        assert "4 records in the current state" in events.detail


async def test_memory_journal_is_compacted(tmp_path: Path) -> None:
    from app.connectors.webhook_store import MemoryWebhookStore

    store = MemoryWebhookStore(tmp_path)
    for i in range(3000):
        await store.publish("src1", "id", [{"id": str(i % 10), "n": i}], float(i), 100)
    lines = (tmp_path / "src1.jsonl").read_text().splitlines()
    assert len(lines) <= 1_000, len(lines)
    fresh = MemoryWebhookStore(tmp_path)
    assert sorted(r["n"] for r in await fresh.current("src1")) == list(range(2990, 3000))
    (tmp_path / "src1.jsonl").write_text((tmp_path / "src1.jsonl").read_text() + '{"k": "torn')
    assert len(await MemoryWebhookStore(tmp_path).current("src1")) == 10  # a torn last line is ignored


# -- LIVEOPS-72: several processes, replay across processes, source-bound signature --------


@pg
async def test_event_accepted_by_another_process_reaches_the_stream(wh: WebhookDriver, webhook_store_mode: str) -> None:
    if webhook_store_mode != "redis":
        pytest.skip("cross-process delivery needs the Redis store")
    from app.connectors.webhook_store import reset_stores

    c = WebhookConnector({"key_field": "id"}, {"signing_secret": wh.secret}, source_id=wh.source_id)
    gen = c.stream("events", ["id"]).__aiter__()  # the mapping owner, "process A"
    try:
        assert (await asyncio.wait_for(gen.__anext__(), 5)).op == ChangeOp.SNAPSHOT_END
        reset_stores()  # the route now runs as "process B" with its own store and Redis client
        t0 = time.monotonic()
        assert (await wh.post({"id": "P56", "status": "in_use"})).status_code == 202
        ch = await asyncio.wait_for(gen.__anext__(), 5)
        assert ch.key == "P56" and ch.op == ChangeOp.UPSERT
        print(f"cross-process webhook delivery {1000 * (time.monotonic() - t0):.1f} ms")
    finally:
        await gen.aclose()


@pg
async def test_replay_is_refused_by_another_process(wh: WebhookDriver, webhook_store_mode: str) -> None:
    if webhook_store_mode != "redis":
        pytest.skip("a shared replay cache needs the Redis store")
    from app.connectors.webhook_store import reset_stores

    body = b'{"id":"X1"}'
    headers = signed_headers(wh.secret, body, source_id=wh.source_id)
    url = f"/api/webhooks/{wh.source_id}"
    assert (await wh.client.post(url, content=body, headers=headers)).status_code == 202
    reset_stores()
    again = await wh.client.post(url, content=body, headers=headers)
    assert again.status_code == 401 and "already received" in again.json()["detail"]["message"]


@pg
async def test_request_signed_for_one_source_fails_on_another(client: httpx.AsyncClient) -> None:
    secret = uuid.uuid4().hex
    ids = []
    for name in ("x", "y"):
        r = await client.post(
            "/api/sources",
            json={
                "name": name,
                "type": "webhook",
                "settings": {"key_field": "id"},
                "secrets": {"signing_secret": secret},
            },
        )
        ids.append(r.json()["id"])
    body = b'{"id":"Z1","_deleted":true}'
    headers = signed_headers(secret, body, source_id=ids[0])
    assert (await client.post(f"/api/webhooks/{ids[0]}", content=body, headers=headers)).status_code == 202
    other = await client.post(f"/api/webhooks/{ids[1]}", content=body, headers=headers)
    assert other.status_code == 401 and "Signature doesn't match" in other.json()["detail"]["message"]


# -- LIVEOPS-90: _deleted must be a boolean ---------------------------------------


@pg
@pytest.mark.parametrize("val", ["true", 1, "yes", None])
async def test_non_boolean_deleted_is_422(wh: WebhookDriver, val: Any) -> None:
    r = await wh.post({"id": "D1", "_deleted": val})
    assert r.status_code == 422 and "true or false" in r.json()["detail"]["message"]
