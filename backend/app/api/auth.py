"""Sign-in, sign-up, setup, links and My account (ADR 0008, ``/api/auth``)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.auth import limits, links, mail
from app.auth.core import (
    SCOPE_SESSION_TOKEN,
    Identity,
    audit,
    aware,
    clear_auth_cookies,
    client_ip,
    create_session,
    end_sessions,
    iso,
    me_out,
    new_api_token,
    set_auth_cookies,
)
from app.auth.guard import current_user
from app.auth.models import ApiToken, AuthSession, Organisation, User, now
from app.auth.security import (
    email_problem,
    hash_password,
    needs_rehash,
    normalise_email,
    password_problem,
    token_hash,
    verify_password,
)
from app.config import get_settings
from app.db import get_session

router = APIRouter(prefix="/api/auth", tags=["auth"])

BAD_CREDENTIALS = "Email or password is incorrect."
LOCKED = "Too many failed attempts. Try again in 15 minutes, or reset your password."


# ---- bodies -----------------------------------------------------------------


class SetupIn(BaseModel):
    org_name: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    email: str = Field(max_length=254)
    password: str = Field(max_length=1024)


class SignupIn(SetupIn):
    accept_terms: bool = False


class SigninIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=1024)
    remember: bool = False


class TokenIn(BaseModel):
    token: str = Field(max_length=200)


class ForgotIn(BaseModel):
    email: str = Field(max_length=254)


class ResetIn(BaseModel):
    token: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class InviteAcceptIn(BaseModel):
    token: str = Field(max_length=200)
    name: str = Field(min_length=1, max_length=200)
    password: str = Field(max_length=1024)


class MeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=1024)
    new_password: str = Field(max_length=1024)


class ApiTokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


# ---- helpers ----------------------------------------------------------------


def unprocessable(message: str) -> HTTPException:
    return HTTPException(422, detail={"message": message})


def check_new_account(email: str, password: str) -> str:
    """Normalised email, or 422 with a plain-language reason."""
    if problem := email_problem(email):
        raise unprocessable(problem)
    email = normalise_email(email)
    if problem := password_problem(password, email):
        raise unprocessable(problem)
    return email


def limit_open(request: Request, bucket: limits.SlidingWindow = limits.open_by_ip) -> None:
    ip = client_ip(request)
    if not bucket.hit(ip):
        raise HTTPException(
            429,
            detail={"message": "Too many attempts from this network. Wait a few minutes and try again."},
            headers={"Retry-After": str(bucket.retry_after(ip))},
        )


def load_me(db: Session, user_id: str) -> tuple[User, Organisation]:
    user = db.get(User, user_id)
    org = db.get(Organisation, user.org_id) if user is not None else None
    if user is None or org is None:
        raise HTTPException(401, detail={"message": "Sign in to continue."})
    return user, org


def users_exist(db: Session) -> bool:
    return db.scalar(select(func.count()).select_from(User)) != 0


def signup_allowed(db: Session) -> bool:
    if get_settings().public_signup:
        return True
    return db.scalar(select(func.count()).select_from(Organisation).where(Organisation.signup_open.is_(True))) != 0


def _lock_setup(db: Session) -> None:
    """Serialise setup/sign-up so two first visits can't both create an admin."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(800800)"))


def _signed_in(response: Response, request: Request, db: Session, user: User, *, remember: bool) -> dict[str, Any]:
    raw = create_session(db, user, remember=remember, conn=request)
    db.commit()
    set_auth_cookies(response, request, raw, remember=remember)
    org = db.get(Organisation, user.org_id)
    assert org is not None
    return me_out(user, org)


# ---- open routes --------------------------------------------------------------


@router.get("/state")
def auth_state(db: Session = Depends(get_session)) -> dict[str, Any]:
    setup_required = not users_exist(db)
    return {
        "setup_required": setup_required,
        "signup_open": (not setup_required) and signup_allowed(db),
        "sso": [],
    }


@router.post("/setup")
def setup(body: SetupIn, request: Request, response: Response, db: Session = Depends(get_session)) -> dict[str, Any]:
    limit_open(request)
    email = check_new_account(body.email, body.password)
    _lock_setup(db)
    if users_exist(db):
        raise HTTPException(
            409, detail={"message": "Live Ops is already set up.", "hint": "Sign in with your account instead."}
        )
    t = now()
    org = Organisation(name=body.org_name.strip(), signup_open=False, created_at=t)
    db.add(org)
    db.flush()
    user = User(
        org_id=org.id,
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        role="admin",
        status="active",
        email_verified_at=t,  # the person installing Live Ops
        failed_attempts=0,
        created_at=t,
    )
    db.add(user)
    db.flush()
    audit(db, "setup", user_id=user.id, target=org.id, org_name=org.name, email=email)
    return _signed_in(response, request, db, user, remember=False)


@router.post("/signin")
def signin(body: SigninIn, request: Request, response: Response, db: Session = Depends(get_session)) -> dict[str, Any]:
    limit_open(request, limits.signin_by_ip)
    email = normalise_email(body.email)
    ip = client_ip(request)
    user = db.scalars(select(User).where(User.email == email)).first()
    if user is None:
        # Same work and same answers as for a real account (ADR 0008).
        if limits.ghosts.locked(email):
            raise HTTPException(423, detail={"message": LOCKED})
        verify_password(None, body.password)
        audit(db, "signin.fail", user_id=None, target=email, ip=ip, reason="no_account")
        db.commit()
        if limits.ghosts.fail(email):
            raise HTTPException(423, detail={"message": LOCKED})
        raise HTTPException(401, detail={"message": BAD_CREDENTIALS})
    t = now()
    if user.locked_until is not None and aware(user.locked_until) > t:
        raise HTTPException(423, detail={"message": LOCKED})
    if not verify_password(user.password_hash, body.password):
        user.failed_attempts = (user.failed_attempts or 0) + 1
        locked = user.failed_attempts >= limits.MAX_FAILED
        if locked:
            user.failed_attempts = 0
            user.locked_until = t + timedelta(seconds=limits.LOCK_S)
        audit(db, "signin.fail", user_id=user.id, target=email, ip=ip, reason="locked" if locked else "password")
        db.commit()
        raise HTTPException(423 if locked else 401, detail={"message": LOCKED if locked else BAD_CREDENTIALS})
    if user.status != "active":
        audit(db, "signin.fail", user_id=user.id, target=email, ip=ip, reason=f"status_{user.status}")
        db.commit()
        raise HTTPException(
            401,
            detail={
                "message": "This account is turned off.",
                "hint": "Ask an admin of your organisation to turn it back on.",
            },
        )
    user.failed_attempts = 0
    user.locked_until = None
    assert user.password_hash is not None
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    audit(db, "signin.ok", user_id=user.id, target=email, ip=ip, remember=body.remember)
    return _signed_in(response, request, db, user, remember=body.remember)


@router.post("/signup")
def signup(
    body: SignupIn,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    limit_open(request)
    _lock_setup(db)
    if not users_exist(db):
        raise HTTPException(
            409, detail={"message": "Live Ops isn't set up yet.", "hint": "Create the admin account first."}
        )
    if not signup_allowed(db):
        raise HTTPException(
            403,
            detail={"message": "Sign-up is closed.", "hint": "Ask an admin of your organisation to invite you."},
        )
    if not body.accept_terms:
        raise unprocessable("Accept the terms to create an account.")
    email = check_new_account(body.email, body.password)
    if db.scalars(select(User.id).where(User.email == email)).first() is not None:
        raise HTTPException(
            409,
            detail={
                "message": "An account with this email already exists.",
                "hint": "Sign in, or reset your password if you forgot it.",
            },
        )
    t = now()
    org = Organisation(name=body.org_name.strip(), signup_open=False, created_at=t)
    db.add(org)
    db.flush()
    user = User(
        org_id=org.id,
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        role="admin",
        status="active",
        failed_attempts=0,
        created_at=t,
    )
    db.add(user)
    db.flush()
    raw = links.issue(db, user, "verify")
    audit(db, "signup", user_id=user.id, target=org.id, org_name=org.name, email=email)
    out = _signed_in(response, request, db, user, remember=False)
    background.add_task(mail.send_link, email, "verify", mail.link(request, "verify", raw))
    return out


@router.post("/verify", status_code=204)
def verify_email(body: TokenIn, request: Request, db: Session = Depends(get_session)) -> Response:
    limit_open(request)
    user = links.consume(db, body.token, "verify")
    if user.email_verified_at is None:
        user.email_verified_at = now()
    audit(db, "email.verify", user_id=user.id, target=user.email)
    db.commit()
    return Response(status_code=204)


@router.post("/forgot", status_code=204)
def forgot(
    body: ForgotIn, request: Request, background: BackgroundTasks, db: Session = Depends(get_session)
) -> Response:
    limit_open(request)
    email = normalise_email(body.email)
    user = db.scalars(select(User).where(User.email == email)).first()
    if user is not None and user.status == "active" and user.password_hash:
        raw = links.issue(db, user, "reset")
        audit(db, "password.reset_request", user_id=None, target=email, ip=client_ip(request))
        db.commit()
        background.add_task(mail.send_link, email, "reset", mail.link(request, "reset", raw))
    # Always the same answer: whether the email has an account stays private.
    return Response(status_code=204)


@router.post("/reset", status_code=204)
def reset_password(body: ResetIn, request: Request, db: Session = Depends(get_session)) -> Response:
    limit_open(request)
    user = links.consume(db, body.token, "reset")
    if user.status != "active":
        raise links.invalid_link()
    if problem := password_problem(body.password, user.email):
        db.rollback()  # the link stays usable for a better password
        raise unprocessable(problem)
    user.password_hash = hash_password(body.password)
    user.failed_attempts = 0
    user.locked_until = None
    if user.email_verified_at is None:
        user.email_verified_at = now()  # the link reached their inbox
    links.revoke(db, user.id, "reset")
    n = end_sessions(db, user.id)
    audit(db, "password.reset", user_id=user.id, target=user.email, sessions_ended=n)
    db.commit()
    return Response(status_code=204)


@router.post("/invite/accept")
def accept_invite(
    body: InviteAcceptIn, request: Request, response: Response, db: Session = Depends(get_session)
) -> dict[str, Any]:
    limit_open(request)
    user = links.consume(db, body.token, "invite")
    if user.status != "invited":
        raise links.invalid_link()
    if problem := password_problem(body.password, user.email):
        db.rollback()
        raise unprocessable(problem)
    user.name = body.name.strip()
    user.password_hash = hash_password(body.password)
    user.status = "active"
    user.email_verified_at = now()
    audit(db, "invite.accept", user_id=user.id, target=user.email)
    return _signed_in(response, request, db, user, remember=False)


# ---- signed-in routes ---------------------------------------------------------


@router.post("/signout", status_code=204)
def signout(request: Request, ident: Identity = Depends(current_user), db: Session = Depends(get_session)) -> Response:
    if ident.session_id is not None:
        s = db.get(AuthSession, ident.session_id)
        if s is not None:
            db.delete(s)
    audit(db, "signout", user_id=ident.user_id)
    db.commit()
    resp = Response(status_code=204)
    clear_auth_cookies(resp, request)
    return resp


@router.get("/me")
def me(
    request: Request, response: Response, ident: Identity = Depends(current_user), db: Session = Depends(get_session)
) -> dict[str, Any]:
    user, org = load_me(db, ident.user_id)
    raw = request.scope.get(SCOPE_SESSION_TOKEN)
    if ident.session_id is not None and raw:
        # Refresh both cookies (keeps "remember me" sliding, restores a lost CSRF cookie).
        s = db.get(AuthSession, ident.session_id)
        if s is not None:
            set_auth_cookies(response, request, raw, remember=s.remember)
    return me_out(user, org)


@router.patch("/me")
def update_me(body: MeUpdate, ident: Identity = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    user, org = load_me(db, ident.user_id)
    if body.name is not None:
        user.name = body.name.strip()
        audit(db, "user.name", user_id=user.id, target=user.id)
    db.commit()
    return me_out(user, org)


@router.post("/me/password", status_code=204)
def change_password(
    body: PasswordChange, ident: Identity = Depends(current_user), db: Session = Depends(get_session)
) -> Response:
    user, _ = load_me(db, ident.user_id)
    # 400, not 401: a wrong current password must not look like being signed out.
    if not verify_password(user.password_hash, body.current_password):
        audit(db, "password.change_fail", user_id=user.id, target=user.id)
        db.commit()
        raise HTTPException(400, detail={"message": "Your current password is incorrect."})
    if problem := password_problem(body.new_password, user.email):
        raise unprocessable(problem)
    user.password_hash = hash_password(body.new_password)
    n = end_sessions(db, user.id, keep=ident.session_id)
    links.revoke(db, user.id, "reset")
    audit(db, "password.change", user_id=user.id, target=user.id, sessions_ended=n)
    db.commit()
    return Response(status_code=204)


@router.get("/me/sessions")
def my_sessions(ident: Identity = Depends(current_user), db: Session = Depends(get_session)) -> list[dict[str, Any]]:
    t = now()
    rows = db.scalars(
        select(AuthSession).where(AuthSession.user_id == ident.user_id).order_by(AuthSession.last_seen_at.desc())
    )
    return [
        {
            "id": s.id,
            "created_at": iso(s.created_at),
            "last_seen_at": iso(s.last_seen_at),
            "user_agent": s.user_agent,
            "ip": s.ip,
            "current": s.id == ident.session_id,
        }
        for s in rows
        if aware(s.expires_at) > t
    ]


@router.delete("/me/sessions/{session_id}", status_code=204)
def end_my_session(
    session_id: str, request: Request, ident: Identity = Depends(current_user), db: Session = Depends(get_session)
) -> Response:
    s = db.get(AuthSession, session_id)
    if s is None or s.user_id != ident.user_id:
        raise HTTPException(404, detail={"message": "No such session."})
    db.delete(s)
    audit(db, "session.end", user_id=ident.user_id, target=ident.user_id)
    db.commit()
    resp = Response(status_code=204)
    if session_id == ident.session_id:
        clear_auth_cookies(resp, request)
    return resp


@router.delete("/me/sessions", status_code=204)
def end_other_sessions(ident: Identity = Depends(current_user), db: Session = Depends(get_session)) -> Response:
    n = end_sessions(db, ident.user_id, keep=ident.session_id)
    audit(db, "session.end_others", user_id=ident.user_id, target=ident.user_id, sessions_ended=n)
    db.commit()
    return Response(status_code=204)


# ---- API tokens -----------------------------------------------------------------


def _token_out(t: ApiToken) -> dict[str, Any]:
    return {"id": t.id, "name": t.name, "created_at": iso(t.created_at), "last_used_at": iso(t.last_used_at)}


@router.get("/tokens")
def list_tokens(ident: Identity = Depends(current_user), db: Session = Depends(get_session)) -> list[dict[str, Any]]:
    rows = db.scalars(select(ApiToken).where(ApiToken.user_id == ident.user_id).order_by(ApiToken.created_at))
    return [_token_out(t) for t in rows]


@router.post("/tokens", status_code=201)
def create_token(body: ApiTokenIn, ident: Identity = Depends(current_user), db: Session = Depends(get_session)) -> dict:
    raw = new_api_token()
    tok = ApiToken(user_id=ident.user_id, name=body.name.strip(), token_hash=token_hash(raw), created_at=now())
    db.add(tok)
    db.flush()
    audit(db, "token.create", user_id=ident.user_id, target=tok.id, name=tok.name)
    db.commit()
    return {**_token_out(tok), "token": raw}  # shown once; only its hash is kept


@router.delete("/tokens/{token_id}", status_code=204)
def delete_token(
    token_id: str, ident: Identity = Depends(current_user), db: Session = Depends(get_session)
) -> Response:
    tok = db.get(ApiToken, token_id)
    if tok is None or tok.user_id != ident.user_id:
        raise HTTPException(404, detail={"message": "No such API token."})
    db.delete(tok)
    audit(db, "token.delete", user_id=ident.user_id, target=token_id)
    db.commit()
    return Response(status_code=204)
