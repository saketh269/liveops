"""A small local JSON HTTP API for REST connector tests.

Runs ``http.server`` on a random free port in a background thread. The test
mutates ``MockApi.rows`` directly (that is the "source system").
"""

from __future__ import annotations

import base64
import gzip
import json
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

API_KEY = "good-api-key-123"
CLIENT_ID = "client-1"
CLIENT_SECRET = "client-secret-xyz"  # noqa: S105 - test fixture


class MockApi:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()
        self.token_requests = 0
        self.requests = 0
        self.tokens: set[str] = set()
        self.redirect_target = ""
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> MockApi:
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    _bombs: dict[int, bytes] = {}

    @classmethod
    def bomb(cls, layers: int) -> bytes:
        """~200 MB of spaces, gzipped ``layers`` times (built once, a few KB on the wire)."""
        if layers not in cls._bombs:
            c = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
            chunk = b" " * (1024 * 1024)
            data = b"".join(c.compress(chunk) for _ in range(200)) + c.flush()
            for _ in range(layers - 1):
                data = gzip.compress(data, 9)
            cls._bombs[layers] = data
        return cls._bombs[layers]

    def items(self) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(r) for r in sorted(self.rows.values(), key=lambda r: str(r["id"] or "~"))]

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        api = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, code: int, body: Any, headers: dict[str, str] | None = None) -> None:
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                if urlsplit(self.path).path == "/oauth/bomb":  # token response that inflates to ~200 MB
                    n = int(self.headers.get("Content-Length") or 0)
                    self.rfile.read(n)
                    return self._send(200, api.bomb(1), {"Content-Encoding": "gzip"})
                if urlsplit(self.path).path != "/oauth/token":
                    return self._send(404, {"error": "not found"})
                n = int(self.headers.get("Content-Length") or 0)
                form = parse_qs(self.rfile.read(n).decode())
                auth = self.headers.get("Authorization", "")
                expected = "Basic " + base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
                if auth != expected or form.get("grant_type") != ["client_credentials"]:
                    return self._send(401, {"error": "invalid_client"})
                api.token_requests += 1
                tok = f"tok-{api.token_requests}-{time.time()}"
                api.tokens.add(tok)
                self._send(200, {"access_token": tok, "token_type": "Bearer", "expires_in": 3600})

            def do_GET(self) -> None:  # noqa: N802
                api.requests += 1
                u = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                path = u.path
                if path.startswith("/v1/") and path != "/v1/oauth":
                    if self.headers.get("X-API-Key") != API_KEY:
                        return self._send(401, {"error": "bad api key"})
                if path == "/v1/oauth":
                    tok = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    if tok not in api.tokens:
                        return self._send(401, {"error": "bad token"})
                    return self._send(200, {"items": api.items()})
                items = api.items()
                if path == "/v1/assets":  # page-number pagination, records at data.items
                    page, per = int(q.get("page", 1)), int(q.get("per_page", 100))
                    chunk = items[(page - 1) * per : page * per]
                    return self._send(200, {"data": {"items": chunk}, "page": page})
                if path == "/v1/cursor":  # cursor pagination
                    start, per = int(q.get("cursor", 0)), 2
                    chunk = items[start : start + per]
                    nxt = str(start + per) if start + per < len(items) else None
                    return self._send(200, {"items": chunk, "meta": {"next": nxt}})
                if path == "/v1/linked":  # Link header pagination
                    page, per = int(q.get("page", 1)), 2
                    chunk = items[(page - 1) * per : page * per]
                    headers = {}
                    if page * per < len(items):
                        headers["Link"] = f'</v1/linked?page={page + 1}>; rel="next"'
                    return self._send(200, chunk, headers)
                if path == "/v1/evil-link":  # next link to another host
                    return self._send(200, items[:1], {"Link": '<http://169.254.169.254/latest>; rel="next"'})
                if path == "/v1/endless":  # always a full page: tests the page cap
                    per = int(q.get("per_page", 2))
                    page = int(q.get("page", 1))
                    return self._send(200, [{"id": f"P{page}-{i}"} for i in range(per)])
                if path == "/v1/big":
                    return self._send(200, [{"id": str(i), "pad": "x" * 1000} for i in range(3000)])
                if path == "/v1/redirect":
                    return self._send(302, {}, {"Location": api.redirect_target or "/v1/assets"})
                if path == "/v1/bomb":  # compressed bombs: ?layers=1|2, or ?enc=<any Content-Encoding>
                    layers = int(q.get("layers", 2))
                    enc = q.get("enc") or ", ".join(["gzip"] * layers)
                    return self._send(200, api.bomb(layers), {"Content-Encoding": enc})
                if path == "/v1/gzipped":  # a normal gzip-compressed JSON response
                    raw = json.dumps(items).encode()
                    return self._send(200, gzip.compress(raw), {"Content-Encoding": "gzip"})
                if path == "/v1/html":
                    return self._send(200, b"<html>hello</html>")
                return self._send(404, {"error": "not found"})

        return H
