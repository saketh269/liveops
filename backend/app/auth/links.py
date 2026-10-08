"""Single-use links: invite (7 days), password reset (1 hour), email verification (3 days)."""

from __future__ import annotations

from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.auth.core import aware
from app.auth.models import User, UserToken, now
from app.auth.security import new_token, token_hash

LIFETIME = {"invite": timedelta(days=7), "reset": timedelta(hours=1), "verify": timedelta(days=3)}
PAGE = {"invite": "invite", "reset": "reset", "verify": "verify"}


def issue(db: Session, user: User, purpose: str) -> str:
    """New link token; earlier unused links of the same purpose stop working.
    Returns the raw token (only its hash is stored)."""
    t = now()
    revoke(db, user.id, purpose)
    raw = new_token()
    db.add(UserToken(user_id=user.id, purpose=purpose, token_hash=token_hash(raw), expires_at=t + LIFETIME[purpose]))
    return raw


def revoke(db: Session, user_id: str, purpose: str) -> None:
    db.execute(
        update(UserToken)
        .where(UserToken.user_id == user_id, UserToken.purpose == purpose, UserToken.used_at.is_(None))
        .values(used_at=now())
    )


def invalid_link() -> HTTPException:
    return HTTPException(
        400,
        detail={
            "message": "This link is invalid or has expired.",
            "hint": "Links work once. Ask for a new one.",
        },
    )


def consume(db: Session, raw: str, purpose: str) -> User:
    """Mark the link used and return its user, or 400 if it is unknown, used or expired."""
    if not raw or len(raw) > 200:
        raise invalid_link()
    tok = db.scalars(
        select(UserToken).where(UserToken.token_hash == token_hash(raw), UserToken.purpose == purpose).with_for_update()
    ).first()
    if tok is None or tok.used_at is not None or aware(tok.expires_at) <= now():
        raise invalid_link()
    user = db.get(User, tok.user_id)
    if user is None:
        raise invalid_link()
    tok.used_at = now()
    return user
