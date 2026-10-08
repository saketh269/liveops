"""Sign-in foundation (ADR 0008) without a database: every registered route is
closed without a session, open routes are exactly the ADR's list, roles map
to the right routes, and the password/token/limit helpers behave."""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.auth import limits, security
from app.auth.guard import is_open, roles_for
from tests.auth_fixtures import auth_on  # noqa: F401 - fixture

ADR_OPEN = {
    ("GET", "/api/auth/state"),
    ("POST", "/api/auth/setup"),
    ("POST", "/api/auth/signin"),
    ("POST", "/api/auth/signup"),
    ("POST", "/api/auth/verify"),
    ("POST", "/api/auth/forgot"),
    ("POST", "/api/auth/reset"),
    ("POST", "/api/auth/invite/accept"),
    ("GET", "/api/health"),
    ("POST", "/api/webhooks/{source_id}"),
}


def _routes(app: Any) -> list[tuple[str, str]]:
    """(method or "WS", path template) for every registered route."""
    try:
        from fastapi.routing import iter_route_contexts

        contexts: list[Any] = list(iter_route_contexts(app.routes))
    except ImportError:  # older FastAPI: routes are flat
        contexts = list(app.routes)
    out: list[tuple[str, str]] = []
    for r in contexts:
        path = getattr(r, "path", None) or getattr(getattr(r, "original_route", None), "path", "")
        methods = getattr(r, "methods", None)
        if methods:
            out += [(m, path) for m in sorted(methods) if m != "HEAD"]
        else:
            out.append(("WS", path))
    return out


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x1", path)


@pytest.fixture
def app(auth_on: None) -> Iterator[Any]:
    from app.main import create_app

    yield create_app()


def test_every_route_but_the_open_ones_needs_a_session(app: Any) -> None:
    c = TestClient(app)  # no lifespan: nothing below may reach the database
    routes = _routes(app)
    assert len(routes) > 40
    assert ("WS", "/ws/sites/{site_id}") in routes
    seen_open = set()
    for method, path in routes:
        if method == "WS":
            continue
        if (method, path) in ADR_OPEN:
            seen_open.add((method, path))
            continue
        r = c.request(method, _concrete(path), json={})
        assert r.status_code == 401, (method, path, r.status_code, r.text)
        assert r.json() == {"detail": {"message": "Sign in to continue."}}, (method, path)
    assert seen_open == ADR_OPEN  # every open route the ADR lists exists, and no others


def test_closed_without_session_even_with_bad_body_or_unknown_path(app: Any) -> None:
    c = TestClient(app)
    # Auth runs before body parsing / uploads: no 422 or 413 leaks out first.
    assert c.post("/api/sources", content=b"{not json", headers={"content-type": "application/json"}).status_code == 401
    assert c.post("/api/sites/x1/plans", files={"file": ("a.png", b"x" * 1000, "image/png")}).status_code == 401
    assert c.get("/api/no-such-thing").status_code == 401
    assert c.get("/api/health/").status_code == 401  # only the exact open path
    assert c.get("/openapi.json").status_code == 401


def test_websocket_refused_without_session(app: Any) -> None:
    c = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as e, c.websocket_connect("/ws/sites/hs") as ws:
        ws.receive_text()
    assert e.value.code == 1008


def test_open_routes_list_matches_adr() -> None:
    for method, path in ADR_OPEN:
        assert is_open(method, _concrete(path)), (method, path)
    assert not is_open("GET", "/api/health/mappings")
    assert not is_open("GET", "/api/webhooks/abc")  # only POST
    assert not is_open("POST", "/api/webhooks/a/b")
    assert not is_open("POST", "/api/auth/signout")
    assert not is_open("GET", "/api/auth/me")
    assert not is_open("POST", "/api/auth/tokens")


@pytest.mark.parametrize(
    ("method", "path", "roles"),
    [
        ("GET", "/api/sites", {"admin", "manager", "viewer", "wallboard"}),
        ("GET", "/api/sites/hs", {"admin", "manager", "viewer", "wallboard"}),
        ("GET", "/api/sites/hs/assets", {"admin", "manager", "viewer", "wallboard"}),
        ("GET", "/api/sites/hs/events", {"admin", "manager", "viewer", "wallboard"}),
        ("GET", "/api/sites/hs/plans/p1", {"admin", "manager", "viewer", "wallboard"}),
        ("WS", "/ws/sites/hs", {"admin", "manager", "viewer", "wallboard"}),
        ("GET", "/api/sources", {"admin", "manager", "viewer"}),
        ("GET", "/api/sites/hs/assets/a/history", {"admin", "manager", "viewer"}),
        ("POST", "/api/sites", {"admin", "manager"}),
        ("PUT", "/api/sites/hs", {"admin", "manager"}),
        ("DELETE", "/api/mappings/m", {"admin", "manager"}),
        ("GET", "/api/users", {"admin"}),
        ("PATCH", "/api/users/u", {"admin"}),
        ("GET", "/api/org", {"admin"}),
        ("POST", "/api/auth/me/password", {"admin", "manager", "viewer", "wallboard"}),
    ],
)
def test_roles_for(method: str, path: str, roles: set[str]) -> None:
    assert set(roles_for(method, path)) == roles


def test_password_hashing_is_argon2id_and_verifies() -> None:
    h = security.hash_password("correct horse 1")
    assert h.startswith("$argon2id$")
    assert "correct horse" not in h
    assert security.verify_password(h, "correct horse 1")
    assert not security.verify_password(h, "correct horse 2")
    assert not security.verify_password(None, "anything")  # unknown email: dummy hash, False
    assert not security.verify_password("garbage", "anything")


def test_password_rules() -> None:
    assert security.password_problem("short", "a@b.co") is not None
    assert security.password_problem("a@example.org", "A@Example.org") is not None  # same as email
    assert security.password_problem("long enough pw", "a@b.co") is None


def test_tokens_hash_and_csrf_binding() -> None:
    a, b = security.new_token(), security.new_token("lo_")
    assert a != b and b.startswith("lo_") and len(a) >= 40
    assert security.token_hash(a) == security.token_hash(a) != a
    assert len(security.token_hash(a)) == 64
    assert security.csrf_for(a) != security.csrf_for(security.new_token())


def test_email_rules() -> None:
    assert security.email_problem("  Ada@Example.org ") is None
    assert security.normalise_email("  Ada@Example.org ") == "ada@example.org"
    for bad in ("", "ada", "ada@", "@x.org", "a b@x.org", "a@x", "a@b@x.org"):
        assert security.email_problem(bad) is not None, bad


def test_sliding_window_limits_per_key() -> None:
    w = limits.SlidingWindow(3, 10)
    assert all(w.hit("ip", now=t) for t in (0, 1, 2))
    assert not w.hit("ip", now=3)
    assert w.hit("other", now=3)
    assert w.retry_after("ip", now=3) > 0
    assert w.hit("ip", now=10.5)  # oldest hit left the window


def test_ghost_lockout_mirrors_real_lockout() -> None:
    g = limits.GhostLockout()
    assert [g.fail("x@y.org") for _ in range(limits.MAX_FAILED)] == [False] * (limits.MAX_FAILED - 1) + [True]
    assert g.locked("x@y.org")
    assert not g.locked("z@y.org")
