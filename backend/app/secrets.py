"""Encrypts source secrets (passwords, tokens) at rest. Secrets never leave
the backend: the API returns only which secret fields are set."""

from __future__ import annotations

import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class SecretsError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = get_settings().secret_key
    if not key:
        raise SecretsError(
            "LIVEOPS_SECRET_KEY is not set. Generate one with: "
            'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
        )
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as e:
        raise SecretsError(
            "LIVEOPS_SECRET_KEY is not a valid key (it must be 32 random bytes, URL-safe base64, 44 characters). "
            "See README → Run it for how to generate one."
        ) from e  # LIVEOPS-81


def encrypt(secrets: dict[str, Any]) -> str:
    return _fernet().encrypt(json.dumps(secrets).encode()).decode()


def decrypt(token: str | None) -> dict[str, Any]:
    if not token:
        return {}
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except InvalidToken as e:
        raise SecretsError("Stored secrets can't be decrypted; was LIVEOPS_SECRET_KEY changed?") from e


def mask(secrets: dict[str, Any]) -> dict[str, bool]:
    """What the API shows: which secret fields have a value."""
    return {k: bool(v) for k, v in secrets.items()}
