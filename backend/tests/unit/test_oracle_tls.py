"""Oracle TCPS certificate handling with the real oracledb driver against a
local TLS listener (a plain TLS socket, not an Oracle server). This proves what
'required' and 'verify' check at the TLS layer (LIVEOPS-29); the Oracle
protocol after the handshake is not exercised here.
"""

from __future__ import annotations

import datetime as dt
import socket
import ssl
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

pytest.importorskip("oracledb")

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

from app.connectors.oracle import OracleConnector  # noqa: E402


def _self_signed(tmp: Path) -> tuple[Path, Path]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = dt.datetime.now(dt.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)  # no IP SAN
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp / "cert.pem", tmp / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    return cert_path, key_path


class TlsListener:
    def __init__(self, cert: Path, key: Path) -> None:
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(cert, key)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.sock.settimeout(10)
        self.port = self.sock.getsockname()[1]
        self.handshakes = 0
        self._stop = False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while not self._stop:
            try:
                raw, _ = self.sock.accept()
            except OSError:
                return
            try:
                tls = self.ctx.wrap_socket(raw, server_side=True)
                self.handshakes += 1
                tls.close()  # not Oracle: hang up after the handshake
            except (ssl.SSLError, OSError):
                raw.close()

    def stop(self) -> None:
        self._stop = True
        self.sock.close()


@pytest.fixture
def tls(tmp_path: Path) -> Iterator[tuple[TlsListener, Path]]:
    cert, key = _self_signed(tmp_path)
    srv = TlsListener(cert, key)
    try:
        yield srv, cert
    finally:
        srv.stop()


def _connector(port: int, **settings: str) -> OracleConnector:
    base = {"host": "localhost", "port": port, "service_name": "FREEPDB1", "user": "reader"}
    return OracleConnector({**base, **settings}, {"password": "not-used-here"})


async def test_required_encrypts_but_accepts_an_untrusted_certificate(tls: tuple[TlsListener, Path]) -> None:
    srv, _ = tls
    report = await _connector(srv.port, encryption="required").test()
    assert srv.handshakes == 1  # TLS handshake completed with a self-signed cert: no verification
    assert not report.ok  # then fails because the listener isn't Oracle


async def test_verify_rejects_an_untrusted_certificate(tls: tuple[TlsListener, Path]) -> None:
    srv, _ = tls
    report = await _connector(srv.port, encryption="verify").test()
    step = report.steps[0]
    assert not step.ok and "CERTIFICATE_VERIFY_FAILED" in step.detail
    assert "CA certificate file" in step.hint
    assert srv.handshakes == 0


async def test_verify_with_ca_file_accepts_matching_host(tls: tuple[TlsListener, Path]) -> None:
    srv, cert = tls
    await _connector(srv.port, encryption="verify", ca_file=str(cert)).test()
    assert srv.handshakes == 1


async def test_verify_rejects_host_name_mismatch(tls: tuple[TlsListener, Path]) -> None:
    srv, cert = tls
    report = await _connector(srv.port, encryption="verify", ca_file=str(cert), host="127.0.0.1").test()
    step = report.steps[0]
    assert not step.ok and ("DPY-6006" in step.detail or "match" in step.detail.lower())
