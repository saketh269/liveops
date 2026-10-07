"""QA round 2 (qa-api): rest, webhook, csv_file (+ .xlsx) and s3_files, driven
only through the real HTTP API + WebSocket of a real backend process.

Covers pagination (page number, cursor, Link header), OAuth2 client
credentials, CSV/Excel edge cases, webhook delete/key/restart behaviour,
regressions for LIVEOPS-16/17/18/19/25/31 and the error shapes the UI shows.

    LIVEOPS_QA=1 pytest -q tests/qa/test_api_connectors_r2.py -s
"""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import select
import socket
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from tests.qa.harness import BEDS_CONFIG, Backend, WsCollector, all_green, latency_summary, qa, record
from tests.qa.test_connectors_e2e import BEDS, beds_csv, measure, post_signed

pytestmark = qa


class EnvBackend(Backend):
    """Backend with extra environment variables."""

    def __init__(self, extra_env: dict[str, str] | None = None, **kw: Any) -> None:
        super().__init__(**kw)
        self.extra_env = extra_env or {}

    def env(self) -> dict[str, str]:
        return {**super().env(), **self.extra_env}


@pytest.fixture(scope="module")
def backend() -> Iterator[Backend]:
    be = EnvBackend(
        # LIVEOPS-16/25: ambient AWS credentials must never be used by an s3_files source with blank keys.
        extra_env={"AWS_ACCESS_KEY_ID": "ambient", "AWS_SECRET_ACCESS_KEY": "ambient-secret"},
    )
    try:
        be.start()
        yield be
    finally:
        be.cleanup()


def kind(rep: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["name"]: s for s in rep["steps"]}


# --------------------------------------------------------------------------
# REST: a local API with pagination modes and an OAuth2 token endpoint
# --------------------------------------------------------------------------


class Api:
    """GET /beds in several pagination styles; POST /token (client credentials)."""

    def __init__(self, rows: list[dict[str, Any]], *, bearer: str | None = None, oauth: bool = False) -> None:
        self.rows = [dict(r) for r in rows]
        self.lock = threading.Lock()
        self.bearer = bearer
        self.oauth = oauth
        self.issued: list[str] = []
        self.token_calls = 0
        self.token_auth: list[str] = []
        self.expires_in: Any = 3600
        self.requests: list[str] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _send(self, code: int, obj: Any, headers: dict[str, str] | None = None) -> None:
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                form = parse_qs(self.rfile.read(n).decode())
                with outer.lock:
                    outer.token_calls += 1
                    outer.token_auth.append(self.headers.get("Authorization", ""))
                if self.path != "/token" or form.get("grant_type") != ["client_credentials"]:
                    self._send(400, {"error": "unsupported_grant_type"})
                    return
                want = "Basic " + base64.b64encode(b"cid:csecret").decode()
                if self.headers.get("Authorization") != want:
                    self._send(401, {"error": "invalid_client"})
                    return
                tok = f"at-{len(outer.issued)}"
                outer.issued.append(tok)
                self._send(200, {"access_token": tok, "token_type": "Bearer", "expires_in": outer.expires_in})

            def do_GET(self) -> None:  # noqa: N802
                u = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                with outer.lock:
                    outer.requests.append(self.path)
                    rows = [dict(r) for r in outer.rows]
                auth = self.headers.get("Authorization", "")
                if outer.bearer and auth != f"Bearer {outer.bearer}":
                    self._send(401, {"error": "bad token"})
                    return
                if outer.oauth and (not outer.issued or auth != f"Bearer {outer.issued[-1]}"):
                    self._send(401, {"error": "bad token"})
                    return
                if u.path == "/beds":
                    self._send(200, {"data": rows})
                elif u.path == "/paged":  # ?page=&per_page=
                    page, per = int(q.get("page", 1)), int(q.get("per_page", 100))
                    self._send(200, {"items": rows[(page - 1) * per : page * per]})
                elif u.path == "/cursor":  # ?cursor=<offset>, 3 per page
                    off = int(q.get("cursor", 0))
                    nxt = off + 3 if off + 3 < len(rows) else None
                    self._send(200, {"items": rows[off : off + 3], "meta": {"next": nxt}})
                elif u.path in ("/link", "/link-abs"):  # Link: <...>; rel="next", 4 per page
                    page = int(q.get("page", 1))
                    chunk = rows[(page - 1) * 4 : page * 4]
                    hdr = {}
                    if page * 4 < len(rows):
                        target = f"{u.path}?page={page + 1}"
                        if u.path == "/link-abs":
                            target = f"http://{self.headers['Host']}{target}"
                        hdr["Link"] = f'<{target}>; rel="next"'
                    self._send(200, chunk, hdr)
                else:
                    self._send(404, {"error": "nope"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def set(self, bed_id: str, **fields: Any) -> None:
        with self.lock:
            for r in self.rows:
                if r["bed_id"] == bed_id:
                    r.update(fields)

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def rest_settings(port: int, path: str, **extra: Any) -> dict[str, Any]:
    return {
        "base_url": f"http://127.0.0.1:{port}",
        "path": path,
        "allow_http": True,
        "allow_private_network": True,
        **extra,
    }


def map_and_wait(be: Backend, src: dict[str, Any], ds: str, n: int = 10, options: Any = None) -> dict[str, Any]:
    site = be.add_site(f"qa site {src['name']}", ["ICU", "Ward 4"])
    be.add_mapping(site["id"], src["id"], ds, BEDS_CONFIG, options or {"poll_interval_s": 1})
    be.wait_assets(site["id"], lambda a: len(a) == n, 30)
    return site


@pytest.mark.parametrize(
    "path,extra,n_req",
    [
        ("/paged", {"pagination": "page_number", "page_size": 3, "record_path": "items"}, 4),
        ("/cursor", {"pagination": "cursor", "cursor_path": "meta.next", "record_path": "items"}, 4),
        ("/link", {"pagination": "link_header"}, 3),
        ("/link-abs", {"pagination": "link_header"}, 3),
    ],
)
def test_rest_pagination(backend: Backend, path: str, extra: dict[str, Any], n_req: int) -> None:
    api = Api(BEDS)
    try:
        src = backend.add_source(f"qa rest {path}", "rest", rest_settings(api.port, path, **extra), {})
        rep = backend.api("POST", f"/api/sources/{src['id']}/test", 200)
        assert all_green(rep), rep
        ds = backend.api("GET", f"/api/sources/{src['id']}/datasets", 200)[0]["name"]
        site = map_and_wait(backend, src, ds)
        # one change on the last page must arrive
        api.set("B10", status="in_use")
        backend.wait_assets(site["id"], lambda a: a.get("B10", {}).get("state") == "in_use", 20)
        # one delete
        with api.lock:
            api.rows = [r for r in api.rows if r["bed_id"] != "B05"]
        backend.wait_assets(site["id"], lambda a: "B05" not in a and len(a) == 9, 20)
        record(f"r2/rest/pagination{path}", ok=True)
    finally:
        api.stop()


def test_rest_link_header_relative_hostname_liveops56(backend: Backend) -> None:
    """LIVEOPS-56 (open): relative next link with a host-name base URL."""
    api = Api(BEDS)
    try:
        s = rest_settings(api.port, "/link", pagination="link_header")
        s["base_url"] = f"http://localhost:{api.port}"
        src = backend.add_source("qa rest link localhost", "rest", s, {})
        assert all_green(backend.api("POST", f"/api/sources/{src['id']}/test", 200))
        site = backend.add_site("qa link localhost", ["ICU", "Ward 4"])
        m = backend.add_mapping(site["id"], src["id"], "link", BEDS_CONFIG, {"poll_interval_s": 1})
        time.sleep(4)
        h = backend.mapping_health(m["id"])
        n = len(backend.assets(site["id"]))
        record("r2/rest/liveops56", assets=n, status=h and h.get("status"), error=h and h.get("last_error"))
        if n != 10:
            pytest.xfail(f"LIVEOPS-56 still open: {h}")
    finally:
        api.stop()


def test_rest_oauth2(backend: Backend) -> None:
    api = Api(BEDS, oauth=True)
    try:
        s = rest_settings(
            api.port,
            "/beds",
            record_path="data",
            auth="oauth2_client_credentials",
            token_url=f"http://127.0.0.1:{api.port}/token",
            oauth_scope="beds.read",
        )
        bad = backend.add_source("qa oauth bad", "rest", s, {"client_id": "cid", "client_secret": "WRONG"})
        rep = backend.api("POST", f"/api/sources/{bad['id']}/test", 200)
        st = kind(rep)["Get an OAuth2 token"]
        assert not st["ok"] and "refused the client credentials" in st["detail"] and st["hint"], rep
        assert "WRONG" not in json.dumps(rep)

        src = backend.add_source("qa oauth", "rest", s, {"client_id": "cid", "client_secret": "csecret"})
        assert all_green(backend.api("POST", f"/api/sources/{src['id']}/test", 200))
        site = map_and_wait(backend, src, "beds")
        calls_after_start = api.token_calls
        api.set("B01", status="in_use")
        backend.wait_assets(site["id"], lambda a: a["B01"]["state"] == "in_use", 20)
        time.sleep(3)
        # token is cached while valid (expires_in 3600): no new token per poll
        assert api.token_calls == calls_after_start, (calls_after_start, api.token_calls)
        # server revokes the token (rotates): next poll gets 401, then a fresh token
        with api.lock:
            api.issued.append("rotated")
        api.set("B02", status="in_use")
        backend.wait_assets(site["id"], lambda a: a["B02"]["state"] == "in_use", 30)
        record("r2/rest/oauth2", token_calls=api.token_calls, ok=True)
    finally:
        api.stop()


# --------------------------------------------------------------------------
# REST error shapes (what the test step shows)
# --------------------------------------------------------------------------


def test_rest_error_shapes(backend: Backend) -> None:
    api = Api(BEDS, bearer="right")
    try:
        s = rest_settings(api.port, "/beds", record_path="data", auth="bearer")
        src = backend.add_source("qa wrong token", "rest", s, {"bearer_token": "wrong"})
        rep = backend.api("POST", f"/api/sources/{src['id']}/test", 200)
        st = kind(rep)["Call the API"]
        assert not st["ok"] and "HTTP 401" in st["detail"] and "token" in st["hint"], rep
        assert "wrong" not in json.dumps(rep)

        un = backend.add_source("qa unreachable", "rest", rest_settings(1, "/beds"), {})
        rep = backend.api("POST", f"/api/sources/{un['id']}/test", 200)
        st = kind(rep)["Call the API"]
        assert not st["ok"] and "Couldn't reach" in st["detail"] and "host name and port" in st["hint"], rep

        dns = backend.add_source(
            "qa nxdomain", "rest", {**rest_settings(1, "/beds"), "base_url": "http://no-such-host.invalid"}, {}
        )
        rep = backend.api("POST", f"/api/sources/{dns['id']}/test", 200)
        st = kind(rep)["Call the API"]
        assert not st["ok"] and "look up the host name" in st["detail"] and st["hint"], rep

        priv = backend.add_source(
            "qa private no opt-in", "rest", {**rest_settings(api.port, "/beds"), "allow_private_network": False}, {}
        )
        rep = backend.api("POST", f"/api/sources/{priv['id']}/test", 200)
        st = kind(rep)["Call the API"]
        assert not st["ok"] and "private" in st["detail"] and "Allow private network" in st["hint"], rep

        meta = backend.add_source(
            "qa metadata",
            "rest",
            {**rest_settings(80, "/latest"), "base_url": "http://169.254.169.254"},
            {},
        )
        rep = backend.api("POST", f"/api/sources/{meta['id']}/test", 200)
        assert not rep["ok"] and "blocked" in json.dumps(rep), rep

        nf = backend.add_source("qa 404", "rest", rest_settings(api.port, "/nope"), {"bearer_token": "x"})
        rep = backend.api("POST", f"/api/sources/{nf['id']}/test", 200)
        assert not rep["ok"], rep
        record("r2/rest/error_shapes", ok=True)
    finally:
        api.stop()


# --------------------------------------------------------------------------
# CSV / Excel
# --------------------------------------------------------------------------


def upload(be: Backend, sid: str, name: str, data: bytes, expect: int | None = 201) -> Any:
    return be.api(
        "POST", f"/api/sources/{sid}/upload", expect, files={"file": (name, data, "application/octet-stream")}
    )


def raw_upload(be: Backend, sid: str, name: str, data: bytes) -> httpx.Response:
    return httpx.post(f"{be.base}/api/sources/{sid}/upload", files={"file": (name, data)}, timeout=120)


@pytest.mark.parametrize("delim", ["\t", ";", "|"])
def test_csv_delimiters(backend: Backend, delim: str) -> None:
    src = backend.add_source(f"qa csv {delim!r}", "csv_file", {"delimiter": delim}, {})
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(BEDS[0]), delimiter=delim)
    w.writeheader()
    w.writerows(BEDS)
    up = upload(backend, src["id"], "beds.csv", buf.getvalue().encode())
    assert up["rows"] == 10 and up["columns"][:2] == ["bed_id", "unit"], up
    map_and_wait(backend, src, "beds.csv")


def test_csv_edge_files(backend: Backend) -> None:
    src = backend.add_source("qa csv edge", "csv_file", {}, {})
    # header only: accepted, 0 rows, test step not failing
    up = upload(backend, src["id"], "empty.csv", b"bed_id,unit,status,bed_label,patient_count\r\n")
    assert up["rows"] == 0, up
    # 0-byte file
    up0 = raw_upload(backend, src["id"], "zero.csv", b"")
    # BOM + quoted newline in a label
    rows = [dict(b) for b in BEDS]
    rows[0]["bed_label"] = 'Bed 01\nwindow side, "quiet"'
    up = upload(backend, src["id"], "bom.csv", b"\xef\xbb\xbf" + beds_csv(rows))
    assert up["rows"] == 10 and up["columns"][0] == "bed_id", up
    rep = backend.api("POST", f"/api/sources/{src['id']}/test", 200)
    site = map_and_wait(backend, src, "bom.csv")
    a = backend.assets(site["id"])["B01"]
    assert a["label"] == 'Bed 01\nwindow side, "quiet"', a
    # non-UTF-8 file: readable 422
    r = raw_upload(backend, src["id"], "latin.csv", "bed_id,unit\nB1,Zürich\n".encode("latin-1"))
    assert r.status_code == 422 and "UTF-8" in r.json()["detail"]["hint"], r.text
    record(
        "r2/csv/edge",
        header_only_rows=0,
        zero_byte=up0.status_code,
        test_ok=rep["ok"],
        test_steps=[(s["name"], s["ok"]) for s in rep["steps"]],
    )


def test_csv_10mb_and_replace_latency(backend: Backend) -> None:
    src = backend.add_source("qa csv 10mb", "csv_file", {}, {})
    big = [
        {
            "bed_id": f"B{i:05d}",
            "unit": "ICU" if i % 2 else "Ward 4",
            "status": "vacant",
            "bed_label": "x" * 185,
            "patient_count": i % 3,
        }
        for i in range(1, 49_001)
    ]
    data = beds_csv(big)
    assert len(data) > 9 * 1024 * 1024, len(data)
    t0 = time.time()
    up = upload(backend, src["id"], "big.csv", data)
    t_up = time.time() - t0
    assert up["rows"] == len(big), up
    site = backend.add_site("qa big", ["ICU", "Ward 4"])
    backend.add_mapping(site["id"], src["id"], "big.csv", BEDS_CONFIG, {"poll_interval_s": 1})
    t0 = time.time()
    backend.wait_assets(site["id"], lambda a: len(a) == len(big), 120)
    t_map = time.time() - t0
    big[0]["status"] = "in_use"
    t0 = time.time()
    upload(backend, src["id"], "big.csv", beds_csv(big))
    ws = WsCollector(f"{backend.ws_base}/ws/sites/{site['id']}")
    try:
        ws.wait_asset("B00001", lambda a: a.get("state") == "in_use", 60, since=0)
    finally:
        ws.close()
    t_change = time.time() - t0
    record(
        "r2/csv/10mb",
        mb=round(len(data) / 2**20, 1),
        upload_s=round(t_up, 2),
        first_map_s=round(t_map, 2),
        replace_to_ws_s=round(t_change, 2),
    )


def _xlsx(sheets: dict[str, list[dict[str, Any]]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        ws.append(list(rows[0]))
        for r in rows:
            ws.append(list(r.values()))
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_xlsx_multi_sheet(backend: Backend) -> None:
    other = [
        {"bed_id": f"X{i}", "unit": "ICU", "status": "vacant", "bed_label": f"X{i}", "patient_count": 0}
        for i in range(3)
    ]
    data = _xlsx({"Summary": [{"note": "hello"}], "Beds": BEDS, "Other": other})
    src = backend.add_source("qa xlsx default", "csv_file", {}, {})
    up = upload(backend, src["id"], "beds.xlsx", data)
    first = up
    src2 = backend.add_source("qa xlsx sheet", "csv_file", {"sheet": "Beds"}, {})
    up2 = upload(backend, src2["id"], "beds.xlsx", data)
    assert up2["rows"] == 10, up2
    ds = backend.api("GET", f"/api/sources/{src2['id']}/datasets", 200)
    site = map_and_wait(backend, src2, "beds.xlsx")
    rows = [dict(b) for b in BEDS]
    rows[3]["status"] = "in_use"
    upload(backend, src2["id"], "beds.xlsx", _xlsx({"Summary": [{"note": "x"}], "Beds": rows, "Other": other}))
    backend.wait_assets(site["id"], lambda a: a["B04"]["state"] == "in_use", 20)
    src3 = backend.add_source("qa xlsx missing", "csv_file", {"sheet": "Nope"}, {})
    r = raw_upload(backend, src3["id"], "beds.xlsx", data)
    assert r.status_code == 422 and "Summary" in r.json()["detail"]["hint"], r.text
    record(
        "r2/xlsx/multisheet",
        default_sheet_rows=first["rows"],
        default_cols=first["columns"],
        datasets=[d["name"] for d in ds],
    )


def test_upload_error_shapes_and_liveops18(backend: Backend) -> None:
    src = backend.add_source("qa upload errors", "csv_file", {}, {})
    sid = src["id"]
    r = raw_upload(backend, sid, "beds.txt", b"a,b\n1,2\n")
    assert r.status_code == 415 and r.json()["detail"]["message"], r.text
    r = httpx.post(f"{backend.base}/api/sources/{sid}/upload", content=b"a,b", headers={"Content-Type": "text/csv"})
    assert r.status_code == 422 and "multipart" in r.json()["detail"]["message"], r.text
    r = raw_upload(backend, sid, "../x.csv", b"a\n1\n")
    assert r.status_code == 422 and r.json()["detail"]["hint"], r.text
    # 413 by declared length (immediate, before any body byte is read)
    with socket.create_connection(("127.0.0.1", backend.port)) as sk:
        sk.sendall(
            f"POST /api/sources/{sid}/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            f"Content-Type: multipart/form-data; boundary=zz\r\nContent-Length: {60 * 2**20}\r\n\r\n".encode()
        )
        sk.settimeout(10)
        declared = ""
        while "}" not in declared:
            d = sk.recv(65536)
            if not d:
                break
            declared += d.decode(errors="replace")
    assert declared.startswith("HTTP/1.1 413") and "hint" in declared, declared
    # LIVEOPS-18: chunked body, no Content-Length; must be refused soon after the limit, not spooled
    sent, status, body = _stream_until_answer(backend, f"/api/sources/{sid}/upload", 200 * 2**20)
    assert status == 413, (status, body)
    assert sent < 60 * 2**20, sent
    assert "50 MB" in body and "hint" in body, body
    leftovers = (
        [p for p in os.listdir(os.path.join(backend.data_dir, sid))]
        if os.path.isdir(os.path.join(backend.data_dir, sid))
        else []
    )
    assert not leftovers, leftovers
    record("r2/upload/413", sent_mb=round(sent / 2**20, 1), body=body[:200])


def _stream_until_answer(be: Backend, path: str, max_bytes: int) -> tuple[int, int, str]:
    s = socket.create_connection(("127.0.0.1", be.port))
    s.sendall(
        (
            f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n"
            "Content-Type: multipart/form-data; boundary=BOUND\r\n\r\n"
        ).encode()
    )
    head = b'--BOUND\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\n\r\n'
    s.sendall(b"%x\r\n%s\r\n" % (len(head), head))
    chunk = b"a,b,c\n" * (2**20 // 6)
    sent = 0
    resp = b""
    try:
        while sent < max_bytes:
            r, _, _ = select.select([s], [], [], 0)
            if r:
                break
            s.sendall(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            sent += len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass
    s.settimeout(10)
    try:
        while b"\r\n\r\n" not in resp or len(resp) < 200:
            d = s.recv(65536)
            if not d:
                break
            resp += d
    except (TimeoutError, ConnectionResetError):
        pass
    s.close()
    text = resp.decode(errors="replace")
    status = int(text.split(" ", 2)[1]) if text.startswith("HTTP/") else -1
    return sent, status, text


def _rss_hwm_kb(pid: int) -> int:
    for line in open(f"/proc/{pid}/status"):
        if line.startswith("VmHWM:"):
            return int(line.split()[1])
    return -1


def test_xlsx_bomb_liveops19(backend: Backend) -> None:
    import zipfile

    src = backend.add_source("qa xlsx bomb", "csv_file", {}, {})
    good = _xlsx({"Beds": BEDS})
    zin = zipfile.ZipFile(io.BytesIO(good))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for i in zin.infolist():
            z.writestr(i, zin.read(i.filename))
        ss = (
            b'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + (b"<si><t>" + b"A" * 1000 + b"</t></si>") * 300_000
            + b"</sst>"
        )
        z.writestr("xl/sharedStrings.xml", ss)
    data = out.getvalue()
    before = _rss_hwm_kb(backend.pid())
    t0 = time.time()
    r = raw_upload(backend, src["id"], "bomb.xlsx", data)
    dt = time.time() - t0
    after = _rss_hwm_kb(backend.pid())
    assert r.status_code == 422 and "too much data" in r.json()["detail"]["message"], r.text
    assert after - before < 200_000, (before, after)
    record(
        "r2/xlsx/bomb",
        kb=len(data) // 1024,
        status=r.status_code,
        s=round(dt, 2),
        rss_growth_mb=(after - before) // 1024,
    )


# --------------------------------------------------------------------------
# Webhook
# --------------------------------------------------------------------------


def test_webhook_single_list_delete_latency(backend: Backend) -> None:
    secret = "qa-r2-secret-" + os.urandom(8).hex()
    src = backend.add_source(
        "qa wh r2", "webhook", {"key_field": "bed_id", "dataset_name": "beds"}, {"signing_secret": secret}
    )
    assert post_signed(backend, src["id"], secret, BEDS).json() == {"accepted": 10}
    site = map_and_wait(backend, src, "beds")

    def change(i: int) -> tuple[str, str]:
        bid = f"B{(i % 10) + 1:02d}"
        rr = post_signed(backend, src["id"], secret, dict(BEDS[i % 10], status=f"s{i}"))
        assert rr.status_code == 202, rr.text
        return bid, f"s{i}"

    lat = measure(backend, site["id"], change, n=25)
    record("r2/webhook/latency", **latency_summary(lat))
    # list with an upsert and a delete
    r = post_signed(backend, src["id"], secret, [dict(BEDS[0], status="cleaning"), {"bed_id": "B09", "_deleted": True}])
    assert r.status_code == 202, r.text
    backend.wait_assets(site["id"], lambda a: "B09" not in a and a["B01"]["state"] == "cleaning", 10)
    # error shapes: 422 with readable messages
    r = post_signed(backend, src["id"], secret, [{"unit": "ICU"}])
    assert r.status_code == 422 and "bed_id" in r.json()["detail"]["message"], r.text
    r = post_signed(backend, src["id"], secret, [])
    assert r.status_code == 422, r.text
    big = [dict(BEDS[0], bed_id=f"Z{i}", bed_label="y" * 300) for i in range(4000)]
    r = post_signed(backend, src["id"], secret, big)
    assert r.status_code == 413 and r.json()["detail"]["hint"], r.text


def test_webhook_deleted_non_boolean(backend: Backend) -> None:
    """A sender writing "_deleted": "true" / 1 must not blank the asset."""
    secret = "qa-r2-secret-" + os.urandom(8).hex()
    src = backend.add_source(
        "qa wh del", "webhook", {"key_field": "bed_id", "dataset_name": "beds"}, {"signing_secret": secret}
    )
    post_signed(backend, src["id"], secret, BEDS)
    site = map_and_wait(backend, src, "beds")
    out = {}
    for bid, val in (("B01", "true"), ("B02", 1)):
        r = post_signed(backend, src["id"], secret, {"bed_id": bid, "_deleted": val})
        time.sleep(1.5)
        out[f"{bid}={val!r}"] = (r.status_code, backend.assets(site["id"]).get(bid))
    record("r2/webhook/deleted_non_bool", **{k: str(v) for k, v in out.items()})
    if any(code == 202 and asset is not None for code, asset in out.values()):
        pytest.xfail("LIVEOPS-90: non-boolean _deleted accepted (202) but not deleted")


def test_webhook_key_field_change(backend: Backend) -> None:
    """Change the source's Record ID field; delete; restart the mapping: does the old record come back?"""
    secret = "qa-r2-secret-" + os.urandom(8).hex()
    settings = {"key_field": "bed_id", "dataset_name": "beds"}
    src = backend.add_source("qa wh key", "webhook", settings, {"signing_secret": secret})
    rows = [dict(b, code=b["bed_id"]) for b in BEDS]
    post_signed(backend, src["id"], secret, rows)
    site = backend.add_site("qa wh key site", ["ICU", "Ward 4"])
    cfg = dict(BEDS_CONFIG)
    m = backend.add_mapping(site["id"], src["id"], "beds", cfg)
    backend.wait_assets(site["id"], lambda a: len(a) == 10, 20)
    backend.api("PUT", f"/api/sources/{src['id']}", 200, json={"settings": {**settings, "key_field": "code"}})
    time.sleep(1)
    r = post_signed(backend, src["id"], secret, {"code": "B03", "bed_id": "B03", "_deleted": True})
    assert r.status_code == 202, r.text
    backend.wait_assets(site["id"], lambda a: "B03" not in a, 10)
    # restart the mapping (any mapping edit or source save does this)
    backend.api("PUT", f"/api/sources/{src['id']}", 200, json={"name": "qa wh key renamed"})
    time.sleep(2)
    a = backend.assets(site["id"])
    prev = backend.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": "beds", "limit": 50})
    record(
        "r2/webhook/key_change",
        b03_back="B03" in a,
        preview_has_b03=any(p.get("bed_id") == "B03" for p in prev),
        mapping=m["id"],
    )
    assert "B03" not in a, "deleted record resurrected after the mapping restarted"


def test_webhook_restart(backend: Backend) -> None:
    """What the user sees after a backend restart (memory and Redis stores)."""
    results = {}
    for mode in ("memory", "redis"):
        be = Backend(redis=mode == "redis")
        try:
            be.start()
            secret = "qa-r2-secret-" + os.urandom(8).hex()
            src = be.add_source(
                "qa wh restart", "webhook", {"key_field": "bed_id", "dataset_name": "beds"}, {"signing_secret": secret}
            )
            post_signed(be, src["id"], secret, BEDS)
            site = map_and_wait(be, src, "beds")
            be.restart()
            time.sleep(4)
            n_after = len(be.assets(site["id"]))
            rep = be.api("POST", f"/api/sources/{src['id']}/test", 200)
            health = be.api("GET", "/api/health/mappings", 200)
            prev = be.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": "beds"})
            post_signed(be, src["id"], secret, BEDS[:1])
            be.wait_assets(site["id"], lambda a: "B01" in a, 10)
            results[mode] = {
                "assets_after_restart": n_after,
                "preview_rows": len(prev),
                "events_step": kind(rep)["Events received"]["detail"],
                "health": [(h["status"], h.get("last_error")) for h in health],
            }
        finally:
            be.cleanup()
    record("r2/webhook/restart", **results)
    if any(r["assets_after_restart"] == 0 for r in results.values()):
        pytest.xfail("LIVEOPS-89: map goes empty after a backend restart; Health stays running")


def test_webhook_regressions_17_31(backend: Backend) -> None:
    from app.connectors.webhook import sign

    secret = "qa-r2-shared-" + os.urandom(8).hex()
    a = backend.add_source(
        "qa wh A", "webhook", {"key_field": "bed_id", "dataset_name": "beds"}, {"signing_secret": secret}
    )
    b = backend.add_source(
        "qa wh B", "webhook", {"key_field": "bed_id", "dataset_name": "beds"}, {"signing_secret": secret}
    )
    body = json.dumps({"bed_id": "ONLY-A", "status": "x"}).encode()
    t = str(int(time.time()))
    sig = sign(secret, t, body)
    url = f"{backend.base}/api/webhooks/{a['id']}"
    h = {"Content-Type": "application/json", "X-LiveOps-Timestamp": t}
    assert httpx.post(url, content=body, headers={**h, "X-LiveOps-Signature": sig}).status_code == 202
    codes = []
    for suffix in (b"\xa0", b"\x85", b"\xa0\xa0"):
        r = httpx.post(url, content=body, headers=[*h.items(), ("X-LiveOps-Signature", sig.encode() + suffix)])
        codes.append(r.status_code)
    r = httpx.post(url, content=body, headers={**h, "X-LiveOps-Signature": sig.upper().replace("SHA256", "sha256")})
    codes.append(r.status_code)
    r = httpx.post(url, content=body, headers={**h, "X-LiveOps-Signature": sig})
    codes.append(r.status_code)
    assert all(c == 401 for c in codes), codes  # LIVEOPS-17
    prev_b = backend.api("GET", f"/api/sources/{b['id']}/preview", 200, params={"dataset": "beds"})
    assert not any(p.get("bed_id") == "ONLY-A" for p in prev_b), prev_b  # LIVEOPS-31
    record("r2/regress/17_31", replay_codes=codes, b_preview=len(prev_b))


# --------------------------------------------------------------------------
# S3 (moto)
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def moto_s3() -> Iterator[tuple[str, Any]]:
    import boto3
    from botocore.config import Config
    from moto.server import ThreadedMotoServer

    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    url = f"http://{host}:{port}"
    s3 = boto3.client(
        "s3",
        endpoint_url=url,
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        config=Config(s3={"addressing_style": "path"}),
    )
    try:
        yield url, s3
    finally:
        server.stop()


def test_s3_regressions_16_25_and_xlsx(backend: Backend, moto_s3: tuple[str, Any]) -> None:
    url, s3 = moto_s3
    bucket = f"qa-{os.urandom(4).hex()}"
    s3.create_bucket(Bucket=bucket)
    s3.put_object(Bucket=bucket, Key="exp/beds.csv", Body=beds_csv(BEDS))
    s3.put_object(Bucket=bucket, Key="exp/beds.xlsx", Body=_xlsx({"Beds": BEDS}))
    s3.put_object(Bucket=bucket, Key="exp/beds.jsonl", Body="\n".join(json.dumps(b) for b in BEDS).encode())
    settings = {
        "bucket": bucket,
        "prefix": "exp/",
        "endpoint_url": url,
        "encryption": "off",
        "allow_private_network": True,
    }
    # LIVEOPS-16/25: blank keys must not fall back to the server's AWS env credentials
    blank = backend.add_source("qa s3 blank", "s3_files", settings, {})
    rep = backend.api("POST", f"/api/sources/{blank['id']}/test", 200)
    assert not rep["ok"] and "access key" in rep["steps"][0]["detail"], rep
    inst = backend.add_source("qa s3 role", "s3_files", {**settings, "use_instance_role": True}, {})
    rep = backend.api("POST", f"/api/sources/{inst['id']}/test", 200)
    assert not rep["ok"] and "turned off" in rep["steps"][0]["detail"], rep
    # private endpoint without opt-in
    np_ = backend.add_source(
        "qa s3 noprv",
        "s3_files",
        {**settings, "allow_private_network": False},
        {"access_key_id": "test", "secret_access_key": "test"},
    )
    rep = backend.api("POST", f"/api/sources/{np_['id']}/test", 200)
    assert not rep["ok"] and "private" in json.dumps(rep), rep
    # unreachable endpoint
    un = backend.add_source(
        "qa s3 down",
        "s3_files",
        {**settings, "endpoint_url": "http://127.0.0.1:1"},
        {"access_key_id": "test", "secret_access_key": "test"},
    )
    t0 = time.time()
    rep = backend.api("POST", f"/api/sources/{un['id']}/test", 200)
    t_un = time.time() - t0
    assert not rep["ok"] and "reach" in json.dumps(rep), rep
    src = backend.add_source("qa s3", "s3_files", settings, {"access_key_id": "test", "secret_access_key": "test"})
    assert all_green(backend.api("POST", f"/api/sources/{src['id']}/test", 200))
    ds = sorted(d["name"] for d in backend.api("GET", f"/api/sources/{src['id']}/datasets", 200))
    assert ds == ["exp/beds.csv", "exp/beds.jsonl", "exp/beds.xlsx"], ds
    site = map_and_wait(backend, src, "exp/beds.xlsx")
    rows = [dict(b) for b in BEDS]
    rows[6]["status"] = "in_use"
    s3.put_object(Bucket=bucket, Key="exp/beds.xlsx", Body=_xlsx({"Beds": rows}))
    backend.wait_assets(site["id"], lambda a: a["B07"]["state"] == "in_use", 20)
    s3.delete_object(Bucket=bucket, Key="exp/beds.xlsx")
    time.sleep(4)
    h = [
        (x["status"], x["last_error"], x["last_error_hint"])
        for x in backend.api("GET", "/api/health/mappings", 200)
        if x["source_id"] == src["id"]
    ]
    record(
        "r2/s3",
        datasets=ds,
        unreachable_test_s=round(t_un, 1),
        after_object_deleted={"assets": len(backend.assets(site["id"])), "health": h},
    )
