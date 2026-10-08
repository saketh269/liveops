"""REST sign-in sends the right header, end to end: saved through the API, then used by test and preview.

Regression for a report that "API key" sign-in sent no header. A local HTTP server records
every request's headers; the source is created exactly as the UI does it (POST /api/sources).
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

KEY = "demo-key-123"


class Recorder:
    def __init__(self) -> None:
        self.seen: list[dict[str, str]] = []
        rec = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, code: int, body: Any) -> None:
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self) -> None:  # noqa: N802 - OAuth2 token endpoint
                n = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(n)
                self._send(200, {"access_token": "tok-from-oauth", "expires_in": 600})

            def do_GET(self) -> None:  # noqa: N802
                rec.seen.append({k.lower(): v for k, v in self.headers.items()})
                ok = self.headers.get("X-API-Key") == KEY or self.headers.get("Authorization") in (
                    f"Bearer {KEY}",
                    "Bearer tok-from-oauth",
                )
                if not ok:
                    return self._send(401, {"detail": "Missing or invalid API key"})
                self._send(200, {"count": 1, "items": [{"bed_id": "3W-305A", "status": "blocked", "floor": 3}]})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture
def api() -> Iterator[Recorder]:
    r = Recorder()
    try:
        yield r
    finally:
        r.server.shutdown()
        r.server.server_close()


@pytest.fixture
def client(portal_db: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("LIVEOPS_START_RUNNERS", "false")
    monkeypatch.setenv("LIVEOPS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


def make_source(c: TestClient, api: Recorder, auth: str, secrets: dict[str, str], **extra: Any) -> str:
    settings = {
        "base_url": api.base,
        "path": "/api/beds",
        "record_path": "items",
        "dataset_name": "beds",
        "auth": auth,
        "allow_http": True,
        "allow_private_network": True,
        **extra,
    }
    r = c.post("/api/sources", json={"name": f"beds {auth}", "type": "rest", "settings": settings, "secrets": secrets})
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def check_and_preview(c: TestClient, sid: str) -> None:
    t = c.post(f"/api/sources/{sid}/test").json()
    assert t["ok"], t
    p = c.get(f"/api/sources/{sid}/preview", params={"dataset": "beds", "limit": 5})
    assert p.status_code == 200, p.text
    assert p.json()[0]["bed_id"] == "3W-305A"


def test_api_key_header_is_sent(client: TestClient, api: Recorder) -> None:
    sid = make_source(client, api, "api_key", {"api_key": KEY}, api_key_header="X-API-Key")
    check_and_preview(client, sid)
    assert api.seen and all(h.get("x-api-key") == KEY for h in api.seen)
    assert all("api_key" not in h for h in api.seen)  # header only, never a query value


def test_custom_api_key_header_name(client: TestClient, api: Recorder) -> None:
    sid = make_source(client, api, "api_key", {"api_key": KEY}, api_key_header="X-Api-Key")
    check_and_preview(client, sid)
    assert all(h.get("x-api-key") == KEY for h in api.seen)


def test_bearer_header_is_sent(client: TestClient, api: Recorder) -> None:
    sid = make_source(client, api, "bearer", {"bearer_token": KEY})
    check_and_preview(client, sid)
    assert all(h.get("authorization") == f"Bearer {KEY}" for h in api.seen)


def test_oauth2_token_is_sent(client: TestClient, api: Recorder) -> None:
    sid = make_source(
        client,
        api,
        "oauth2_client_credentials",
        {"client_id": "cid", "client_secret": "cs"},
        token_url=f"{api.base}/oauth/token",
    )
    check_and_preview(client, sid)
    assert all(h.get("authorization") == "Bearer tok-from-oauth" for h in api.seen)


def test_api_key_kept_when_editing_other_settings(client: TestClient, api: Recorder) -> None:
    """Saving the form again with the key left blank keeps the saved key (blank = keep)."""
    sid = make_source(client, api, "api_key", {"api_key": KEY})
    r = client.put(f"/api/sources/{sid}", json={"name": "renamed", "secrets": {}})
    assert r.status_code == 200, r.text
    api.seen.clear()
    check_and_preview(client, sid)
    assert all(h.get("x-api-key") == KEY for h in api.seen)


def test_switching_from_none_to_api_key(client: TestClient, api: Recorder) -> None:
    """The workaround setup (no sign-in, key in the query) switched back to header sign-in."""
    sid = make_source(client, api, "none", {}, query={"api_key": KEY})
    s = client.get(f"/api/sources/{sid}").json()["settings"]
    s = {**s, "auth": "api_key", "query": {}}
    r = client.put(f"/api/sources/{sid}", json={"settings": s, "secrets": {"api_key": KEY}})
    assert r.status_code == 200, r.text
    api.seen.clear()
    check_and_preview(client, sid)
    assert api.seen and all(h.get("x-api-key") == KEY for h in api.seen)


def test_missing_key_is_a_clear_error_not_a_silent_unsigned_call(client: TestClient, api: Recorder) -> None:
    sid = make_source(client, api, "api_key", {})
    t = client.post(f"/api/sources/{sid}/test").json()
    assert not t["ok"]
    assert any("API key" in (s["detail"] + s["hint"]) for s in t["steps"] if not s["ok"])
    assert api.seen == []  # nothing was sent without the key
