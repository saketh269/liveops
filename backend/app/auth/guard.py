"""Authentication for every request (ASGI middleware) and role checks (dependencies).

The middleware runs before routing, body parsing and uploads, so nothing but
the open routes is reachable without a signed-in user. It:

- resolves the caller from ``Authorization: Bearer lo_…`` or the
  ``liveops_session`` cookie,
- answers 401 ``{"detail": {"message": "Sign in to continue."}}`` when there is
  none (``LIVEOPS_AUTH_REQUIRED=true``), and refuses the WebSocket handshake,
- checks CSRF (double submit, bound to the session) on unsafe methods that
  arrive with the session cookie; Bearer requests skip it.

Roles are checked afterwards by :func:`require_role` dependencies (403).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

import anyio
from fastapi import HTTPException
from starlette.requests import HTTPConnection, cookie_parser
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth.core import (
    CSRF_COOKIE,
    CSRF_HEADER,
    SCOPE_IDENTITY,
    SCOPE_SESSION_TOKEN,
    SESSION_COOKIE,
    Identity,
    bearer_token,
    resolve_api_token,
    resolve_session,
)
from app.auth.security import csrf_for, same
from app.config import get_settings
from app.db import new_session

UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
SIGN_IN_MESSAGE = "Sign in to continue."

# Open routes (ADR 0008): (method, exact path or compiled pattern).
OPEN_AUTH = ("state", "setup", "signin", "signup", "verify", "forgot", "reset", "invite/accept")
_OPEN_EXACT = {("GET", "/api/auth/state"), ("GET", "/api/health")} | {
    ("POST", f"/api/auth/{p}") for p in OPEN_AUTH if p != "state"
}
_OPEN_PATTERNS = [("POST", re.compile(r"^/api/webhooks/[^/]+$"))]


def is_open(method: str, path: str) -> bool:
    if (method, path) in _OPEN_EXACT:
        return True
    return any(m == method and p.match(path) for m, p in _OPEN_PATTERNS)


# ---- roles ----------------------------------------------------------------

ALL_ROLES = ("admin", "manager", "viewer", "wallboard")
EDITORS = ("admin", "manager")
READERS = ("admin", "manager", "viewer")
ADMIN_PREFIXES = ("/api/users", "/api/org")
# What a wallboard (a screen on the wall) may read: the live map and its stream.
_WALLBOARD_GET = [
    re.compile(p)
    for p in (
        r"^/api/sites$",
        r"^/api/sites/[^/]+$",
        r"^/api/sites/[^/]+/assets$",
        r"^/api/sites/[^/]+/events$",
        r"^/api/sites/[^/]+/plans/[^/]+$",
        r"^/api/health/mappings$",
    )
]


def roles_for(method: str, path: str) -> tuple[str, ...]:
    """Default policy for routes that don't declare their own roles."""
    if path.startswith("/api/auth/"):
        return ALL_ROLES  # signed-in self-service (My account, sign out, tokens)
    if any(path == p or path.startswith(p + "/") for p in ADMIN_PREFIXES):
        return ("admin",)
    if method == "WS":
        return ALL_ROLES
    if method in ("GET", "HEAD"):
        return ALL_ROLES if any(p.match(path) for p in _WALLBOARD_GET) else READERS
    return EDITORS


def forbidden() -> HTTPException:
    return HTTPException(
        403,
        detail={
            "message": "Your role doesn't allow this.",
            "hint": "Ask an admin of your organisation if you need access.",
        },
    )


def unauthorized() -> HTTPException:
    return HTTPException(401, detail={"message": SIGN_IN_MESSAGE})


def get_identity(conn: HTTPConnection) -> Identity | None:
    return conn.scope.get(SCOPE_IDENTITY)


def current_user(conn: HTTPConnection) -> Identity:
    """The signed-in caller; 401 if there is none (also when auth is switched off)."""
    ident = get_identity(conn)
    if ident is None:
        raise unauthorized()
    return ident


def require_role(*roles: str) -> Callable[[HTTPConnection], Identity]:
    """Dependency: the caller must be signed in with one of ``roles`` (else 401/403)."""

    def dependency(conn: HTTPConnection) -> Identity:
        ident = current_user(conn)
        if ident.role not in roles:
            raise forbidden()
        return ident

    dependency.__name__ = f"require_role_{'_'.join(roles)}"
    return dependency


def default_access(conn: HTTPConnection) -> None:
    """App-wide dependency: applies :func:`roles_for` through :func:`require_role`.
    No-op on open routes, and when auth is off and nobody is signed in."""
    method = conn.scope.get("method", "WS")
    path = conn.url.path
    if is_open(method, path):
        return
    if get_identity(conn) is None and not get_settings().auth_required:
        return
    require_role(*roles_for(method, path))(conn)


# ---- middleware -------------------------------------------------------------


def _resolve(conn: HTTPConnection) -> tuple[Identity | None, str | None]:
    """(identity, raw session token). A Bearer header wins over the cookie: a
    wrong token is not rescued by a cookie. Runs in a worker thread (DB)."""
    bearer = bearer_token(conn)
    with new_session() as db:
        if bearer is not None:
            return resolve_api_token(db, bearer), None
        raw = conn.cookies.get(SESSION_COOKIE)
        if raw:
            return resolve_session(db, raw), raw
    return None, None


class AuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        is_ws = scope["type"] == "websocket"
        method = "WS" if is_ws else scope["method"]
        path = scope["path"]
        scope[SCOPE_IDENTITY] = None
        if is_open(method, path):
            await self.app(scope, receive, send)
            return
        conn = HTTPConnection(scope)
        has_credentials = bearer_token(conn) is not None or SESSION_COOKIE in _cookies(scope)
        ident: Identity | None = None
        raw: str | None = None
        if has_credentials:
            ident, raw = await anyio.to_thread.run_sync(_resolve, conn)
        if is_ws and ident is not None and ident.via != "session":
            ident = None  # the live stream is for signed-in browsers (session cookie only)
        if ident is None and get_settings().auth_required:
            await _refuse(scope, receive, send, is_ws, 401, SIGN_IN_MESSAGE)
            return
        if ident is not None and ident.via == "session" and method in UNSAFE:
            assert raw is not None
            header = conn.headers.get(CSRF_HEADER, "")
            cookie = conn.cookies.get(CSRF_COOKIE, "")
            expected = csrf_for(raw)
            if not header or not same(header, cookie) or not same(header, expected):
                await _refuse(
                    scope,
                    receive,
                    send,
                    is_ws,
                    403,
                    "Your page is out of date. Refresh it and try again.",
                    "The request was missing its security token (CSRF).",
                )
                return
        scope[SCOPE_IDENTITY] = ident
        scope[SCOPE_SESSION_TOKEN] = raw if ident is not None else None
        await self.app(scope, receive, send)


def _cookies(scope: Scope) -> dict[str, str]:
    for k, v in scope.get("headers") or []:
        if k == b"cookie":
            return cookie_parser(v.decode("latin-1"))
    return {}


async def _refuse(
    scope: Scope, receive: Receive, send: Send, is_ws: bool, status: int, message: str, hint: str | None = None
) -> None:
    if is_ws:
        # Close before accepting: the client sees the handshake refused (HTTP 403).
        msg = await receive()
        if msg["type"] == "websocket.connect":
            await send({"type": "websocket.close", "code": 1008, "reason": message})
        return
    detail: dict[str, Any] = {"message": message}
    if hint:
        detail["hint"] = hint
    body = json.dumps({"detail": detail}).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    if status == 401:
        headers.append((b"www-authenticate", b'Bearer realm="liveops"'))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
