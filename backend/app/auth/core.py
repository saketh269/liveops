"""Who is calling: session cookie or API token → :class:`Identity` (ADR 0008)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection
from starlette.responses import Response

from app.auth.models import ApiToken, AuditLog, AuthSession, Organisation, User, now
from app.auth.security import API_TOKEN_PREFIX, csrf_for, new_token, token_hash
from app.config import get_settings

log = logging.getLogger("liveops.auth")

SESSION_COOKIE = "liveops_session"
CSRF_COOKIE = "liveops_csrf"
CSRF_HEADER = "x-csrf-token"
SESSION_TTL = timedelta(hours=12)
REMEMBER_TTL = timedelta(days=30)
SLIDE_EVERY = timedelta(seconds=60)  # write last_seen_at at most this often
TOKEN_TOUCH_EVERY = timedelta(seconds=60)

SCOPE_IDENTITY = "liveops.identity"
SCOPE_SESSION_TOKEN = "liveops.session_token"  # noqa: S105 - a scope key, not a secret


@dataclass(frozen=True)
class Identity:
    user_id: str
    org_id: str
    role: str
    via: Literal["session", "token"]
    session_id: str | None = None  # sessions.id (hash) when via == "session"
    token_id: str | None = None


def aware(t: datetime) -> datetime:
    """SQLite (and some drivers) hand back naive datetimes; treat them as UTC."""
    from datetime import UTC

    return t if t.tzinfo is not None else t.replace(tzinfo=UTC)


def session_ttl(remember: bool) -> timedelta:
    return REMEMBER_TTL if remember else SESSION_TTL


def resolve_session(db: Session, raw: str) -> Identity | None:
    sid = token_hash(raw)
    row = db.execute(
        select(AuthSession, User).join(User, User.id == AuthSession.user_id).where(AuthSession.id == sid)
    ).first()
    if row is None:
        return None
    sess, user = row
    t = now()
    if aware(sess.expires_at) <= t:
        db.delete(sess)
        db.commit()
        return None
    if user.status != "active":
        return None
    if t - aware(sess.last_seen_at) >= SLIDE_EVERY:
        sess.last_seen_at = t
        sess.expires_at = t + session_ttl(sess.remember)
        db.commit()
    return Identity(user_id=user.id, org_id=user.org_id, role=user.role, via="session", session_id=sid)


def resolve_api_token(db: Session, raw: str) -> Identity | None:
    if not raw.startswith(API_TOKEN_PREFIX):
        return None
    row = db.execute(
        select(ApiToken, User).join(User, User.id == ApiToken.user_id).where(ApiToken.token_hash == token_hash(raw))
    ).first()
    if row is None:
        return None
    tok, user = row
    if user.status != "active":
        return None
    t = now()
    if tok.last_used_at is None or t - aware(tok.last_used_at) >= TOKEN_TOUCH_EVERY:
        tok.last_used_at = t
        db.commit()
    return Identity(user_id=user.id, org_id=user.org_id, role=user.role, via="token", token_id=tok.id)


def bearer_token(conn: HTTPConnection) -> str | None:
    auth = conn.headers.get("authorization", "")
    scheme, _, value = auth.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip()


# ---- sessions & cookies -------------------------------------------------


def client_ip(conn: HTTPConnection) -> str:
    return conn.client.host if conn.client else ""


def create_session(db: Session, user: User, *, remember: bool, conn: HTTPConnection) -> str:
    """New session row; returns the raw cookie value (never stored)."""
    raw = new_token()
    t = now()
    db.add(
        AuthSession(
            id=token_hash(raw),
            user_id=user.id,
            created_at=t,
            last_seen_at=t,
            expires_at=t + session_ttl(remember),
            remember=remember,
            user_agent=(conn.headers.get("user-agent") or "")[:300],
            ip=client_ip(conn)[:64],
        )
    )
    user.last_sign_in_at = t
    return raw


def end_sessions(db: Session, user_id: str, *, keep: str | None = None) -> int:
    """Delete the user's sessions (all, or all but ``keep``). Returns how many."""
    q = delete(AuthSession).where(AuthSession.user_id == user_id)
    if keep is not None:
        q = q.where(AuthSession.id != keep)
    return db.execute(q).rowcount or 0  # type: ignore[attr-defined]


def _secure(conn: HTTPConnection) -> bool:
    return get_settings().cookie_secure or conn.url.scheme in ("https", "wss")


def set_auth_cookies(response: Response, conn: HTTPConnection, raw: str, *, remember: bool) -> None:
    max_age = int(REMEMBER_TTL.total_seconds()) if remember else None  # else: until the browser closes
    secure = _secure(conn)
    response.set_cookie(SESSION_COOKIE, raw, max_age=max_age, path="/", httponly=True, samesite="lax", secure=secure)
    # Readable by the page's script, which echoes it in X-CSRF-Token.
    response.set_cookie(
        CSRF_COOKIE, csrf_for(raw), max_age=max_age, path="/", httponly=False, samesite="lax", secure=secure
    )


def clear_auth_cookies(response: Response, conn: HTTPConnection) -> None:
    secure = _secure(conn)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=secure)
    response.delete_cookie(CSRF_COOKIE, path="/", httponly=False, samesite="lax", secure=secure)


def new_api_token() -> str:
    return new_token(API_TOKEN_PREFIX)


# ---- audit -------------------------------------------------------------

_SECRET_KEYS = {"password", "new_password", "current_password", "token", "password_hash", "token_hash"}


def audit(db: Session, action: str, *, user_id: str | None, target: str = "", **detail: Any) -> None:
    """Add an audit row (committed with the caller's transaction). Never pass secrets."""
    clean = {k: v for k, v in detail.items() if k not in _SECRET_KEYS}
    db.add(AuditLog(at=now(), user_id=user_id, action=action, target=target[:300], detail=clean))


# ---- shapes ------------------------------------------------------------


def iso(t: datetime | None) -> str | None:
    return aware(t).isoformat() if t is not None else None


def me_out(user: User, org: Organisation) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "org": {"id": org.id, "name": org.name},
        "email_verified": user.email_verified_at is not None,
    }


def user_out(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "status": user.status,
        "last_sign_in_at": iso(user.last_sign_in_at),
        "created_at": iso(user.created_at),
    }
