"""Postgres TLS / sign-in hardening (LIVEOPS-29 Postgres part, LIVEOPS-60).

A fake Postgres server speaks just enough protocol: it accepts TLS with a
certificate we generate, then asks for a *cleartext* password, like a server
impersonator would, and records every byte the client sends back.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import ipaddress
import os
import socket
import ssl
import struct
import threading
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app.connectors.pg_tls import LEGACY_AUTH_HINT, default_ca_file, tls_params
from app.connectors.postgres import PostgresConnector
from app.connectors.postgres_cdc import PostgresCdcConnector

PASSWORD = "Pg-s3cret-do-not-leak"
SSL_REQUEST, GSS_REQUEST = 80877103, 80877104


# -- certificates ------------------------------------------------------------


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _cert(subject: str, issuer_key: Any, issuer: str, key: Any, *, ca: bool) -> x509.Certificate:
    now = dt.datetime.now(dt.UTC)
    b = (
        x509.CertificateBuilder()
        .subject_name(_name(subject))
        .issuer_name(_name(issuer))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
    )
    if not ca:
        b = b.add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
    return b.sign(issuer_key, hashes.SHA256())


@pytest.fixture(scope="module")
def pki(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("pki")
    ca_key, srv_key, self_key = (ec.generate_private_key(ec.SECP256R1()) for _ in range(3))
    ca = _cert("Live Ops test CA", ca_key, "Live Ops test CA", ca_key, ca=True)
    srv = _cert("localhost", ca_key, "Live Ops test CA", srv_key, ca=False)
    selfsigned = _cert("localhost", self_key, "localhost", self_key, ca=False)

    def write(name: str, data: bytes) -> Path:
        p = d / name
        p.write_bytes(data)
        return p

    def key_pem(k: Any) -> bytes:
        enc, fmt = serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8
        return k.private_bytes(enc, fmt, serialization.NoEncryption())

    pem = serialization.Encoding.PEM
    return {
        "ca": write("ca.pem", ca.public_bytes(pem)),
        "srv_cert": write("srv.pem", srv.public_bytes(pem)),
        "srv_key": write("srv.key", key_pem(srv_key)),
        "self_cert": write("self.pem", selfsigned.public_bytes(pem)),
        "self_key": write("self.key", key_pem(self_key)),
    }


# -- fake server --------------------------------------------------------------


class FakePg:
    def __init__(self, cert: Path, key: Path) -> None:
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(cert, key)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.after_auth_request: list[bytes] = []  # what the client sent after we asked for a password
        self.tls_ok = 0
        threading.Thread(target=self._serve, daemon=True).start()

    @staticmethod
    def _read(conn: Any, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                raise ConnectionError
            buf += chunk
        return buf

    def _serve(self) -> None:
        while True:
            try:
                raw, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(raw,), daemon=True).start()

    def _one(self, raw: socket.socket) -> None:
        conn: Any = raw
        try:
            while True:
                length, code = struct.unpack("!ii", self._read(conn, 8))
                if code == GSS_REQUEST:
                    conn.sendall(b"N")
                    continue
                if code == SSL_REQUEST:
                    conn.sendall(b"S")
                    conn = self.ctx.wrap_socket(raw, server_side=True)
                    self.tls_ok += 1
                    continue
                self._read(conn, length - 8)  # startup message
                break
            conn.sendall(b"R" + struct.pack("!ii", 8, 3))  # AuthenticationCleartextPassword
            conn.settimeout(2)
            data = b""
            try:
                while chunk := conn.recv(4096):
                    data += chunk
            except OSError:
                pass
            self.after_auth_request.append(data)
        except (OSError, ConnectionError, ssl.SSLError):
            pass
        finally:
            raw.close()

    def close(self) -> None:
        self.sock.close()


def _settings(port: int, encryption: str, **extra: Any) -> dict[str, Any]:
    return {
        "host": "localhost",
        "port": port,
        "database": "db",
        "user": "reader",
        "encryption": encryption,
        "publication": "liveops",
        **extra,
    }


def _psycopg2_replication(settings: dict[str, Any]) -> str:
    """Open the psycopg2 replication connection postgres_cdc uses; return the error text."""
    c = PostgresCdcConnector(settings, {"password": PASSWORD})
    try:
        psycopg2.connect(**c._conninfo(), connection_factory=psycopg2.extras.LogicalReplicationConnection).close()
    except psycopg2.Error as e:
        return str(e)
    return ""


async def _psycopg3(settings: dict[str, Any]) -> tuple[bool, str, str]:
    c = PostgresConnector(settings, {"password": PASSWORD})
    try:
        report = await c.test()
    finally:
        await c.close()
    step = report.steps[0]
    assert PASSWORD not in report.model_dump_json()
    return step.ok, step.detail, step.hint


def _sent_password(server: FakePg) -> bool:
    return any(PASSWORD.encode() in d for d in server.after_auth_request)


# -- LIVEOPS-29: no password to an impersonator under "required" ------------------


@pytest.mark.parametrize("encryption", ["required", "verify"])
async def test_impersonator_gets_no_password_psycopg(pki: dict[str, Path], encryption: str) -> None:
    srv = FakePg(pki["self_cert"], pki["self_key"])
    try:
        ok, detail, hint = await _psycopg3(_settings(srv.port, encryption, ssl_ca=str(pki["self_cert"])))
    finally:
        srv.close()
    assert not ok
    assert not _sent_password(srv), "the password must never reach a server asking for cleartext"
    assert "older password method" in hint and hint == LEGACY_AUTH_HINT, (detail, hint)


@pytest.mark.parametrize("encryption", ["required", "verify"])
def test_impersonator_gets_no_password_psycopg2_replication(pki: dict[str, Path], encryption: str) -> None:
    srv = FakePg(pki["self_cert"], pki["self_key"])
    try:
        err = _psycopg2_replication(_settings(srv.port, encryption, ssl_ca=str(pki["self_cert"])))
    finally:
        srv.close()
    assert "authentication method requirement" in err, err
    assert not _sent_password(srv)


async def test_legacy_option_is_explicit_and_does_send_the_password(pki: dict[str, Path]) -> None:
    """The warned opt-in really allows older methods (that's what it's for)."""
    srv = FakePg(pki["self_cert"], pki["self_key"])
    try:
        await _psycopg3(_settings(srv.port, "required_legacy_auth"))
        await asyncio.sleep(0.3)
    finally:
        srv.close()
    assert srv.tls_ok >= 1 and _sent_password(srv)


# -- LIVEOPS-60: verify works without SSL_CERT_FILE, with an explicit CA file --------------


def test_verify_uses_an_explicit_ca_file_not_system() -> None:
    p = tls_params({"encryption": "verify"})
    assert p["sslmode"] == "verify-full" and p["sslrootcert"] != "system"
    assert os.path.isfile(p["sslrootcert"]) and p["sslrootcert"] == default_ca_file()
    assert tls_params({"encryption": "verify", "ssl_ca": "/x/ca.pem"})["sslrootcert"] == "/x/ca.pem"
    for enc in ("required", "verify"):
        p = tls_params({"encryption": enc})
        assert p["require_auth"] == "scram-sha-256" and p["channel_binding"] == "require"
    assert tls_params({"encryption": "required_legacy_auth"}) == {"sslmode": "require"}
    assert tls_params({"encryption": "off"}) == {"sslmode": "disable"}
    for cls in (PostgresConnector, PostgresCdcConnector):
        info = cls(_settings(1, "verify"), {"password": "x"})._conninfo()
        assert info["sslrootcert"] == default_ca_file() and info["require_auth"] == "scram-sha-256"


@pytest.mark.parametrize("driver", ["psycopg", "psycopg2"])
async def test_verify_trusts_a_configured_ca_with_ssl_cert_file_unset(
    pki: dict[str, Path], driver: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    srv = FakePg(pki["srv_cert"], pki["srv_key"])
    try:
        trusted = _settings(srv.port, "verify", ssl_ca=str(pki["ca"]))
        untrusted = _settings(srv.port, "verify")  # default bundle doesn't know our test CA
        if driver == "psycopg":
            _, detail_ok, hint_ok = await _psycopg3(trusted)
            _, detail_bad, hint_bad = await _psycopg3(untrusted)
        else:
            detail_ok, hint_ok = _psycopg2_replication(trusted), ""
            detail_bad, hint_bad = _psycopg2_replication(untrusted), ""
    finally:
        srv.close()
    # Trusted CA: the TLS handshake and host name check pass; the only refusal left is the
    # fake server's cleartext password request.
    assert "certificate verify failed" not in detail_ok and "authentication method requirement" in detail_ok
    # psycopg2's bundled libpq reports the same refused handshake as "SSL error: no SSL error reported"
    assert "certificate verify failed" in detail_bad or "SSL error" in detail_bad, detail_bad
    if driver == "psycopg":
        assert hint_ok == LEGACY_AUTH_HINT and "CA certificate file" in hint_bad
    assert srv.tls_ok >= 1 and not _sent_password(srv)


# -- Encryption step wording on the real server (poll connector) --------------------------

PG_DSN = os.environ.get("LIVEOPS_TEST_PG_DSN")


@pytest.mark.skipif(not PG_DSN, reason="LIVEOPS_TEST_PG_DSN not set")
async def test_poll_connector_says_certificate_not_verified_and_signs_in_with_scram() -> None:
    from tests.conftest import pg_params

    p = pg_params()
    c = PostgresConnector(
        {
            "host": p.get("host", "localhost"),
            "port": int(p.get("port", 5432)),
            "database": p.get("dbname", "postgres"),
            "user": p["user"],
            "encryption": "required",
        },
        {"password": p.get("password", "")},
    )
    try:
        report = await c.test()
    finally:
        await c.close()
    enc = next(s for s in report.steps if s.name == "Encryption")
    assert enc.ok and "NOT verified" in enc.detail and "SCRAM" in enc.detail
