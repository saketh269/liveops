"""Sign-in and accounts API against a real portal DB (ADR 0008), with
``LIVEOPS_AUTH_REQUIRED=true``."""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from starlette.websockets import WebSocketDisconnect

from tests.auth_fixtures import (  # noqa: F401 - fixtures
    ADMIN,
    app_factory,
    auth_on,
    client,
    csrf,
    set_cookies,
    setup_admin,
    sign_in,
)

pytestmark = pytest.mark.integration


def db() -> Any:
    from app.db import new_session

    return new_session()


def rows(model: Any, *where: Any) -> list[Any]:
    with db() as s:
        return list(s.scalars(select(model).where(*where)))


def add_user(c: TestClient, email: str, role: str, password: str = "a long password") -> dict[str, Any]:
    r = c.post(
        "/api/users",
        json={"email": email, "name": email.split("@")[0], "role": role, "mode": "password", "password": password},
        headers=csrf(c),
    )
    assert r.status_code == 201, r.text
    return r.json()["user"]


def other_client(c: TestClient) -> TestClient:
    """A second browser on the same app (no cookies)."""
    return TestClient(c.app)


def replace_cookie(c: TestClient, name: str, value: str) -> None:
    domain = next(ck.domain for ck in c.cookies.jar if ck.name == name)
    c.cookies.delete(name)
    c.cookies.set(name, value, domain=domain, path="/")


def token_from(link: str) -> str:
    m = re.search(r"token=([^&\s]+)", link)
    assert m, link
    return m.group(1)


# ---- setup, state, cookies ------------------------------------------------------


def test_first_visit_setup_creates_admin_and_signs_in(client: TestClient) -> None:
    assert client.get("/api/auth/state").json() == {"setup_required": True, "signup_open": False, "sso": []}
    assert client.get("/api/auth/me").status_code == 401
    r = client.post("/api/auth/setup", json={**ADMIN, "email": "  Ada@Example.ORG "})
    assert r.status_code == 200, r.text
    me = r.json()
    assert set(me) == {"id", "email", "name", "role", "org", "email_verified"}
    assert me["email"] == "ada@example.org" and me["role"] == "admin" and me["org"]["name"] == "Riverside Health"
    assert set(me["org"]) == {"id", "name"}
    cookies = set_cookies(r)
    sess, csrf_c = cookies["liveops_session"].lower(), cookies["liveops_csrf"].lower()
    assert "httponly" in sess and "samesite=lax" in sess and "path=/" in sess and "secure" not in sess
    assert "max-age" not in sess  # not "remember me": ends with the browser
    assert "httponly" not in csrf_c and "samesite=lax" in csrf_c
    assert client.get("/api/auth/me").json() == me
    assert client.get("/api/auth/state").json()["setup_required"] is False
    # Setup works once only.
    r2 = other_client(client).post("/api/auth/setup", json={**ADMIN, "email": "eve@example.org"})
    assert r2.status_code == 409


def test_setup_validates_password_and_email(client: TestClient) -> None:
    assert client.post("/api/auth/setup", json={**ADMIN, "password": "short"}).status_code == 422
    r = client.post("/api/auth/setup", json={**ADMIN, "password": ADMIN["email"]})
    assert r.status_code == 422 and "same as the email" in r.json()["detail"]["message"]
    assert client.post("/api/auth/setup", json={**ADMIN, "email": "nope"}).status_code == 422
    assert client.get("/api/auth/state").json()["setup_required"] is True


def test_cookies_secure_when_configured(app_factory: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setenv("LIVEOPS_COOKIE_SECURE", "true")
    get_settings.cache_clear()
    with TestClient(app_factory()) as c:
        r = c.post("/api/auth/setup", json=ADMIN)
        assert r.status_code == 200
        for v in set_cookies(r).values():
            assert "secure" in v.lower()


def test_remember_me_sets_30_day_cookies(client: TestClient) -> None:
    setup_admin(client)
    c2 = other_client(client)
    r = sign_in(c2, ADMIN["email"], ADMIN["password"], remember=True)
    assert r.status_code == 200
    for v in set_cookies(r).values():
        assert f"max-age={30 * 24 * 3600}" in v.lower()
    from app.auth.models import AuthSession

    s = [x for x in rows(AuthSession) if x.remember]
    assert len(s) == 1 and s[0].expires_at - s[0].created_at >= timedelta(days=29)


def test_session_stored_only_as_hash(client: TestClient) -> None:
    setup_admin(client)
    from app.auth.models import AuthSession

    raw = client.cookies["liveops_session"]
    ids = [s.id for s in rows(AuthSession)]
    assert ids == [hashlib.sha256(raw.encode()).hexdigest()]
    assert raw not in ids


# ---- sign-in, lockout, limits ---------------------------------------------------


def test_signin_wrong_password_and_unknown_email_look_the_same(client: TestClient) -> None:
    setup_admin(client)
    c = other_client(client)
    a = sign_in(c, ADMIN["email"], "wrong password!")
    b = sign_in(c, "nobody@example.org", "wrong password!")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json() == {"detail": {"message": "Email or password is incorrect."}}
    ok = sign_in(c, ADMIN["email"].upper(), ADMIN["password"])
    assert ok.status_code == 200 and ok.json()["email"] == ADMIN["email"]


def test_five_failures_lock_for_15_minutes_known_or_not(client: TestClient) -> None:
    setup_admin(client)
    c = other_client(client)
    for email in (ADMIN["email"], "ghost@example.org"):
        codes = [sign_in(c, email, "wrong password!").status_code for _ in range(5)]
        assert codes == [401, 401, 401, 401, 423], email
        r = sign_in(c, email, ADMIN["password"])  # even the right password
        assert r.status_code == 423 and "15 minutes" in r.json()["detail"]["message"]
    from app.auth.models import AuditLog, User

    (u,) = rows(User, User.email == ADMIN["email"])
    assert u.locked_until is not None
    # Lock over: right password works and resets the counter.
    with db() as s:
        s.execute(update(User).values(locked_until=u.locked_until - timedelta(minutes=16)))
        s.commit()
    assert sign_in(c, ADMIN["email"], ADMIN["password"]).status_code == 200
    fails = rows(AuditLog, AuditLog.action == "signin.fail")
    assert len(fails) >= 10
    assert all("password" not in f.detail and ADMIN["password"] not in str(f.detail) for f in fails)
    assert rows(AuditLog, AuditLog.action == "signin.ok")


def test_per_ip_signin_limit(client: TestClient) -> None:
    setup_admin(client)
    c = other_client(client)
    codes = [sign_in(c, f"user{i}@example.org", "wrong password!").status_code for i in range(21)]
    assert codes[:20] == [401] * 20 and codes[20] == 429


def test_signout_ends_session_and_clears_cookies(client: TestClient) -> None:
    setup_admin(client)
    raw = client.cookies["liveops_session"]
    r = client.post("/api/auth/signout", headers=csrf(client))
    assert r.status_code == 204
    cleared = set_cookies(r)
    assert 'liveops_session=""' in cleared["liveops_session"] or "max-age=0" in cleared["liveops_session"].lower()
    assert client.get("/api/auth/me").status_code == 401
    # The old cookie value is dead server-side too.
    c = other_client(client)
    c.cookies.set("liveops_session", raw, domain="testserver.local")
    assert c.get("/api/auth/me").status_code == 401


def test_expired_session_rejected(client: TestClient) -> None:
    setup_admin(client)
    from app.auth.models import AuthSession, now

    with db() as s:
        s.execute(update(AuthSession).values(expires_at=now() - timedelta(seconds=1)))
        s.commit()
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/sites").status_code == 401
    assert rows(AuthSession) == []  # expired row removed


def test_session_slides(client: TestClient) -> None:
    setup_admin(client)
    from app.auth.models import AuthSession, now

    old = now() - timedelta(hours=11)
    with db() as s:
        s.execute(update(AuthSession).values(last_seen_at=old, expires_at=old + timedelta(hours=12)))
        s.commit()
    assert client.get("/api/sites").status_code == 200
    (sess,) = rows(AuthSession)
    assert sess.expires_at > now() + timedelta(hours=11, minutes=59)


# ---- CSRF ----------------------------------------------------------------------


def test_csrf_required_on_unsafe_requests_with_session(client: TestClient) -> None:
    setup_admin(client)
    body = {"name": "General", "template": "hospital"}
    r = client.post("/api/sites", json=body)
    assert r.status_code == 403 and "security token" in r.json()["detail"]["hint"]
    assert client.post("/api/sites", json=body, headers={"X-CSRF-Token": "nope"}).status_code == 403
    # A cookie planted by an attacker plus a matching header still fails: the value is bound to the session.
    replace_cookie(client, "liveops_csrf", "planted")
    assert client.post("/api/sites", json=body, headers={"X-CSRF-Token": "planted"}).status_code == 403
    client.get("/api/auth/me")  # restores the real CSRF cookie
    assert client.post("/api/sites", json=body, headers=csrf(client)).status_code == 201
    assert client.get("/api/sites").status_code == 200  # GET needs none
    assert client.post("/api/auth/signout").status_code == 403  # sign-out too


# ---- API tokens ---------------------------------------------------------------


def test_api_tokens_bearer_skips_csrf_and_is_hashed(client: TestClient) -> None:
    setup_admin(client)
    r = client.post("/api/auth/tokens", json={"name": "setup script"}, headers=csrf(client))
    assert r.status_code == 201
    tok = r.json()
    assert tok["token"].startswith("lo_") and tok["name"] == "setup script"
    listed = client.get("/api/auth/tokens").json()
    assert listed == [{k: v for k, v in tok.items() if k != "token"}]
    from app.auth.models import ApiToken

    (row,) = rows(ApiToken)
    assert row.token_hash == hashlib.sha256(tok["token"].encode()).hexdigest()
    bare = other_client(client)
    h = {"Authorization": f"Bearer {tok['token']}"}
    assert bare.post("/api/sites", json={"name": "S", "template": "hospital"}, headers=h).status_code == 201
    assert bare.get("/api/auth/me", headers=h).json()["email"] == ADMIN["email"]
    # A wrong Bearer is not rescued by a valid cookie.
    assert client.get("/api/sites", headers={"Authorization": "Bearer lo_wrong"}).status_code == 401
    # Bearer can't open the live stream (session only).
    with pytest.raises(WebSocketDisconnect), bare.websocket_connect("/ws/sites/hs", headers=h) as ws:
        ws.receive_text()
    assert client.delete(f"/api/auth/tokens/{tok['id']}", headers=csrf(client)).status_code == 204
    assert bare.get("/api/sites", headers=h).status_code == 401


# ---- WebSocket --------------------------------------------------------------------


def test_websocket_needs_session_cookie(client: TestClient) -> None:
    setup_admin(client)
    with client.websocket_connect("/ws/sites/hs") as ws:
        assert '"snapshot"' in ws.receive_text()
    with pytest.raises(WebSocketDisconnect) as e, other_client(client).websocket_connect("/ws/sites/hs") as ws:
        ws.receive_text()
    assert e.value.code == 1008
    # The Origin check stays.
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws/sites/hs", headers={"Origin": "https://evil.example"}) as ws,
    ):
        ws.receive_text()


# ---- My account ------------------------------------------------------------------


def test_password_change_ends_other_sessions_only(client: TestClient) -> None:
    setup_admin(client)
    laptop = other_client(client)
    assert sign_in(laptop, ADMIN["email"], ADMIN["password"]).status_code == 200
    sessions = client.get("/api/auth/me/sessions").json()
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    assert set(sessions[0]) == {"id", "created_at", "last_seen_at", "user_agent", "ip", "current"}
    bad = client.post(
        "/api/auth/me/password",
        json={"current_password": "not it at all", "new_password": "a new password"},
        headers=csrf(client),
    )
    assert bad.status_code == 400  # not 401: the UI must not treat it as signed out
    ok = client.post(
        "/api/auth/me/password",
        json={"current_password": ADMIN["password"], "new_password": "a new password"},
        headers=csrf(client),
    )
    assert ok.status_code == 204
    assert client.get("/api/auth/me").status_code == 200
    assert laptop.get("/api/auth/me").status_code == 401
    assert sign_in(other_client(client), ADMIN["email"], ADMIN["password"]).status_code == 401
    assert sign_in(other_client(client), ADMIN["email"], "a new password").status_code == 200


def test_sessions_end_one_and_all_others(client: TestClient) -> None:
    setup_admin(client)
    phones = [other_client(client) for _ in range(2)]
    for p in phones:
        sign_in(p, ADMIN["email"], ADMIN["password"])
    listed = client.get("/api/auth/me/sessions").json()
    other = next(s for s in listed if not s["current"])
    assert client.delete(f"/api/auth/me/sessions/{other['id']}", headers=csrf(client)).status_code == 204
    assert sum(p.get("/api/auth/me").status_code == 200 for p in phones) == 1
    assert client.delete("/api/auth/me/sessions", headers=csrf(client)).status_code == 204
    assert all(p.get("/api/auth/me").status_code == 401 for p in phones)
    assert client.get("/api/auth/me").status_code == 200
    assert client.delete("/api/auth/me/sessions/nope", headers=csrf(client)).status_code == 404


def test_update_my_name(client: TestClient) -> None:
    setup_admin(client)
    r = client.patch("/api/auth/me", json={"name": "Ada L."}, headers=csrf(client))
    assert r.status_code == 200 and r.json()["name"] == "Ada L."


# ---- forgot / reset ------------------------------------------------------------


def _logged_link(caplog: pytest.LogCaptureFixture, kind: str) -> str:
    lines = [
        r.getMessage() for r in caplog.records if r.name == "liveops.auth.mail" and f"{kind} link" in r.getMessage()
    ]
    assert lines, caplog.text
    return lines[-1]


def test_forgot_and_reset_end_all_sessions(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="liveops.auth.mail")
    setup_admin(client)
    c = other_client(client)
    assert c.post("/api/auth/forgot", json={"email": "nobody@example.org"}).status_code == 204
    assert not [r for r in caplog.records if r.name == "liveops.auth.mail"]
    assert c.post("/api/auth/forgot", json={"email": ADMIN["email"]}).status_code == 204
    line = _logged_link(caplog, "reset")
    assert "/reset?token=" in line and line.count("\n") == 0
    token = token_from(line)
    from app.auth.models import AuditLog, UserToken

    (t,) = rows(UserToken, UserToken.purpose == "reset")
    assert t.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert c.post("/api/auth/reset", json={"token": token, "password": "short"}).status_code == 422
    assert c.post("/api/auth/reset", json={"token": token, "password": "brand new password"}).status_code == 204
    assert client.get("/api/auth/me").status_code == 401  # every session ended
    assert c.post("/api/auth/reset", json={"token": token, "password": "another password"}).status_code == 400
    assert sign_in(c, ADMIN["email"], "brand new password").status_code == 200
    (a,) = rows(AuditLog, AuditLog.action == "password.reset")
    assert token not in str(a.detail) and "brand new" not in str(a.detail)


def test_expired_reset_and_unknown_tokens_rejected(client: TestClient) -> None:
    setup_admin(client)
    me = client.get("/api/auth/me").json()
    link = client.post(f"/api/users/{me['id']}/reset-password", headers=csrf(client)).json()["reset_link"]
    from app.auth.models import UserToken, now

    with db() as s:
        s.execute(update(UserToken).values(expires_at=now() - timedelta(seconds=1)))
        s.commit()
    c = other_client(client)
    r = c.post("/api/auth/reset", json={"token": token_from(link), "password": "brand new password"})
    assert r.status_code == 400 and "expired" in r.json()["detail"]["message"]
    assert c.post("/api/auth/reset", json={"token": "made-up", "password": "brand new password"}).status_code == 400
    assert c.post("/api/auth/verify", json={"token": token_from(link)}).status_code == 400  # wrong purpose


def test_new_reset_link_replaces_older_one(client: TestClient) -> None:
    setup_admin(client)
    me = client.get("/api/auth/me").json()
    first = client.post(f"/api/users/{me['id']}/reset-password", headers=csrf(client)).json()["reset_link"]
    second = client.post(f"/api/users/{me['id']}/reset-password", headers=csrf(client)).json()["reset_link"]
    c = other_client(client)
    assert c.post("/api/auth/reset", json={"token": token_from(first), "password": "brand new pw 1"}).status_code == 400
    assert (
        c.post("/api/auth/reset", json={"token": token_from(second), "password": "brand new pw 2"}).status_code == 204
    )


# ---- users, invites, roles ----------------------------------------------------------


def test_invite_flow_single_use_and_expiry(client: TestClient) -> None:
    setup_admin(client)
    r = client.post(
        "/api/users",
        json={"email": "Nina@Example.org", "name": "Nina", "role": "manager", "mode": "invite"},
        headers=csrf(client),
    )
    assert r.status_code == 201, r.text
    out = r.json()
    assert set(out) == {"user", "invite_link"}
    assert set(out["user"]) == {"id", "email", "name", "role", "status", "last_sign_in_at", "created_at"}
    assert out["user"]["status"] == "invited" and out["user"]["email"] == "nina@example.org"
    assert "/invite?token=" in out["invite_link"]
    token = token_from(out["invite_link"])
    nina = other_client(client)
    assert sign_in(nina, "nina@example.org", "anything long").status_code == 401  # no password yet
    r = nina.post("/api/auth/invite/accept", json={"token": token, "name": "Nina N", "password": "ninas password"})
    assert r.status_code == 200 and r.json()["role"] == "manager" and r.json()["email_verified"] is True
    assert nina.get("/api/auth/me").json()["name"] == "Nina N"
    again = other_client(client).post(
        "/api/auth/invite/accept", json={"token": token, "name": "X", "password": "other password"}
    )
    assert again.status_code == 400
    # Expired invite.
    r = client.post(
        "/api/users",
        json={"email": "old@example.org", "name": "Old", "role": "viewer", "mode": "invite"},
        headers=csrf(client),
    )
    from app.auth.models import UserToken, now

    with db() as s:
        s.execute(update(UserToken).where(UserToken.purpose == "invite").values(expires_at=now() - timedelta(days=1)))
        s.commit()
    late = other_client(client).post(
        "/api/auth/invite/accept",
        json={"token": token_from(r.json()["invite_link"]), "name": "Old", "password": "old password!"},
    )
    assert late.status_code == 400
    # Resend gives a fresh working link.
    uid = r.json()["user"]["id"]
    link = client.post(f"/api/users/{uid}/resend-invite", headers=csrf(client)).json()["invite_link"]
    ok = other_client(client).post(
        "/api/auth/invite/accept", json={"token": token_from(link), "name": "Old", "password": "old password!"}
    )
    assert ok.status_code == 200


def test_roles_are_enforced(client: TestClient) -> None:
    setup_admin(client)
    site = client.post("/api/sites", json={"name": "General", "template": "hospital"}, headers=csrf(client)).json()
    for role in ("manager", "viewer", "wallboard"):
        add_user(client, f"{role}@example.org", role)
    seen: dict[str, dict[str, int]] = {}
    for role in ("manager", "viewer", "wallboard"):
        c = other_client(client)
        assert sign_in(c, f"{role}@example.org", "a long password").status_code == 200
        h = csrf(c)
        seen[role] = {
            "sites": c.get("/api/sites").status_code,
            "site": c.get(f"/api/sites/{site['id']}").status_code,
            "assets": c.get(f"/api/sites/{site['id']}/assets").status_code,
            "sources": c.get("/api/sources").status_code,
            "mappings": c.get("/api/mappings").status_code,
            "create_site": c.post("/api/sites", json={"name": role, "template": "hospital"}, headers=h).status_code,
            "users": c.get("/api/users").status_code,
            "org": c.get("/api/org").status_code,
            "me": c.get("/api/auth/me").status_code,
        }
        with c.websocket_connect(f"/ws/sites/{site['id']}") as ws:
            assert '"snapshot"' in ws.receive_text()
    assert seen["manager"] == {**dict.fromkeys(seen["manager"], 200), "create_site": 201, "users": 403, "org": 403}
    assert seen["viewer"] == {**dict.fromkeys(seen["viewer"], 200), "create_site": 403, "users": 403, "org": 403}
    assert seen["wallboard"] == {
        **dict.fromkeys(seen["wallboard"], 200),
        "sources": 403,
        "mappings": 403,
        "create_site": 403,
        "users": 403,
        "org": 403,
    }
    assert client.get("/api/users").status_code == 200


def test_last_admin_cannot_be_demoted_or_disabled(client: TestClient) -> None:
    me = setup_admin(client)
    h = csrf(client)
    for change in ({"role": "manager"}, {"status": "disabled"}):
        r = client.patch(f"/api/users/{me['id']}", json=change, headers=h)
        assert r.status_code == 409 and "at least one active admin" in r.json()["detail"]["message"]
    other = add_user(client, "bob@example.org", "admin")
    r = client.patch(f"/api/users/{other['id']}", json={"status": "disabled"}, headers=h)
    assert r.status_code == 200 and r.json()["status"] == "disabled"
    # A disabled admin doesn't count.
    assert client.patch(f"/api/users/{me['id']}", json={"role": "viewer"}, headers=h).status_code == 409
    client.patch(f"/api/users/{other['id']}", json={"status": "active"}, headers=h)
    r = client.patch(f"/api/users/{me['id']}", json={"role": "viewer"}, headers=h)
    assert r.status_code == 200 and r.json()["role"] == "viewer"
    assert client.get("/api/users").status_code == 403  # takes effect at once


def test_disabling_a_user_ends_sessions_and_tokens(client: TestClient) -> None:
    setup_admin(client)
    u = add_user(client, "vic@example.org", "viewer")
    vic = other_client(client)
    sign_in(vic, "vic@example.org", "a long password")
    tok = vic.post("/api/auth/tokens", json={"name": "t"}, headers=csrf(vic)).json()["token"]
    assert client.patch(f"/api/users/{u['id']}", json={"status": "disabled"}, headers=csrf(client)).status_code == 200
    assert vic.get("/api/auth/me").status_code == 401
    assert other_client(client).get("/api/sites", headers={"Authorization": f"Bearer {tok}"}).status_code == 401
    r = sign_in(other_client(client), "vic@example.org", "a long password")
    assert r.status_code == 401 and "turned off" in r.json()["detail"]["message"]


def test_admin_user_validation(client: TestClient) -> None:
    setup_admin(client)
    h = csrf(client)
    base = {"email": "x@example.org", "name": "X", "role": "viewer"}
    assert client.post("/api/users", json={**base, "mode": "password"}, headers=h).status_code == 422
    assert (
        client.post("/api/users", json={**base, "mode": "password", "password": "short"}, headers=h).status_code == 422
    )
    assert client.post("/api/users", json={**base, "role": "root", "mode": "invite"}, headers=h).status_code == 422
    r = client.post("/api/users", json={**base, "email": ADMIN["email"], "mode": "invite"}, headers=h)
    assert r.status_code == 409
    assert client.patch("/api/users/not-there", json={"name": "Y"}, headers=h).status_code == 404


def test_audit_rows_for_user_changes(client: TestClient) -> None:
    setup_admin(client)
    u = add_user(client, "mo@example.org", "viewer")
    h = csrf(client)
    client.patch(f"/api/users/{u['id']}", json={"role": "manager"}, headers=h)
    client.patch(f"/api/users/{u['id']}", json={"status": "disabled"}, headers=h)
    from app.auth.models import AuditLog

    actions = [a.action for a in rows(AuditLog)]
    for expected in ("setup", "user.create", "user.role", "user.status"):
        assert expected in actions
    for a in rows(AuditLog):
        assert "a long password" not in str(a.detail) and "password" not in a.detail and "token" not in a.detail


# ---- sign-up, verification, org settings ----------------------------------------


def test_signup_closed_then_opened_and_email_verification(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="liveops.auth.mail")
    setup_admin(client)
    body = {
        "org_name": "Lakeside",
        "name": "Lee",
        "email": "lee@example.org",
        "password": "lees password",
        "accept_terms": True,
    }
    c = other_client(client)
    assert c.post("/api/auth/signup", json=body).status_code == 403
    assert client.get("/api/org").json() == {"name": "Riverside Health", "signup_open": False}
    r = client.patch("/api/org", json={"signup_open": True}, headers=csrf(client))
    assert r.json() == {"name": "Riverside Health", "signup_open": True}
    assert c.get("/api/auth/state").json()["signup_open"] is True
    assert c.post("/api/auth/signup", json={**body, "accept_terms": False}).status_code == 422
    r = c.post("/api/auth/signup", json=body)
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["role"] == "admin" and me["org"]["name"] == "Lakeside" and me["email_verified"] is False
    token = token_from(_logged_link(caplog, "verify"))
    assert c.post("/api/auth/verify", json={"token": token}).status_code == 204
    assert c.get("/api/auth/me").json()["email_verified"] is True
    assert c.post("/api/auth/verify", json={"token": token}).status_code == 400
    # Org admins only see their own users.
    assert [u["email"] for u in c.get("/api/users").json()] == ["lee@example.org"]


def test_public_signup_env(app_factory: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setenv("LIVEOPS_PUBLIC_SIGNUP", "true")
    get_settings.cache_clear()
    with TestClient(app_factory()) as c:
        body = {"org_name": "A", "name": "A", "email": "a@example.org", "password": "a password!", "accept_terms": True}
        assert c.post("/api/auth/signup", json=body).status_code == 409  # setup first
        setup_admin(c)
        assert TestClient(c.app).post("/api/auth/signup", json=body).status_code == 200
