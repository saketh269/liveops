"""Floor plan API (ADR 0006): upload, serve, delete, per-site isolation, cleanup."""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.unit.test_plans import img_bytes, png_claiming


@pytest.fixture
def client(portal_db: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("LIVEOPS_START_RUNNERS", "false")
    monkeypatch.setenv("LIVEOPS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIVEOPS_MAX_PLAN_MB", "1")
    monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


def site(c: TestClient, name: str = "General") -> str:
    r = c.post("/api/sites", json={"name": name, "template": "hospital"})
    assert r.status_code == 201
    return str(r.json()["id"])


def upload(c: TestClient, site_id: str, data: bytes, name: str = "plan.png", ctype: str = "image/png") -> object:
    return c.post(f"/api/sites/{site_id}/plans", files={"file": (name, data, ctype)})


def test_upload_get_delete_round_trip(client: TestClient, tmp_path: Path) -> None:
    sid = site(client)
    data = img_bytes("PNG", (300, 200))
    r = upload(client, sid, data)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["width_px"] == 300 and body["height_px"] == 200 and body["content_type"] == "image/png"
    aid = body["asset_id"]
    assert len(aid) == 32
    assert (tmp_path / "plans" / sid / f"{aid}.png").read_bytes() == data
    assert not [p for p in (tmp_path / "plans" / sid).iterdir() if p.name.startswith(".")]  # no temp files left

    g = client.get(f"/api/sites/{sid}/plans/{aid}")
    assert g.status_code == 200 and g.content == data
    assert g.headers["content-type"] == "image/png"
    assert "immutable" in g.headers["cache-control"]
    assert g.headers["x-content-type-options"] == "nosniff"
    assert g.headers["etag"] == f'"{aid}"'
    again = client.get(f"/api/sites/{sid}/plans/{aid}", headers={"If-None-Match": f'"{aid}"'})
    assert again.status_code == 304 and again.content == b""

    assert client.delete(f"/api/sites/{sid}/plans/{aid}").status_code == 204
    assert client.get(f"/api/sites/{sid}/plans/{aid}").status_code == 404
    assert client.delete(f"/api/sites/{sid}/plans/{aid}").status_code == 404


def test_file_name_and_declared_type_are_not_trusted(client: TestClient) -> None:
    sid = site(client)
    # A JPEG sent as "../../evil.png" with an image/png content type: stored as JPEG under a random id.
    r = upload(client, sid, img_bytes("JPEG", (40, 30)), name="../../evil.png", ctype="image/png")
    assert r.status_code == 201 and r.json()["content_type"] == "image/jpeg"
    g = client.get(f"/api/sites/{sid}/plans/{r.json()['asset_id']}")
    assert g.headers["content-type"] == "image/jpeg"
    # HTML posing as a PNG is refused.
    bad = upload(client, sid, b"<html><script>alert(1)</script></html>", name="plan.png")
    assert bad.status_code == 415
    assert "PNG" in bad.json()["detail"]["hint"]


def test_pdf_upload_is_rendered(client: TestClient) -> None:
    sid = site(client)
    buf = io.BytesIO()
    Image.new("RGB", (595, 842), (255, 255, 255)).save(buf, format="PDF", resolution=72)
    r = upload(client, sid, buf.getvalue(), name="floor-2.pdf", ctype="application/pdf")
    assert r.status_code == 201, r.text
    assert r.json()["content_type"] == "image/png" and r.json()["height_px"] > r.json()["width_px"]
    g = client.get(f"/api/sites/{sid}/plans/{r.json()['asset_id']}")
    assert g.headers["content-type"] == "image/png" and g.content.startswith(b"\x89PNG")


def test_bad_files(client: TestClient) -> None:
    sid = site(client)
    bomb = upload(client, sid, png_claiming(10_000, 5_000))
    assert bomb.status_code == 413 and "megapixel" in bomb.json()["detail"]["message"]
    data = img_bytes("PNG", (200, 200))
    cut = upload(client, sid, data[: len(data) // 2])
    assert cut.status_code == 422
    big = upload(client, sid, b"\x89PNG\r\n\x1a\n" + b"\x00" * (1024 * 1024 + 10))
    assert big.status_code == 413 and "LIVEOPS_MAX_PLAN_MB" in big.json()["detail"]["hint"]
    nothing = client.post(f"/api/sites/{sid}/plans", data={"other": "x"})
    assert nothing.status_code == 422


def test_other_sites_assets_are_not_reachable(client: TestClient) -> None:
    a, b = site(client, "A"), site(client, "B")
    aid = upload(client, a, img_bytes("PNG")).json()["asset_id"]
    assert client.get(f"/api/sites/{b}/plans/{aid}").status_code == 404
    assert client.delete(f"/api/sites/{b}/plans/{aid}").status_code == 404
    assert client.get(f"/api/sites/{a}/plans/{aid}").status_code == 200  # untouched
    assert client.get("/api/sites/nope/plans/" + aid).status_code == 404
    assert (
        client.post("/api/sites/nope/plans", files={"file": ("p.png", img_bytes("PNG"), "image/png")}).status_code
        == 404
    )
    for weird in ("..%2F..%2Fetc%2Fpasswd", "ABC", aid.upper(), aid + ".png"):
        assert client.get(f"/api/sites/{a}/plans/{weird}").status_code == 404


def test_deleting_a_site_removes_its_plans(client: TestClient, tmp_path: Path) -> None:
    a, b = site(client, "A"), site(client, "B")
    upload(client, a, img_bytes("PNG"))
    kept = upload(client, b, img_bytes("PNG")).json()["asset_id"]
    assert (tmp_path / "plans" / a).is_dir()
    assert client.delete(f"/api/sites/{a}").status_code == 204
    assert not (tmp_path / "plans" / a).exists()
    assert client.get(f"/api/sites/{b}/plans/{kept}").status_code == 200


def test_plan_count_per_site_is_capped(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "max_plans_per_site", 2)
    sid = site(client)
    assert upload(client, sid, img_bytes("PNG")).status_code == 201
    assert upload(client, sid, img_bytes("PNG")).status_code == 201
    r = upload(client, sid, img_bytes("PNG"))
    assert r.status_code == 409 and "Remove plans" in r.json()["detail"]["hint"]
