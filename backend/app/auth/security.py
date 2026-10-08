"""Password hashing, random tokens and the session-bound CSRF value."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

# argon2-cffi defaults are Argon2id (RFC 9106 "low memory" profile).
_hasher = PasswordHasher()
# Verified against for unknown emails, so a miss costs about as much as a hit.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))

MIN_PASSWORD_LEN = 10
MAX_PASSWORD_LEN = 1024  # Argon2 handles long input, but don't hash megabytes
API_TOKEN_PREFIX = "lo_"  # noqa: S105 - a prefix, not a secret


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    """Constant-ish time: with no stored hash, a dummy hash is checked instead."""
    try:
        return _hasher.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return False


def password_problem(password: str, email: str) -> str | None:
    """Plain-language reason the password can't be used, or None."""
    if len(password) < MIN_PASSWORD_LEN:
        return f"Use at least {MIN_PASSWORD_LEN} characters for the password."
    if len(password) > MAX_PASSWORD_LEN:
        return f"Use at most {MAX_PASSWORD_LEN} characters for the password."
    if password.strip().lower() == email.strip().lower():
        return "The password can't be the same as the email address."
    return None


def new_token(prefix: str = "") -> str:
    """32 random bytes, URL-safe."""
    return prefix + secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """What the database stores instead of the token (SHA-256 hex)."""
    return hashlib.sha256(token.encode()).hexdigest()


def csrf_for(session_token: str) -> str:
    """CSRF value bound to the session: only someone holding the (HttpOnly)
    session cookie can compute it, so a planted ``liveops_csrf`` cookie fails."""
    return hmac.new(session_token.encode(), b"liveops-csrf-v1", hashlib.sha256).hexdigest()


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def normalise_email(email: str) -> str:
    return email.strip().lower()


def email_problem(email: str) -> str | None:
    e = normalise_email(email)
    local, _, domain = e.partition("@")
    if not local or not domain or "." not in domain or len(e) > 254 or any(c.isspace() for c in e) or "@" in domain:
        return "Enter a valid email address, like name@example.org."
    return None
