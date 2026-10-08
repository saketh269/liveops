"""POST /api/sites/{id}/layout/import end to end, against the Riverside mock API on a local port (ADR 0007)."""

from __future__ import annotations

import importlib.util
import threading
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

TOOLS = Path(__file__).resolve().parents[3] / "tools" / "riverside-mock"
KEY = "demo-key"


def _mock_module() -> Any:
    spec = importlib.util.spec_from_file_location("riverside_mock_api_it", TOOLS / "mock_api.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def hospital_api() -> Iterator[str]:
    mod = _mock_module()
    server = ThreadingHTTPServer(("127.0.0.1", 0), mod.make_handler(mod.Hospital(1)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


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


def make_site(c: TestClient, layout: dict[str, Any] | None = None) -> str:
    r = c.post("/api/sites", json={"name": "hs", "template": "hospital", "layout": layout or {"zones": []}})
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def make_source(c: TestClient, base: str, key: str = KEY, private: bool = True, **settings: Any) -> str:
    r = c.post(
        "/api/sources",
        json={
            "name": "Riverside – Beds",
            "type": "rest",
            "settings": {
                "base_url": base,
                "path": "/api/beds",
                "record_path": "items",
                "auth": "api_key",
                "api_key_header": "X-API-Key",
                "allow_http": True,
                "allow_private_network": private,
                **settings,
            },
            "secrets": {"api_key": key},
        },
    )
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def imp(c: TestClient, site: str, **body: Any) -> Any:
    return c.post(f"/api/sites/{site}/layout/import", json={"path": "/api/floor-layout", **body})


def test_dry_run_previews_without_saving_then_import_saves(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api)
    r = imp(client, site, source_id=src, dry_run=True)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["saved"] is False
    s = out["summary"]
    assert s["format"] == "riverside" and s["floors"] == 5 and s["beds"] > 100 and s["problems"] == []
    assert s["zones_by_kind"]["corridor"] == 7
    assert client.get(f"/api/sites/{site}").json()["layout"] == {"zones": []}  # nothing stored

    r = imp(client, site, source_id=src, mode="replace")
    assert r.status_code == 200, r.text
    assert r.json()["saved"] is True
    stored = client.get(f"/api/sites/{site}").json()["layout"]
    assert stored == r.json()["layout"]
    assert len(stored["floors"]) == 5 and stored["imported"]["source_id"] == src
    assert stored["imported"]["path"] == "/api/floor-layout"


def test_merge_keeps_zones_the_user_added(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api)
    assert imp(client, site, source_id=src, mode="replace").status_code == 200
    layout = client.get(f"/api/sites/{site}").json()["layout"]
    layout["zones"].append(
        {
            "id": "my-bay",
            "name": "Ambulance bay",
            "floor_id": "1",
            "kind": "bay",
            "polygon": [[0, 0], [4, 0], [4, 4], [0, 4]],
        }
    )
    assert client.put(f"/api/sites/{site}", json={"layout": layout}).status_code == 200
    r = imp(client, site, source_id=src, mode="merge")
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["kept_zones"] == 1
    zones = client.get(f"/api/sites/{site}").json()["layout"]["zones"]
    assert any(z["id"] == "my-bay" for z in zones)
    r = imp(client, site, source_id=src, mode="replace")
    assert not any(z["id"] == "my-bay" for z in client.get(f"/api/sites/{site}").json()["layout"]["zones"])


def test_save_refuses_a_layout_with_problems(client: TestClient, hospital_api: str) -> None:
    site = make_site(
        client,
        {
            "floors": [{"id": "1", "name": "Floor 1", "level": 0, "width": 100, "depth": 60}],
            "zones": [{"id": "mine", "name": "ED-01", "floor_id": "1", "polygon": [[0, 0], [1, 0], [1, 1]]}],
        },
    )
    src = make_source(client, hospital_api)
    r = imp(client, site, source_id=src, mode="merge")
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["message"] == "The imported layout was not saved"
    assert any('2 zones are named "ed-01"' in p for p in d["problems"])
    assert client.get(f"/api/sites/{site}").json()["layout"]["zones"][0]["id"] == "mine"


def test_wrong_source_type_is_a_plain_400(client: TestClient, tmp_path: Path) -> None:
    site = make_site(client)
    r = client.post(
        "/api/sources",
        json={
            "name": "Postgres",
            "type": "postgres",
            "settings": {"host": "db", "port": 5432, "database": "x", "user": "u"},
            "secrets": {"password": "pw"},
        },
    )
    assert r.status_code == 201, r.text
    out = imp(client, site, source_id=r.json()["id"])
    assert out.status_code == 400
    assert out.json()["detail"]["message"] == "Layout import needs an API source"


def test_source_sign_in_errors_surface_plainly_without_the_key(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api, key="wrong-key-123")
    r = imp(client, site, source_id=src)
    assert r.status_code == 400
    d = r.json()["detail"]
    assert d["message"] == "The API refused the request (HTTP 401)"
    assert "API key" in d["hint"]
    assert "wrong-key-123" not in r.text


def test_private_network_blocked_unless_allowed(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api, private=False)
    r = imp(client, site, source_id=src)
    assert r.status_code == 400
    assert "private" in (r.json()["detail"]["message"] + r.json()["detail"]["hint"]).lower()
    assert client.get(f"/api/sites/{site}").json()["layout"] == {"zones": []}


def test_path_cannot_point_at_another_server(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api)
    for path in ("http://169.254.169.254/latest", "//evil.example/x", "\\\\evil"):
        r = imp(client, site, source_id=src, path=path)
        assert r.status_code == 400, path
        assert "path on the base URL's server" in r.json()["detail"]["message"]


def test_not_a_layout_and_not_found(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api)
    r = imp(client, site, source_id=src, path="/api/units")
    assert r.status_code == 422 and "Couldn't tell" in r.json()["detail"]["message"]
    r = imp(client, site, source_id=src, path="/api/nope")
    assert r.status_code == 400 and "HTTP 404" in r.json()["detail"]["message"]
    assert imp(client, "nope", source_id=src).status_code == 404
    assert imp(client, site, source_id="nope").status_code == 404
    r = imp(client, site, source_id=src, format="csv")
    assert r.status_code == 422


def test_response_size_cap_applies(client: TestClient, hospital_api: str) -> None:
    site = make_site(client)
    src = make_source(client, hospital_api, max_response_mb=0.001)
    r = imp(client, site, source_id=src)
    assert r.status_code == 400 and "larger than" in r.json()["detail"]["message"]
