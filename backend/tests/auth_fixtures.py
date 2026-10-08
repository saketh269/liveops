"""Shared helpers for the sign-in tests (ADR 0008). They run with
``LIVEOPS_AUTH_REQUIRED=true``; the rest of the suite runs with it off."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

ADMIN = {"org_name": "Riverside Health", "name": "Ada Admin", "email": "ada@example.org", "password": "correct horse 1"}


@pytest.fixture
def auth_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    from app.auth import limits
    from app.config import get_settings

    monkeypatch.setenv("LIVEOPS_AUTH_REQUIRED", "true")
    monkeypatch.setenv("LIVEOPS_START_RUNNERS", "false")
    monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    monkeypatch.delenv("LIVEOPS_PUBLIC_SIGNUP", raising=False)
    monkeypatch.delenv("LIVEOPS_SMTP_HOST", raising=False)
    monkeypatch.delenv("LIVEOPS_COOKIE_SECURE", raising=False)
    get_settings.cache_clear()
    limits.reset_all()
    yield
    limits.reset_all()
    get_settings.cache_clear()  # the next get_settings() reads the restored env


@pytest.fixture
def app_factory(portal_db: str, auth_on: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("LIVEOPS_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    return create_app


@pytest.fixture
def client(app_factory: Any) -> Iterator[TestClient]:
    with TestClient(app_factory()) as c:
        yield c


def csrf(c: TestClient) -> dict[str, str]:
    return {"X-CSRF-Token": c.cookies.get("liveops_csrf") or ""}


def setup_admin(c: TestClient, **over: Any) -> dict[str, Any]:
    r = c.post("/api/auth/setup", json={**ADMIN, **over})
    assert r.status_code == 200, r.text
    return r.json()


def sign_in(c: TestClient, email: str, password: str, remember: bool = False) -> Any:
    return c.post("/api/auth/signin", json={"email": email, "password": password, "remember": remember})


def set_cookies(response: Any) -> dict[str, str]:
    """name -> raw Set-Cookie header, for checking flags."""
    out: dict[str, str] = {}
    for h in response.headers.get_list("set-cookie"):
        out[h.split("=", 1)[0]] = h
    return out
