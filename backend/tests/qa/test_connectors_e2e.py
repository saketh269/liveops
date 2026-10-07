"""QA 1: per-connector end-to-end through the HTTP API + WebSocket, with
change -> WebSocket latency (p50/p95 over >= 20 changes)."""

from __future__ import annotations

import csv
import io
import json
import os
import random
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx
import pytest

from tests.qa.harness import (
    BEDS_CONFIG,
    Backend,
    MySqlSource,
    PgSource,
    WsCollector,
    all_green,
    latency_summary,
    qa,
    record,
)

pytestmark = qa
JITTER_S = float(os.environ.get("LIVEOPS_QA_JITTER_S", "3"))
N_CHANGES = int(os.environ.get("LIVEOPS_QA_CHANGES", "20"))
BEDS = [
    {
        "bed_id": f"B{i:02d}",
        "unit": "ICU" if i < 5 else "Ward 4",
        "status": "vacant",
        "bed_label": f"Bed {i:02d}",
        "patient_count": 0,
    }
    for i in range(1, 11)
]


@pytest.fixture(scope="module", params=["memory", "redis"])
def backend(request: pytest.FixtureRequest) -> Iterator[Backend]:
    if request.param == "redis" and os.environ.get("LIVEOPS_QA_REDIS", "1") != "1":
        pytest.skip("redis run disabled")
    be = Backend(redis=request.param == "redis")
    try:
        be.start()
        yield be
    finally:
        be.cleanup()


def connect_and_map(
    be: Backend,
    type_: str,
    settings: dict[str, Any],
    secrets: dict[str, Any],
    dataset_hint: str,
    options: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    src = be.add_source(f"qa {type_}", type_, settings, secrets)
    rep = be.api("POST", f"/api/sources/{src['id']}/test", 200)
    assert all_green(rep), f"test() not green: {json.dumps(rep, indent=1)}"
    datasets = be.api("GET", f"/api/sources/{src['id']}/datasets", 200)
    names = [d["name"] for d in datasets]
    ds = next((n for n in names if dataset_hint in n), None)
    assert ds, f"{dataset_hint} not in {names}"
    prev = be.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": ds})
    assert prev and "bed_id" in prev[0], prev
    site = be.add_site(f"qa {type_} site", ["ICU", "Ward 4"])
    m = be.add_mapping(site["id"], src["id"], ds, config or BEDS_CONFIG, options)
    assert m["running"], m
    return src, site, m, ds


def measure(
    be: Backend,
    site_id: str,
    change: Callable[[int], tuple[str, str]],
    n: int = N_CHANGES,
    timeout: float = 30,
) -> list[float]:
    ws = WsCollector(f"{be.ws_base}/ws/sites/{site_id}")
    try:
        ws.wait(lambda m: len(ws.state) >= 10, 30)
        out = []
        for i in range(n):
            # Random phase vs. the poll interval, so poll latencies aren't all ~interval.
            time.sleep(random.uniform(0, JITTER_S))
            mark = ws.mark()
            t0 = time.time()
            asset, state = change(i)
            try:
                t1 = ws.wait_asset(asset, lambda a, s=state: a.get("state") == s, timeout, since=mark)
            except AssertionError as e:
                tail = [
                    (m["type"], [f"{a['asset_id']}:{a.get('state')}" for a in m.get("assets", [])])
                    for _, m in ws.messages[-6:]
                ]
                raise AssertionError(
                    f"change {i} ({asset} -> {state}) not seen on WS. REST asset="
                    f"{be.assets(site_id).get(asset)}; health={be.api('GET', '/api/health/mappings')}; "
                    f"ws tail={tail}\nlog:\n{be.log_tail(20)}"
                ) from e
            out.append((t1 - t0) * 1000)
        return out
    finally:
        ws.close()


def check_delete(be: Backend, site_id: str, delete: Callable[[], str], timeout: float = 30) -> None:
    ws = WsCollector(f"{be.ws_base}/ws/sites/{site_id}")
    try:
        mark = ws.mark()
        asset = delete()
        ws.wait_removed(asset, timeout, since=mark)
    finally:
        ws.close()
    assert asset not in be.assets(site_id)


def check_first_snapshot(be: Backend, site_id: str) -> None:
    a = be.wait_assets(site_id, lambda a: len(a) == 10, 30)
    b = a["B01"]
    assert b["zone"] == "ICU" and b["state"] == "vacant" and b["label"] == "Bed 01" and b["kind"] == "bed", b


# --------------------------------------------------------------------------
# postgres (poll) and postgres_cdc
# --------------------------------------------------------------------------


def _pg_beds(pg: PgSource) -> None:
    pg.exec(
        "CREATE TABLE beds (bed_id text PRIMARY KEY, unit text NOT NULL, status text NOT NULL, "
        "bed_label text, patient_count int)"
    )
    for b in BEDS:
        pg.exec("INSERT INTO beds VALUES (%(bed_id)s,%(unit)s,%(status)s,%(bed_label)s,%(patient_count)s)", b)


@pytest.mark.parametrize("type_", ["postgres", "postgres_cdc"])
def test_postgres(backend: Backend, type_: str) -> None:
    pg = PgSource(cdc=type_ == "postgres_cdc")
    try:
        _pg_beds(pg)
        if type_ == "postgres_cdc":
            pg.exec("ALTER TABLE beds REPLICA IDENTITY FULL")
        src, site, m, _ = connect_and_map(backend, type_, pg.settings(), {"password": pg.password}, "beds")
        check_first_snapshot(backend, site["id"])

        def change(i: int) -> tuple[str, str]:
            bid = f"B{(i % 10) + 1:02d}"
            pg.exec("UPDATE beds SET status=%s WHERE bed_id=%s", (f"s{i}", bid))
            return bid, f"s{i}"

        lat = measure(backend, site["id"], change)
        pg.exec("INSERT INTO beds VALUES ('B99','ICU','occupied','Bed 99',1)")
        backend.wait_assets(site["id"], lambda a: a.get("B99", {}).get("state") == "in_use")
        check_delete(backend, site["id"], lambda: (pg.exec("DELETE FROM beds WHERE bed_id='B99'"), "B99")[1])
        h = backend.mapping_health(m["id"])
        record(
            f"e2e/{type_}/{'redis' if backend.redis_prefix else 'memory'}",
            **latency_summary(lat),
            health_status=h and h["status"],
            health_lag_p95=h and h["lag_ms_p95"],
        )
    finally:
        pg.cleanup()


# --------------------------------------------------------------------------
# mysql (cdc and poll)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["cdc", "poll"])
def test_mysql(backend: Backend, mode: str) -> None:
    my = MySqlSource()
    try:
        my.exec(
            f"CREATE TABLE `{my.db}`.beds (bed_id VARCHAR(16) PRIMARY KEY, unit VARCHAR(32) NOT NULL, "
            "status VARCHAR(64) NOT NULL, bed_label VARCHAR(64), patient_count INT)"
        )
        my.executemany(
            f"INSERT INTO `{my.db}`.beds VALUES (%(bed_id)s,%(unit)s,%(status)s,%(bed_label)s,%(patient_count)s)",
            BEDS,
        )
        src, site, m, _ = connect_and_map(backend, "mysql", my.settings(mode), {"password": my.password}, "beds")
        check_first_snapshot(backend, site["id"])

        def change(i: int) -> tuple[str, str]:
            bid = f"B{(i % 10) + 1:02d}"
            my.exec(f"UPDATE `{my.db}`.beds SET status=%s WHERE bed_id=%s", (f"s{i}", bid))
            return bid, f"s{i}"

        lat = measure(backend, site["id"], change)
        my.exec(f"INSERT INTO `{my.db}`.beds VALUES ('B99','ICU','occupied','Bed 99',1)")
        backend.wait_assets(site["id"], lambda a: a.get("B99", {}).get("state") == "in_use")
        check_delete(backend, site["id"], lambda: (my.exec(f"DELETE FROM `{my.db}`.beds WHERE bed_id='B99'"), "B99")[1])
        record(f"e2e/mysql_{mode}/{'redis' if backend.redis_prefix else 'memory'}", **latency_summary(lat))
    finally:
        my.cleanup()


# --------------------------------------------------------------------------
# rest (against a tiny local JSON server)
# --------------------------------------------------------------------------


class JsonServer:
    def __init__(self, rows: list[dict[str, Any]], token: str) -> None:
        self.rows = [dict(r) for r in rows]
        self.lock = threading.Lock()
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                if self.headers.get("Authorization") != f"Bearer {token}":
                    self.send_response(401)
                    self.end_headers()
                    return
                with outer.lock:
                    body = json.dumps({"data": outer.rows}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

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


def test_rest(backend: Backend) -> None:
    srv = JsonServer(BEDS, "tok-123")
    try:
        settings = {
            "base_url": f"http://127.0.0.1:{srv.port}",
            "path": "/beds",
            "record_path": "data",
            "auth": "bearer",
            "allow_http": True,
        }
        src, site, m, _ = connect_and_map(backend, "rest", settings, {"bearer_token": "tok-123"}, "beds")
        check_first_snapshot(backend, site["id"])

        def change(i: int) -> tuple[str, str]:
            bid = f"B{(i % 10) + 1:02d}"
            srv.set(bid, status=f"s{i}")
            return bid, f"s{i}"

        lat = measure(backend, site["id"], change)

        def delete() -> str:
            with srv.lock:
                srv.rows = [r for r in srv.rows if r["bed_id"] != "B10"]
            return "B10"

        check_delete(backend, site["id"], delete)
        record(f"e2e/rest/{'redis' if backend.redis_prefix else 'memory'}", **latency_summary(lat))
    finally:
        srv.stop()


# --------------------------------------------------------------------------
# webhook (signed POSTs)
# --------------------------------------------------------------------------


def post_signed(be: Backend, source_id: str, secret: str, body_obj: Any, ts: int | None = None) -> httpx.Response:
    from app.connectors.webhook import sign

    body = json.dumps(body_obj).encode()
    t = str(ts if ts is not None else int(time.time()))
    return httpx.post(
        f"{be.base}/api/webhooks/{source_id}",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-LiveOps-Timestamp": t,
            "X-LiveOps-Signature": sign(secret, t, body),
        },
        timeout=10,
    )


def test_webhook(backend: Backend) -> None:
    secret = "qa-signing-secret-" + os.urandom(8).hex()
    src = backend.add_source(
        "qa webhook", "webhook", {"key_field": "bed_id", "dataset_name": "beds"}, {"signing_secret": secret}
    )
    assert all_green(backend.api("POST", f"/api/sources/{src['id']}/test", 200))
    r = post_signed(backend, src["id"], secret, BEDS)
    assert r.status_code == 202, r.text
    # negative: bad signature / stale timestamp / replay
    bad = httpx.post(
        f"{backend.base}/api/webhooks/{src['id']}",
        content=b'{"bed_id":"X"}',
        headers={"X-LiveOps-Timestamp": str(int(time.time())), "X-LiveOps-Signature": "sha256=00"},
    )
    assert bad.status_code == 401, bad.text
    assert post_signed(backend, src["id"], secret, {"bed_id": "X"}, ts=int(time.time()) - 3600).status_code == 401
    ds = backend.api("GET", f"/api/sources/{src['id']}/datasets", 200)
    assert ds[0]["name"] == "beds" and {"bed_id", "status", "unit"} <= {c["name"] for c in ds[0]["columns"]}, ds
    prev = backend.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": "beds"})
    assert len(prev) == 10
    site = backend.add_site("qa webhook site", ["ICU", "Ward 4"])
    backend.add_mapping(site["id"], src["id"], "beds", BEDS_CONFIG)
    check_first_snapshot(backend, site["id"])

    def change(i: int) -> tuple[str, str]:
        bid = f"B{(i % 10) + 1:02d}"
        rec = dict(BEDS[i % 10], status=f"s{i}")
        rr = post_signed(backend, src["id"], secret, rec)
        assert rr.status_code == 202, rr.text
        return bid, f"s{i}"

    lat = measure(backend, site["id"], change)
    check_delete(
        backend,
        site["id"],
        lambda: (post_signed(backend, src["id"], secret, {"bed_id": "B10", "_deleted": True}), "B10")[1],
    )
    record(f"e2e/webhook/{'redis' if backend.redis_prefix else 'memory'}", **latency_summary(lat))


# --------------------------------------------------------------------------
# csv_file (upload, then replace the file)
# --------------------------------------------------------------------------


def beds_csv(rows: list[dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue().encode()


def test_csv_file(backend: Backend) -> None:
    src = backend.add_source("qa csv", "csv_file", {}, {})
    up = backend.api(
        "POST", f"/api/sources/{src['id']}/upload", 201, files={"file": ("beds.csv", beds_csv(BEDS), "text/csv")}
    )
    assert up["rows"] == 10, up
    assert all_green(backend.api("POST", f"/api/sources/{src['id']}/test", 200))
    ds = [d["name"] for d in backend.api("GET", f"/api/sources/{src['id']}/datasets", 200)]
    assert "beds.csv" in ds, ds
    assert backend.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": "beds.csv"})
    site = backend.add_site("qa csv site", ["ICU", "Ward 4"])
    backend.add_mapping(site["id"], src["id"], "beds.csv", BEDS_CONFIG)
    check_first_snapshot(backend, site["id"])
    rows = [dict(b) for b in BEDS]

    def change(i: int) -> tuple[str, str]:
        rows[i % 10]["status"] = f"s{i}"
        backend.api(
            "POST", f"/api/sources/{src['id']}/upload", 201, files={"file": ("beds.csv", beds_csv(rows), "text/csv")}
        )
        return rows[i % 10]["bed_id"], f"s{i}"

    lat = measure(backend, site["id"], change)
    check_delete(
        backend,
        site["id"],
        lambda: (
            backend.api(
                "POST",
                f"/api/sources/{src['id']}/upload",
                201,
                files={"file": ("beds.csv", beds_csv(rows[:9]), "text/csv")},
            ),
            "B10",
        )[1],
    )
    record(f"e2e/csv_file/{'redis' if backend.redis_prefix else 'memory'}", **latency_summary(lat))


# --------------------------------------------------------------------------
# s3_files (moto server)
# --------------------------------------------------------------------------


def test_s3_files(backend: Backend) -> None:
    import boto3
    from botocore.config import Config
    from moto.server import ThreadedMotoServer

    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    try:
        host, port = server.get_host_and_port()
        url = f"http://{host}:{port}"
        bucket = f"qa-{os.urandom(4).hex()}"
        s3 = boto3.client(
            "s3",
            endpoint_url=url,
            region_name="us-east-1",
            aws_access_key_id="test",
            aws_secret_access_key="test",
            config=Config(s3={"addressing_style": "path"}),
        )
        s3.create_bucket(Bucket=bucket)
        s3.put_object(Bucket=bucket, Key="exports/beds.csv", Body=beds_csv(BEDS))
        settings = {
            "bucket": bucket,
            "prefix": "exports",
            "endpoint_url": url,
            "encryption": "off",
            "region": "us-east-1",
        }
        src, site, m, ds = connect_and_map(
            backend, "s3_files", settings, {"access_key_id": "test", "secret_access_key": "test"}, "beds"
        )
        check_first_snapshot(backend, site["id"])
        rows = [dict(b) for b in BEDS]

        def change(i: int) -> tuple[str, str]:
            rows[i % 10]["status"] = f"s{i}"
            s3.put_object(Bucket=bucket, Key="exports/beds.csv", Body=beds_csv(rows))
            return rows[i % 10]["bed_id"], f"s{i}"

        lat = measure(backend, site["id"], change)
        record(f"e2e/s3_files/{'redis' if backend.redis_prefix else 'memory'}", **latency_summary(lat))
    finally:
        server.stop()


# --------------------------------------------------------------------------
# SQL Server / Oracle: listed honestly, fail gracefully when unreachable
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "type_,settings",
    [
        ("sqlserver", {"host": "127.0.0.1", "port": 1, "database": "x", "user": "u", "encryption": "off"}),
        ("oracle", {"host": "127.0.0.1", "port": 1, "service_name": "x", "user": "u", "encryption": "off"}),
        ("sqlserver", {"host": "no-such-host.invalid", "port": 1433, "database": "x", "user": "u"}),
        pytest.param(
            "oracle",
            {"host": "no-such-host.invalid", "port": 1521, "service_name": "x", "user": "u"},
            marks=pytest.mark.xfail(strict=True, reason="LIVEOPS-47: DNS failure gets the service-name hint"),
        ),
    ],
)
def test_enterprise_unreachable(backend: Backend, type_: str, settings: dict[str, Any]) -> None:
    specs = {s["type"]: s for s in backend.api("GET", "/api/connectors", 200)}
    assert specs[type_]["maturity"] == "needs_real_test"
    src = backend.add_source(f"qa {type_}", type_, settings, {"password": "x"})
    t0 = time.time()
    rep = backend.api("POST", f"/api/sources/{src['id']}/test", 200)
    took = time.time() - t0
    assert rep["ok"] is False
    failed = [s for s in rep["steps"] if not s["ok"]]
    assert failed and failed[0]["hint"], rep
    assert "x" != failed[0]["detail"]  # no secret
    record(
        f"enterprise/{type_}/{settings['host']}",
        took_s=round(took, 2),
        step=failed[0]["name"],
        hint=failed[0]["hint"][:120],
    )
    assert took < 15, "test() must be bounded"
    if settings["host"].endswith(".invalid"):
        assert "service name" not in failed[0]["hint"].lower(), failed[0]["hint"]
