"""LIVEOPS-26: with Encryption=required/verify, the MySQL connector must never send
credentials to a server that doesn't offer TLS (or to someone stripping the flag).

A fake server sends a MySQL handshake without CLIENT_SSL and records every byte the
client sends back. No real MySQL needed.
"""

from __future__ import annotations

import socket
import struct
import threading

import pymysql
import pytest
from pymysql.constants import CLIENT

from app.connectors.mysql import MySQLConnector

PASSWORD = "S3cret-pw-do-not-leak"


class FakeServer:
    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.received: list[bytes] = []
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    @staticmethod
    def handshake() -> bytes:
        caps = CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.PLUGIN_AUTH  # no SSL
        payload = (
            bytes([10])
            + b"8.0.99-fake\0"
            + struct.pack("<I", 7)
            + b"abcdefgh\0"
            + struct.pack("<H", caps & 0xFFFF)
            + bytes([33])
            + struct.pack("<H", 2)
            + struct.pack("<H", caps >> 16)
            + bytes([21])
            + b"\0" * 10
            + b"ijklmnopqrst\0"
            + b"caching_sha2_password\0"
        )
        return struct.pack("<I", len(payload))[:3] + b"\0" + payload

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                conn.sendall(self.handshake())
                conn.settimeout(2)
                data = b""
                try:
                    while chunk := conn.recv(4096):
                        data += chunk
                except OSError:
                    pass
                self.received.append(data)

    def close(self) -> None:
        self.sock.close()


@pytest.fixture
def server() -> FakeServer:
    s = FakeServer()
    yield s  # type: ignore[misc]
    s.close()


def _settings(port: int, encryption: str) -> dict[str, object]:
    return {"host": "127.0.0.1", "port": port, "database": "db", "user": "reader", "encryption": encryption}


@pytest.mark.parametrize("encryption", ["required", "verify"])
def test_no_credentials_without_tls(server: FakeServer, encryption: str) -> None:
    c = MySQLConnector(_settings(server.port, encryption), {"password": PASSWORD})
    with pytest.raises(pymysql.err.OperationalError) as e:
        c._open()
    assert e.value.args[0] == 2026 and "did not offer TLS" in e.value.args[1]
    server.close()
    server._thread.join(3)
    assert server.received == [b""], "the client must not send any auth packet (user name or password)"


async def test_report_explains_and_never_leaks(server: FakeServer) -> None:
    c = MySQLConnector(_settings(server.port, "required"), {"password": PASSWORD})
    try:
        report = await c.test()
    finally:
        await c.close()
    assert not report.ok
    step = report.steps[0]
    assert step.name == "Reach the server" and "TLS" in step.detail and step.hint
    assert PASSWORD not in report.model_dump_json()


def test_binlog_connections_use_the_same_guard(server: FakeServer) -> None:
    from app.connectors.mysql import _BinlogPump

    c = MySQLConnector(_settings(server.port, "required"), {"password": PASSWORD})
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        pump = _BinlogPump(c._connect_kwargs(), 123456, "db", "t", "bin.000001", 4, lambda ev, skip: [], loop)
        with pytest.raises(pymysql.err.OperationalError) as e:
            pump._connection(**pump._reader._BinLogStreamReader__connection_settings)
        assert e.value.args[0] == 2026
    finally:
        loop.close()
    server.close()
    server._thread.join(3)
    assert all(r == b"" for r in server.received)


def test_off_still_connects_in_plaintext_by_choice(server: FakeServer) -> None:
    """Encryption=off (local testing) is allowed to skip TLS: it reaches the auth step."""
    c = MySQLConnector(_settings(server.port, "off"), {"password": PASSWORD})
    with pytest.raises(pymysql.err.MySQLError):
        c._open()
    server.close()
    server._thread.join(3)
    assert server.received and server.received[0] != b""
