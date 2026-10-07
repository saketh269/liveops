from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest

from app.connectors.base import Connector, ConnectorError
from app.connectors.rest import RestConnector, select_path
from tests.contract.kit import SEED_ROWS, ConnectorContract
from tests.contract.mock_api import API_KEY, CLIENT_ID, CLIENT_SECRET, MockApi


class RestDriver:
    dataset = "assets"

    def __init__(self, api: MockApi) -> None:
        self.api = api
        for r in SEED_ROWS:
            self._put(dict(r))

    def _put(self, row: dict[str, Any]) -> None:
        row.setdefault("updated_at", dt.datetime.now(dt.UTC).isoformat())
        row.setdefault("amount", 1.5)
        with self.api.lock:
            self.api.rows[str(row["id"])] = row

    async def insert(self, row: dict[str, Any]) -> None:
        self._put(dict(row))

    async def update(self, key: str, changes: dict[str, Any]) -> None:
        with self.api.lock:
            self.api.rows[key] = {**self.api.rows[key], **changes, "updated_at": dt.datetime.now(dt.UTC).isoformat()}

    async def delete(self, key: str) -> None:
        with self.api.lock:
            del self.api.rows[key]


@pytest.fixture
def api() -> Iterator[MockApi]:
    a = MockApi().start()
    try:
        yield a
    finally:
        a.stop()


def settings(api: MockApi, **over: Any) -> dict[str, Any]:
    s: dict[str, Any] = {
        "base_url": api.base,
        "path": "/v1/assets",
        "dataset_name": "assets",
        "record_path": "data.items",
        "auth": "api_key",
        "api_key_header": "X-API-Key",
        "pagination": "page_number",
        "page_size": 2,
        "allow_http": True,  # local mock server only
        "timeout_s": 5,
    }
    s.update(over)
    return s


class TestRestContract(ConnectorContract):
    latency_budget_s = 5.0

    @pytest.fixture
    async def driver(self, api: MockApi) -> AsyncIterator[RestDriver]:
        yield RestDriver(api)

    def make_connector(self, driver: RestDriver) -> Connector:  # type: ignore[override]
        return RestConnector(settings(driver.api), {"api_key": API_KEY})

    def make_bad_connector(self, driver: RestDriver) -> Connector:  # type: ignore[override]
        return RestConnector(settings(driver.api), {"api_key": "wrong-key-456"})


# -- focused tests ------------------------------------------------------------


async def _fetch(api: MockApi, secrets: dict[str, Any] | None = None, **over: Any) -> list[dict[str, Any]]:
    c = RestConnector(settings(api, **over), secrets if secrets is not None else {"api_key": API_KEY})
    try:
        return await c.fetch_all()
    finally:
        await c.close()


@pytest.fixture
def seeded(api: MockApi) -> MockApi:
    RestDriver(api)
    for i in range(4, 8):
        api.rows[f"A{i}"] = {"id": f"A{i}", "status": "free", "zone": "ER"}
    return api


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "gopher://127.0.0.1:6379/_", "//x"])
async def test_non_http_schemes_are_refused(url: str) -> None:
    c = RestConnector({"base_url": url, "allow_http": True}, {})
    with pytest.raises(ConnectorError) as e:
        await c.fetch_all()
    assert e.value.hint
    report = await c.test()
    assert not report.ok and report.steps[0].name == "Check the address"
    await c.close()


async def test_plain_http_needs_allow_http(api: MockApi) -> None:
    c = RestConnector(settings(api, allow_http=False), {"api_key": API_KEY})
    report = await c.test()
    assert not report.ok
    assert "https" in report.steps[0].hint.lower()
    assert api.requests == 0, "nothing may be sent over plain http unless allowed"
    await c.close()


async def test_page_number_pagination_reads_all_pages(seeded: MockApi) -> None:
    rows = await _fetch(seeded)
    assert sorted(r["id"] for r in rows) == [f"A{i}" for i in range(1, 8)]


async def test_cursor_pagination(seeded: MockApi) -> None:
    rows = await _fetch(seeded, path="/v1/cursor", record_path="items", pagination="cursor", cursor_path="meta.next")
    assert len(rows) == 7


async def test_link_header_pagination(seeded: MockApi) -> None:
    rows = await _fetch(seeded, path="/v1/linked", record_path="", pagination="link_header")
    assert len(rows) == 7


async def test_link_header_to_another_host_is_refused(seeded: MockApi) -> None:
    with pytest.raises(ConnectorError, match="different server"):
        await _fetch(seeded, path="/v1/evil-link", record_path="", pagination="link_header")


async def test_pagination_cap_stops_endless_api(api: MockApi) -> None:
    with pytest.raises(ConnectorError, match="more than 3 pages") as e:
        await _fetch(api, path="/v1/endless", record_path="", max_pages=3)
    assert "Max pages" in e.value.hint
    assert api.requests == 3


async def test_pagination_cap_has_a_hard_ceiling(api: MockApi) -> None:
    c = RestConnector(settings(api, max_pages=10**9), {})
    assert c._max_pages() == 1000


async def test_response_size_cap(api: MockApi) -> None:
    with pytest.raises(ConnectorError, match="larger than 1 MB"):
        await _fetch(api, path="/v1/big", record_path="", pagination="none", max_response_mb=1)


async def test_redirects_are_not_followed(api: MockApi) -> None:
    api.redirect_target = "http://169.254.169.254/latest/meta-data"
    with pytest.raises(ConnectorError, match="redirect"):
        await _fetch(api, path="/v1/redirect")


async def test_non_json_response_has_hint(api: MockApi) -> None:
    with pytest.raises(ConnectorError, match="didn't return JSON"):
        await _fetch(api, path="/v1/html", pagination="none")


async def test_wrong_record_path_has_hint(seeded: MockApi) -> None:
    with pytest.raises(ConnectorError, match="No records found") as e:
        await _fetch(seeded, record_path="data.rows")
    assert "Where the records are" in e.value.hint


async def test_oauth2_token_is_cached(seeded: MockApi) -> None:
    c = RestConnector(
        settings(
            seeded,
            path="/v1/oauth",
            record_path="items",
            pagination="none",
            auth="oauth2_client_credentials",
            token_url=f"{seeded.base}/oauth/token",
        ),
        {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET},
    )
    try:
        assert (await c.test()).ok
        assert len(await c.snapshot("assets")) == 7
        assert len(await c.snapshot("assets")) == 7
        assert seeded.token_requests == 1
    finally:
        await c.close()


async def test_oauth2_bad_secret_reports_without_leaking(seeded: MockApi) -> None:
    c = RestConnector(
        settings(seeded, path="/v1/oauth", auth="oauth2_client_credentials", token_url=f"{seeded.base}/oauth/token"),
        {"client_id": CLIENT_ID, "client_secret": "nope-nope-nope"},
    )
    report = await c.test()
    await c.close()
    assert not report.ok
    assert "client ID and secret" in report.steps[-1].hint
    assert "nope-nope-nope" not in report.model_dump_json()


async def test_unknown_dataset_is_rejected(api: MockApi) -> None:
    c = RestConnector(settings(api), {"api_key": API_KEY})
    with pytest.raises(ConnectorError):
        await c.preview("other")
    await c.close()


def test_select_path() -> None:
    doc = {"data": {"items": [{"a": 1}]}, "results": [{"rows": [1, 2]}]}
    assert select_path(doc, "data.items") == [{"a": 1}]
    assert select_path(doc, "$.data.items") == [{"a": 1}]
    assert select_path(doc, "results.0.rows") == [1, 2]
    assert select_path(doc, "results[0].rows") == [1, 2]
    assert select_path(doc, "") is doc
    assert select_path(doc, "data.missing") is None
    assert select_path(doc, "results.5") is None
