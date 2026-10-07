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

    async def insert_null_key(self, row: dict[str, Any]) -> None:
        with self.api.lock:
            self.api.rows["~nokey"] = {**row, "id": None}


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
        "allow_private_network": True,  # the mock API listens on 127.0.0.1
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
    c = RestConnector({"base_url": url, "allow_http": True, "allow_private_network": True}, {})
    with pytest.raises(ConnectorError) as e:
        await c.fetch_all()
    assert e.value.hint
    report = await c.test()
    assert not report.ok and report.steps[-1].name == "Check the address"
    await c.close()


async def test_plain_http_needs_allow_http(api: MockApi) -> None:
    c = RestConnector(settings(api, allow_http=False), {"api_key": API_KEY})
    report = await c.test()
    assert not report.ok
    assert "https" in report.steps[-1].hint.lower()
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


# -- LIVEOPS-21: outbound network policy ---------------------------------------


async def test_loopback_refused_by_default(seeded: MockApi) -> None:
    c = RestConnector(settings(seeded, allow_private_network=False), {"api_key": API_KEY})
    report = await c.test()
    await c.close()
    assert not report.ok
    step = report.steps[-1]
    assert "private or local network" in step.detail and "Allow private network" in step.hint
    assert seeded.requests == 0, "no request may reach a private address without the opt-in"


async def test_loopback_host_name_refused_after_dns(seeded: MockApi) -> None:
    c = RestConnector(
        settings(seeded, base_url=f"http://localhost:{seeded.port}", allow_private_network=False), {"api_key": API_KEY}
    )
    with pytest.raises(ConnectorError, match="private or local"):
        await c.fetch_all()
    await c.close()
    assert seeded.requests == 0


@pytest.mark.parametrize(
    "base",
    [
        "http://169.254.169.254",
        "http://[fe80::1]",
        "http://[::ffff:169.254.169.254]",
        "http://metadata.google.internal",
        "http://0.0.0.0:80",
        "http://100.100.100.200",
    ],
)
async def test_metadata_and_link_local_always_refused(base: str) -> None:
    c = RestConnector(
        {"base_url": base, "path": "/latest/meta-data/", "allow_http": True, "allow_private_network": True}, {}
    )
    with pytest.raises(ConnectorError, match="blocked"):
        await c.fetch_all()
    await c.close()


async def test_policy_checks_resolved_ip_on_every_request(seeded: MockApi, monkeypatch: pytest.MonkeyPatch) -> None:
    """DNS rebinding: a name that resolves to a public IP first and loopback later is refused later."""
    import ipaddress

    from app.connectors import netguard

    answers = iter([[ipaddress.ip_address("127.0.0.1")], [ipaddress.ip_address("169.254.169.254")]])

    async def fake_resolve(host: str, port: int) -> list[Any]:
        return next(answers)

    monkeypatch.setattr(netguard, "resolve", fake_resolve)
    c = RestConnector(
        settings(seeded, base_url=f"http://api.example.test:{seeded.port}", pagination="none"), {"api_key": API_KEY}
    )
    try:
        assert len(await c.fetch_all()) == 7  # 1st request: allowed private IP, pinned (Host header kept)
        with pytest.raises(ConnectorError, match="blocked"):
            await c.fetch_all()  # 2nd request: same name now points at the metadata service
    finally:
        await c.close()


def test_check_ip_policy() -> None:
    import ipaddress

    from app.connectors.netguard import check_ip

    check_ip(ipaddress.ip_address("8.8.8.8"), allow_private=False)
    check_ip(ipaddress.ip_address("10.1.2.3"), allow_private=True)
    for private in ("10.1.2.3", "192.168.1.1", "172.16.0.1", "127.0.0.1", "::1", "fd00::1", "100.64.0.1"):
        with pytest.raises(ConnectorError, match="private"):
            check_ip(ipaddress.ip_address(private), allow_private=False)
    for blocked in ("169.254.169.254", "169.254.1.1", "fe80::1", "224.0.0.1", "0.0.0.0", "fd00:ec2::254"):
        with pytest.raises(ConnectorError, match="blocked"):
            check_ip(ipaddress.ip_address(blocked), allow_private=True)


# -- LIVEOPS-20: test() never raises on malformed settings ----------------------


@pytest.mark.parametrize(
    "bad",
    [
        {"query": "[object Object]"},
        {"query": {"a": {"nested": 1}}},
        {"page_size": "100"},
        {"max_pages": True},
        {"allow_http": "yes"},
        {"auth": "magic"},
        {"timeout_s": -1},
        {"base_url": 42},
    ],
)
async def test_malformed_settings_fail_test_step_without_raising(api: MockApi, bad: dict[str, Any]) -> None:
    c = RestConnector({**settings(api), **bad}, {"api_key": API_KEY})
    report = await c.test()
    await c.close()
    assert not report.ok
    step = report.steps[0]
    assert step.name == "Check the settings" and step.hint
    assert next(iter(bad)) in step.detail
    assert "[object Object]" not in report.model_dump_json(), "errors must not echo the bad value"
    with pytest.raises(ConnectorError):
        await c.snapshot("assets")


# -- LIVEOPS-34: complete or raise ------------------------------------------------


async def test_snapshot_over_row_cap_raises_not_truncates(seeded: MockApi) -> None:
    c = RestConnector(settings(seeded), {"api_key": API_KEY})
    try:
        assert len(await c.fetch_all(max_records=7)) == 7
        with pytest.raises(ConnectorError, match="more than 6 rows") as e:
            await c.fetch_all(max_records=6)
        assert "filter" in e.value.hint
    finally:
        await c.close()
