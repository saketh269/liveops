"""User management and organisation settings — admins only (ADR 0008)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import check_new_account, unprocessable
from app.auth import links, mail
from app.auth.core import Identity, audit, end_sessions, user_out
from app.auth.guard import require_role
from app.auth.models import Organisation, User, now
from app.auth.security import email_problem, hash_password, normalise_email
from app.db import get_session

router = APIRouter(prefix="/api", tags=["users"])
require_admin = require_role("admin")

Role = Literal["admin", "manager", "viewer", "wallboard"]


class UserIn(BaseModel):
    email: str = Field(max_length=254)
    name: str = Field(min_length=1, max_length=200)
    role: Role
    mode: Literal["invite", "password"]
    password: str | None = Field(default=None, max_length=1024)


class UserUpdate(BaseModel):
    role: Role | None = None
    status: Literal["active", "disabled"] | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)


class OrgUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    signup_open: bool | None = None


def _org_user(db: Session, admin: Identity, user_id: str) -> User:
    user = db.get(User, user_id)
    if user is None or user.org_id != admin.org_id:
        raise HTTPException(404, detail={"message": "No such user in your organisation."})
    return user


def _other_active_admins(db: Session, org_id: str, user_id: str) -> int:
    """Locks the org's active admins, so two admins can't demote each other at once."""
    ids = db.scalars(
        select(User.id).where(User.org_id == org_id, User.role == "admin", User.status == "active").with_for_update()
    ).all()
    return len([i for i in ids if i != user_id])


@router.get("/users")
def list_users(admin: Identity = Depends(require_admin), db: Session = Depends(get_session)) -> list[dict[str, Any]]:
    rows = db.scalars(select(User).where(User.org_id == admin.org_id).order_by(User.created_at, User.email))
    return [user_out(u) for u in rows]


@router.post("/users", status_code=201)
def create_user(
    body: UserIn,
    request: Request,
    background: BackgroundTasks,
    admin: Identity = Depends(require_admin),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    if body.mode == "password":
        if not body.password:
            raise unprocessable("Enter a password, or send an invite instead.")
        email = check_new_account(body.email, body.password)
    else:
        if problem := email_problem(body.email):
            raise unprocessable(problem)
        email = normalise_email(body.email)
    if db.scalars(select(User.id).where(User.email == email)).first() is not None:
        raise HTTPException(409, detail={"message": "Someone with this email already has an account."})
    user = User(
        org_id=admin.org_id,
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password) if body.mode == "password" and body.password else None,
        role=body.role,
        status="active" if body.mode == "password" else "invited",
        failed_attempts=0,
        created_at=now(),
    )
    db.add(user)
    db.flush()
    kind = "invite" if body.mode == "invite" else "verify"
    raw = links.issue(db, user, kind)
    audit(db, "user.create", user_id=admin.user_id, target=user.id, email=email, role=body.role, mode=body.mode)
    db.commit()
    url = mail.link(request, kind, raw)
    background.add_task(mail.send_link, email, kind, url)
    out: dict[str, Any] = {"user": user_out(user)}
    if body.mode == "invite":
        out["invite_link"] = url
    return out


@router.patch("/users/{user_id}")
def update_user(
    user_id: str, body: UserUpdate, admin: Identity = Depends(require_admin), db: Session = Depends(get_session)
) -> dict[str, Any]:
    user = _org_user(db, admin, user_id)
    loses_admin = (
        user.role == "admin"
        and user.status == "active"
        and ((body.role is not None and body.role != "admin") or body.status == "disabled")
    )
    if loses_admin and _other_active_admins(db, user.org_id, user.id) == 0:
        raise HTTPException(
            409,
            detail={
                "message": "Your organisation needs at least one active admin.",
                "hint": "Make someone else an admin first.",
            },
        )
    if body.status == "active" and user.status != "active" and not user.password_hash:
        raise HTTPException(
            409,
            detail={
                "message": "This person hasn't accepted their invite yet.",
                "hint": "Send the invite again instead.",
            },
        )
    if body.name is not None and body.name.strip() != user.name:
        user.name = body.name.strip()
        audit(db, "user.name", user_id=admin.user_id, target=user.id)
    if body.role is not None and body.role != user.role:
        audit(db, "user.role", user_id=admin.user_id, target=user.id, old=user.role, new=body.role)
        user.role = body.role
    if body.status is not None and body.status != user.status:
        audit(db, "user.status", user_id=admin.user_id, target=user.id, old=user.status, new=body.status)
        user.status = body.status
        if body.status == "disabled":
            end_sessions(db, user.id)
            for purpose in ("invite", "reset", "verify"):
                links.revoke(db, user.id, purpose)
    db.commit()
    return user_out(user)


@router.post("/users/{user_id}/resend-invite")
def resend_invite(
    user_id: str,
    request: Request,
    background: BackgroundTasks,
    admin: Identity = Depends(require_admin),
    db: Session = Depends(get_session),
) -> dict[str, str]:
    user = _org_user(db, admin, user_id)
    if user.status != "invited":
        raise HTTPException(409, detail={"message": "This person has already accepted their invite."})
    raw = links.issue(db, user, "invite")
    audit(db, "user.invite_resend", user_id=admin.user_id, target=user.id)
    db.commit()
    url = mail.link(request, "invite", raw)
    background.add_task(mail.send_link, user.email, "invite", url)
    return {"invite_link": url}


@router.post("/users/{user_id}/reset-password")
def admin_reset_password(
    user_id: str,
    request: Request,
    background: BackgroundTasks,
    admin: Identity = Depends(require_admin),
    db: Session = Depends(get_session),
) -> dict[str, str]:
    user = _org_user(db, admin, user_id)
    if user.status != "active" or not user.password_hash:
        raise HTTPException(
            409,
            detail={
                "message": "Only active accounts can reset their password.",
                "hint": "For someone who hasn't joined yet, send the invite again.",
            },
        )
    raw = links.issue(db, user, "reset")
    audit(db, "password.reset_link", user_id=admin.user_id, target=user.id)
    db.commit()
    url = mail.link(request, "reset", raw)
    background.add_task(mail.send_link, user.email, "reset", url)
    return {"reset_link": url}


def _org_out(org: Organisation) -> dict[str, Any]:
    return {"name": org.name, "signup_open": org.signup_open}


@router.get("/org")
def get_org(admin: Identity = Depends(require_admin), db: Session = Depends(get_session)) -> dict[str, Any]:
    org = db.get(Organisation, admin.org_id)
    assert org is not None
    return _org_out(org)


@router.patch("/org")
def update_org(
    body: OrgUpdate, admin: Identity = Depends(require_admin), db: Session = Depends(get_session)
) -> dict[str, Any]:
    org = db.get(Organisation, admin.org_id)
    assert org is not None
    changes: dict[str, Any] = {}
    if body.name is not None and body.name.strip() != org.name:
        org.name = changes["name"] = body.name.strip()
    if body.signup_open is not None and body.signup_open != org.signup_open:
        org.signup_open = changes["signup_open"] = body.signup_open
    if changes:
        audit(db, "org.update", user_id=admin.user_id, target=org.id, **changes)
    db.commit()
    return _org_out(org)
