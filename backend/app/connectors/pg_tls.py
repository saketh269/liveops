"""TLS and sign-in hardening shared by the Postgres connectors (postgres, postgres_cdc).

Encryption setting -> libpq parameters (the same for psycopg and psycopg2):

- ``required`` (default): encrypted, server certificate not checked. Sign-in must
  be SCRAM with channel binding (``require_auth=scram-sha-256``,
  ``channel_binding=require``), so a server impersonator with any certificate
  can't get the password: a cleartext/md5 request is refused before the password
  is sent, and channel binding ties SCRAM to the real TLS session (LIVEOPS-29).
- ``verify``: as ``required`` plus ``verify-full`` against an explicit CA file
  (``ssl_ca`` setting, else the system bundle, else certifi). Not ``system``:
  the binary wheels' bundled OpenSSL looks for CAs in a build path that doesn't
  exist (LIVEOPS-60).
- ``required_legacy_auth``: encrypted, certificate not checked, and older password
  methods (md5, cleartext) allowed. Explicit and warned: only for servers that
  can't use SCRAM yet.
- ``off``: no TLS (local testing only).
"""

from __future__ import annotations

import os
from typing import Any

ENCRYPTION_ENUM = ["required", "verify", "required_legacy_auth", "off"]
ENCRYPTION_DESCRIPTION = (
    "Required: encrypted, and the password is only sent with SCRAM (safe even if someone impersonates the "
    "server). Verify: also checks the server's certificate against trusted authorities (use for servers outside "
    "your network). Required (allow older password methods): for servers still on md5 — weaker, a server "
    "impersonator can learn the password. Off: local testing only."
)
SSL_CA_SETTING = {
    "type": "string",
    "title": "CA certificate file (for 'verify')",
    "description": "Path on the Live Ops server, e.g. your company or cloud provider CA bundle. "
    "Empty uses the system trust store.",
}
SYSTEM_CA_FILES = ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem")
LEGACY_AUTH_HINT = (
    "The server uses an older password method (md5 or plain password). Switch the user to SCRAM "
    "(password_encryption = 'scram-sha-256', then reset the password), or choose Encryption: "
    "Required (allow older password methods) — weaker: someone impersonating the server could learn the password."
)


def default_ca_file() -> str:
    """The CA bundle for ``verify`` when no ``ssl_ca`` is set."""
    for path in SYSTEM_CA_FILES:
        if os.path.isfile(path):
            return path
    import certifi

    return str(certifi.where())


def tls_params(settings: dict[str, Any]) -> dict[str, Any]:
    enc = settings.get("encryption", "required")
    if enc == "off":
        return {"sslmode": "disable"}
    if enc == "required_legacy_auth":
        return {"sslmode": "require"}
    params: dict[str, Any] = {
        "sslmode": "require",
        "require_auth": "scram-sha-256",
        "channel_binding": "require",
    }
    if enc == "verify":
        params["sslmode"] = "verify-full"
        params["sslrootcert"] = settings.get("ssl_ca") or default_ca_file()
    return params


def encryption_detail(encrypted: bool, encryption: str) -> str:
    if not encrypted:
        return "not encrypted"
    if encryption == "verify":
        return "encrypted (TLS), server certificate verified, SCRAM sign-in"
    if encryption == "required_legacy_auth":
        return (
            "encrypted (TLS), server certificate NOT verified, older password methods allowed "
            "(weaker: choose Required once the server uses SCRAM)"
        )
    return (
        "encrypted (TLS), server certificate NOT verified (use Verify for servers outside your network), SCRAM sign-in"
    )


def tls_hint(message: str) -> str:
    """Plain-English fix for TLS / sign-in-method failures, or ''."""
    m = message.lower()
    if "authentication method requirement" in m or "channel binding" in m:
        return LEGACY_AUTH_HINT
    if "certificate verify failed" in m or "does not match host name" in m or "root certificate file" in m:
        return (
            "The server's certificate isn't signed by an authority Live Ops trusts, or doesn't match the host name. "
            "Set 'CA certificate file' to your company or cloud provider CA bundle, check the host name, "
            "or use Encryption: Required."
        )
    return ""
