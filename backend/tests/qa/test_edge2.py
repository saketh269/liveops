"""QA round 2 (qa-edge): upgrades, configuration and edge cases.

Everything goes through the real backend (alembic + uvicorn subprocess) like
the round-1 harness. Enable with LIVEOPS_QA=1:

    LIVEOPS_QA=1 pytest -q tests/qa/test_edge2.py -s

The upgrade test needs a checkout of the ``main`` branch (Sprint 0); point
``LIVEOPS_QA_MAIN_BACKEND`` at its ``backend/`` folder, e.g.

    git worktree add --detach /tmp/qa-edge/main main
    LIVEOPS_QA_MAIN_BACKEND=/tmp/qa-edge/main/backend
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
from cryptography.fernet import Fernet

from tests.qa.harness import (
    BEDS_CONFIG,
    Backend,
    PgSource,
    WsCollector,
    all_green,
    dsn_for,
    free_port,
    pg_admin_exec,
    qa,
    record,
)
from tests.qa.test_connectors_e2e import _pg_beds, beds_csv

pytestmark = qa

MAIN_BACKEND = os.environ.get("LIVEOPS_QA_MAIN_BACKEND", "/tmp/qa-edge/main/backend")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


class DirBackend(Backend):
    """A Backend that runs from another checkout (e.g. the ``main`` branch)."""

    def __init__(self, backend_dir: str | Path, **kw: Any) -> None:
        super().__init__(**kw)
        self.backend_dir = Path(backend_dir)
        self.extra_env: dict[str, str | None] = {}

    def env(self) -> dict[str, str]:
        env = super().env()
        for k, v in self.extra_env.items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        return env

    def alembic(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["alembic", *args], cwd=self.backend_dir, env=self.env(), capture_output=True, text=True, check=False
        )

    def start(self, *, migrate: bool = True, wait: bool = True) -> None:
        if migrate:
            r = self.alembic("upgrade", "head")
            assert r.returncode == 0, r.stderr
        self.port = free_port()
        log = self.log_path.open("ab")
        self.proc = subprocess.Popen(
            [
                "uvicorn",
                "app.main:app",
                "--app-dir",
                str(self.backend_dir),
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
            ],
            cwd=self.backend_dir,
            env=self.env(),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        if wait:
            self.wait_ready()


HERE = Path(__file__).resolve().parents[2]


def wait_health(be: Backend, mapping_id: str, pred: Any, timeout: float = 60) -> dict[str, Any]:
    until = time.time() + timeout
    h: dict[str, Any] | None = None
    while time.time() < until:
        h = be.mapping_health(mapping_id)
        if h and pred(h):
            return h
        time.sleep(0.5)
    raise AssertionError(f"health never matched: {h}\n{be.log_tail(20)}")


def raw(be: Backend, method: str, path: str, **kw: Any) -> tuple[int, str]:
    r = httpx.request(method, be.base + path, timeout=30, **kw)
    return r.status_code, r.text[:400]


def try_start(be: Backend, timeout: float = 30) -> tuple[bool, str]:
    try:
        be.start(migrate=False, wait=False)
        be.wait_ready(timeout)
        return True, ""
    except (RuntimeError, AssertionError) as e:
        return False, str(e)[-1500:]


@pytest.fixture
def backend() -> Iterator[Backend]:
    be = Backend()
    try:
        be.start()
        yield be
    finally:
        be.cleanup()


@pytest.fixture
def pg() -> Iterator[PgSource]:
    s = PgSource()
    try:
        _pg_beds(s)
        yield s
    finally:
        s.cleanup()


def pg_source(be: Backend, pg: PgSource, type_: str = "postgres", name: str | None = None) -> dict[str, Any]:
    return be.add_source(name or f"qa {type_}", type_, pg.settings(), {"password": pg.password})


def csv_source(be: Backend, rows: list[dict[str, Any]] | bytes, name: str = "qa csv") -> dict[str, Any]:
    src = be.add_source(name, "csv_file", {}, {})
    body = rows if isinstance(rows, bytes) else beds_csv(rows)
    be.api("POST", f"/api/sources/{src['id']}/upload", 201, files={"file": ("data.csv", body, "text/csv")})
    return src


def dataset_of(be: Backend, src: dict[str, Any]) -> str:
    return be.api("GET", f"/api/sources/{src['id']}/datasets", 200)[0]["name"]


# --------------------------------------------------------------------------
# 1. Upgrade path: Sprint 0 (main) -> integration
# --------------------------------------------------------------------------


def test_upgrade_from_sprint0_main(pg: PgSource) -> None:
    if not (Path(MAIN_BACKEND) / "app").is_dir():
        pytest.skip(f"no main checkout at {MAIN_BACKEND}")
    old = DirBackend(MAIN_BACKEND)
    try:
        # --- Sprint 0 (main): create data through main's own API
        old.start()
        assert old.alembic("current").stdout.strip().startswith("0001")
        src = pg_source(old, pg, name="Beds DB ✓")
        site = old.add_site("Hôpital — מחלקה 4", ["ICU", "Ward 4"])
        m = old.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
        paused = old.add_mapping(site["id"], src["id"], "public.beds", {"id_field": "bed_id"}, {"poll_interval_s": 1})
        old.api("PUT", f"/api/mappings/{paused['id']}", 200, json={"active": False})
        old.wait_assets(site["id"], lambda a: len(a) == 10)
        before = {
            "sources": old.api("GET", "/api/sources", 200),
            "sites": old.api("GET", "/api/sites", 200),
            "mappings": old.api("GET", "/api/mappings", 200),
        }
        old.stop()

        # --- integration: same DB, same key; what `docker compose up --build` does
        new = Backend(secret_key=old.secret_key)
        pg_admin_exec(f'DROP DATABASE IF EXISTS "{new.portal_db}"')
        new.portal_db = old.portal_db  # reuse the Sprint 0 database
        shutil.rmtree(new.data_dir, ignore_errors=True)
        new.data_dir = old.data_dir
        r = new.alembic("upgrade", "head")
        assert r.returncode == 0, r.stderr
        cur = new.alembic("current").stdout.strip()
        new.start(migrate=False)
        after_sources = new.api("GET", "/api/sources", 200)
        after_sites = new.api("GET", "/api/sites", 200)
        after_maps = new.api("GET", "/api/mappings", 200)
        assert [(s["id"], s["name"], s["settings"]) for s in after_sources] == [
            (s["id"], s["name"], s["settings"]) for s in before["sources"]
        ]
        assert after_sources[0]["secrets_set"] == {"password": True}
        assert [(s["id"], s["name"], s["layout"]) for s in after_sites] == [
            (s["id"], s["name"], s["layout"]) for s in before["sites"]
        ]
        by_id = {x["id"]: x for x in after_maps}
        assert by_id[m["id"]]["active"] and by_id[m["id"]]["running"]
        assert not by_id[paused["id"]]["active"] and not by_id[paused["id"]]["running"]
        assert by_id[m["id"]]["config"] == before["mappings"][0]["config"]
        assert all_green(new.api("POST", f"/api/sources/{src['id']}/test", 200))  # secret decrypts
        new.wait_assets(site["id"], lambda a: len(a) == 10 and a["B01"].get("zone") == "ICU", 30)
        pg.exec("UPDATE beds SET status='occupied' WHERE bed_id='B03'")
        new.wait_assets(site["id"], lambda a: a["B03"].get("state") == "in_use", 15)  # mapping resumed
        # resume the paused one
        new.api("PUT", f"/api/mappings/{paused['id']}", 200, json={"active": True})
        wait_health(new, paused["id"], lambda h: h["status"] == "running", 20)
        new.stop()

        # --- documented round trip: downgrade base drops every table (data is gone)
        d = new.alembic("downgrade", "base")
        with psycopg.connect(dsn_for(old.portal_db)) as c:
            tables = [t for (t,) in c.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")]
        u = new.alembic("upgrade", "head")
        new.start(migrate=False)
        empty = (new.api("GET", "/api/sources", 200), new.api("GET", "/api/sites", 200))
        record(
            "edge2/upgrade_from_main",
            alembic_current_after_upgrade=cur,
            sources=len(after_sources),
            sites=len(after_sites),
            mappings=len(after_maps),
            downgrade_rc=d.returncode,
            tables_after_downgrade=sorted(tables),
            upgrade_again_rc=u.returncode,
            data_after_roundtrip=[len(x) for x in empty],
        )
        assert d.returncode == 0 and u.returncode == 0
        assert tables == ["alembic_version"]
        assert empty == ([], [])  # downgrade is destructive by design (0001 drops the tables)
        new.stop()
    finally:
        old.cleanup()


# --------------------------------------------------------------------------
# 2. Secret key change end to end (LIVEOPS-41)
# --------------------------------------------------------------------------


def test_secret_key_change_end_to_end(pg: PgSource) -> None:
    be = Backend()
    try:
        be.start()
        src = pg_source(be, pg)
        site = be.add_site("qa key change", ["ICU", "Ward 4"])
        m = be.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        be.stop()

        be.secret_key = Fernet.generate_key().decode()  # someone regenerated .env
        t0 = time.time()
        started, log = try_start(be)
        res: dict[str, Any] = {"started": started, "startup_s": round(time.time() - t0, 1)}
        assert started, log
        for method, path in (
            ("GET", "/api/sources"),
            ("GET", f"/api/sources/{src['id']}"),
            ("POST", f"/api/sources/{src['id']}/test"),
            ("GET", f"/api/sources/{src['id']}/datasets"),
            ("GET", "/api/mappings"),
            ("PUT", f"/api/mappings/{m['id']}"),
        ):
            kw = {"json": {"active": True}} if method == "PUT" else {}
            res[f"{method} {path.replace(src['id'], '{sid}').replace(m['id'], '{mid}')}"] = raw(be, method, path, **kw)
        h = be.mapping_health(m["id"])
        res["health"] = h
        # Rename without re-entering the password: must say "re-enter", not 500
        res["PUT name only"] = raw(be, "PUT", f"/api/sources/{src['id']}", json={"name": "renamed"})
        # Re-enter the password
        res["PUT password"] = raw(be, "PUT", f"/api/sources/{src['id']}", json={"secrets": {"password": pg.password}})
        h2 = wait_health(be, m["id"], lambda x: x["status"] == "running", 30)
        pg.exec("UPDATE beds SET status='cleaning' WHERE bed_id='B02'")
        be.wait_assets(site["id"], lambda a: a.get("B02", {}).get("state") == "cleaning", 15)
        res["after"] = {"health": h2["status"], "list": raw(be, "GET", "/api/sources")[0]}
        record("edge2/secret_key_change", **{k: v for k, v in res.items()})
        assert h and h["status"] == "error" and h["last_error_hint"]
        for k, v in res.items():
            if isinstance(v, tuple):
                assert v[0] < 500, (k, v)
        assert res["PUT password"][0] == 200 and res["after"]["health"] == "running"
        # The UI lists sources and opens one to re-enter the password: both must work.
        assert res["GET /api/sources"][0] == 200 and res["GET /api/sources/{sid}"][0] == 200
    finally:
        be.cleanup()


# --------------------------------------------------------------------------
# 3. Configuration
# --------------------------------------------------------------------------


def test_config_missing_secret_key(pg: PgSource) -> None:
    be = DirBackend(HERE)
    try:
        be.start()
        src = pg_source(be, pg)
        site = be.add_site("qa no key", [])
        m = be.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
        be.stop()
        be.extra_env["LIVEOPS_SECRET_KEY"] = None
        be.secret_key = ""
        started, log = try_start(be)
        res: dict[str, Any] = {"started_without_key": started}
        if started:
            res["health"] = be.mapping_health(m["id"])
            res["create_source"] = raw(
                be,
                "POST",
                "/api/sources",
                json={"name": "x", "type": "postgres", "settings": pg.settings(), "secrets": {"password": "p"}},
            )
            res["list_sources"] = raw(be, "GET", "/api/sources")
        res["log_mentions_key"] = "LIVEOPS_SECRET_KEY" in be.log_tail(80)
        record("edge2/config_missing_secret_key", **res)
        assert started
        assert res["create_source"][0] == 409 and "LIVEOPS_SECRET_KEY" in res["create_source"][1]
        assert res["log_mentions_key"]
    finally:
        be.cleanup()


def test_config_invalid_secret_key() -> None:
    be = DirBackend(HERE, secret_key="not-a-fernet-key")
    try:
        started, log = try_start(be) if be.alembic("upgrade", "head").returncode == 0 else (False, "alembic")
        res = {"started": started}
        if started:
            res["create_source"] = raw(
                be, "POST", "/api/sources", json={"name": "x", "type": "csv_file", "settings": {}, "secrets": {}}
            )
        record("edge2/config_invalid_secret_key", **res, log=be.log_tail(6))
        assert started
        assert res["create_source"][0] < 500, f"malformed LIVEOPS_SECRET_KEY gives a bare 500: {res}"
    finally:
        be.cleanup()


def test_config_wrong_database_url() -> None:
    be = DirBackend(HERE)
    try:
        bad = f"postgresql+psycopg://postgres:postgres@127.0.0.1:{free_port()}/nope"
        be.extra_env["LIVEOPS_DATABASE_URL"] = bad
        a = be.alembic("upgrade", "head")
        started, log = try_start(be, 40)
        alembic_tail = a.stderr.strip().splitlines()[-1:] if a.stderr else []
        record(
            "edge2/config_wrong_database_url",
            alembic_rc=a.returncode,
            alembic_last_line=alembic_tail,
            started=started,
            startup_tail=log.splitlines()[-3:],
        )
        assert a.returncode != 0 and not started
        assert "Connection refused" in a.stderr or "connection" in a.stderr.lower()
    finally:
        be.cleanup()


def test_config_allowed_hosts_override() -> None:
    out: dict[str, Any] = {}
    for label, value in (
        ("plain", "myserver.example"),
        ("json", '["myserver.example"]'),
        ("json+defaults", '["myserver.example","localhost","127.0.0.1"]'),
    ):
        be = DirBackend(HERE)
        try:
            be.extra_env["LIVEOPS_ALLOWED_HOSTS"] = value
            be.alembic("upgrade", "head")
            be.start(migrate=False, wait=False)
            time.sleep(4)
            alive = be.proc is not None and be.proc.poll() is None
            res: dict[str, Any] = {"alive": alive}
            if alive:
                for host in ("myserver.example", "localhost", "127.0.0.1"):
                    with contextlib.suppress(Exception):
                        res[host] = httpx.get(be.base + "/api/health", headers={"Host": host}, timeout=5).status_code
            else:
                res["log"] = be.log_tail(3)
            out[label] = res
        finally:
            be.cleanup()
    record("edge2/config_allowed_hosts", **out)
    assert out["json"]["alive"] and out["json"]["myserver.example"] == 200
    # With only the server's name, the docker healthcheck (Host: localhost) and the
    # nginx proxy (Host: localhost) are refused.
    assert out["json+defaults"]["localhost"] == 200
    # Expected: a plain host name works and adding a host keeps this computer's names.
    assert out["plain"]["alive"], "LIVEOPS_ALLOWED_HOSTS=myserver crashes startup (needs a JSON list)"
    assert out["json"]["localhost"] == 200, "override drops localhost: docker healthcheck + nginx proxy get 400"


class OwnRedis:
    """A private redis-server on a random port (never the shared one)."""

    def __init__(self) -> None:
        self.port = free_port()
        self.dir = tempfile.mkdtemp(prefix="qa-edge-redis-", dir="/tmp/qa-edge")
        self.proc: subprocess.Popen[bytes] | None = None

    @property
    def url(self) -> str:
        return f"redis://127.0.0.1:{self.port}/0"

    def start(self) -> None:
        self.proc = subprocess.Popen(
            [
                "redis-server",
                "--port",
                str(self.port),
                "--bind",
                "127.0.0.1",
                "--save",
                "",
                "--appendonly",
                "no",
                "--dir",
                self.dir,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        for _ in range(50):
            with contextlib.suppress(Exception):
                import redis

                if redis.Redis.from_url(self.url).ping():
                    return
            time.sleep(0.1)
        raise RuntimeError("redis-server didn't start")

    def kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(5)
        self.proc = None

    def cleanup(self) -> None:
        self.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


@pytest.mark.xfail(strict=True, reason="LIVEOPS-83: Redis down -> bare 500s, /api/health still ok")
def test_config_redis_down_at_startup_and_mid_run(pg: PgSource) -> None:
    os.makedirs("/tmp/qa-edge", exist_ok=True)
    rd = OwnRedis()
    be = DirBackend(HERE)
    be.extra_env["LIVEOPS_REDIS_URL"] = rd.url
    be.extra_env["LIVEOPS_REDIS_KEY_PREFIX"] = "qaedge"
    res: dict[str, Any] = {}
    try:
        # --- Redis down at startup
        be.alembic("upgrade", "head")
        started, log = try_start(be, 30)
        res["start_without_redis"] = started
        res["start_without_redis_log"] = [ln for ln in log.splitlines() if "rror" in ln][-2:]
        be.stop()

        # --- normal run, then Redis dies mid-run
        rd.start()
        be.start(migrate=False)
        src = pg_source(be, pg)
        site = be.add_site("qa redis down", [])
        m = be.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        ws = WsCollector(f"{be.ws_base}/ws/sites/{site['id']}")
        rd.kill()
        pg.exec("UPDATE beds SET status='cleaning' WHERE bed_id='B05'")
        time.sleep(6)
        res["down/health"] = raw(be, "GET", "/api/health")
        res["down/assets"] = raw(be, "GET", f"/api/sites/{site['id']}/assets")[0]
        res["down/sources"] = raw(be, "GET", "/api/sources")[0]
        res["down/mapping_health"] = be.mapping_health(m["id"])
        res["down/ws_closed_code"] = ws.closed_code
        ws.close()

        # --- Redis back (empty, like a restarted container without persistence)
        rd.start()
        t0 = time.time()
        recovered = False
        with contextlib.suppress(AssertionError):
            be.wait_assets(site["id"], lambda a: len(a) == 10 and a["B05"].get("state") == "cleaning", 90)
            recovered = True
        res["recovered_without_restart"] = recovered
        res["recovery_s"] = round(time.time() - t0, 1) if recovered else None
        res["up/mapping_health"] = be.mapping_health(m["id"])
        res["up/health"] = raw(be, "GET", "/api/health")
        record("edge2/redis_down", **res)
        assert recovered, f"map not rebuilt after Redis came back: {res}"
        assert res["down/assets"] < 500 and '"ok":false' in res["down/health"][1].replace(" ", ""), (
            f"Redis down: assets endpoint bare 500 / health says ok: {res}"
        )
    finally:
        be.cleanup()
        rd.cleanup()


# --------------------------------------------------------------------------
# 4. Edge cases through the API
# --------------------------------------------------------------------------


@pytest.mark.xfail(strict=True, reason="LIVEOPS-85: NUL character in a site/source name -> bare 500")
def test_edge_names_long_unicode_and_nul(backend: Backend) -> None:
    res: dict[str, Any] = {}
    emoji200 = "🛏️" * 100  # 200 code points
    res["source_name_200_emoji"] = raw(
        backend, "POST", "/api/sources", json={"name": emoji200, "type": "csv_file", "settings": {}, "secrets": {}}
    )[0]
    res["source_name_201"] = raw(
        backend, "POST", "/api/sources", json={"name": "x" * 201, "type": "csv_file", "settings": {}, "secrets": {}}
    )[0]
    rtl = "מחלקה ٤ — العناية المركزة 🏥"
    zones = [
        {"id": "z1", "name": rtl, "x": 0, "y": 0, "w": 10, "h": 10},
        {"id": "z2", "name": "Z" * 10_000, "x": 12, "y": 0, "w": 10, "h": 10},
    ]
    code, body = raw(backend, "POST", "/api/sites", json={"name": rtl, "layout": {"zones": zones}})
    res["site_rtl"] = code
    sid = httpx.get(backend.base + "/api/sites", timeout=10).json()[0]["id"]
    got = backend.api("GET", f"/api/sites/{sid}", 200)
    res["site_roundtrip"] = got["name"] == rtl and got["layout"]["zones"][0]["name"] == rtl
    res["site_name_201"] = raw(backend, "POST", "/api/sites", json={"name": "s" * 201})[0]
    res["site_name_blank"] = raw(backend, "POST", "/api/sites", json={"name": ""})[0]
    res["site_name_nul"] = raw(backend, "POST", "/api/sites", json={"name": "Ward\u00004"})
    res["source_name_nul"] = raw(
        backend, "POST", "/api/sources", json={"name": "a\u0000b", "type": "csv_file", "settings": {}, "secrets": {}}
    )
    res["zone_name_nul"] = raw(
        backend, "POST", "/api/sites", json={"name": "ok", "layout": {"zones": [{"id": "z", "name": "a\u0000b"}]}}
    )
    res["health_after"] = raw(backend, "GET", "/api/health")[0]
    record("edge2/names", **res)
    assert res["source_name_200_emoji"] == 201 and res["source_name_201"] == 422
    assert res["site_rtl"] == 201 and res["site_roundtrip"]
    assert res["site_name_201"] == 422 and res["site_name_blank"] == 422
    for k in ("site_name_nul", "source_name_nul", "zone_name_nul"):
        assert res[k][0] < 500, f"NUL character in a name gives {res[k]}"


def test_edge_unicode_labels_and_pipe_keys_csv(backend: Backend) -> None:
    rows = [
        {"bed_id": "A|B", "unit": "ICU", "status": "ok", "bed_label": "A pipe B"},
        {"bed_id": "A", "unit": "ICU", "status": "ok", "bed_label": "just A"},
        {"bed_id": "B", "unit": "ICU", "status": "ok", "bed_label": "just B"},
        {"bed_id": "|", "unit": "ICU", "status": "ok", "bed_label": "only a pipe"},
        {"bed_id": "سرير/٢?#", "unit": "العناية", "status": "حر", "bed_label": "שלום 🛏️ 病床"},
        {"bed_id": "x" * 2000, "unit": "ICU", "status": "ok", "bed_label": "long key"},
    ]
    src = csv_source(backend, rows)
    ds = dataset_of(backend, src)
    site = backend.add_site("qa pipes", ["ICU", "العناية"])
    backend.add_mapping(
        site["id"],
        src["id"],
        ds,
        {"id_field": "bed_id", "fields": {"zone": "unit", "state": "status", "label": "bed_label"}},
        {"poll_interval_s": 1},
    )
    a = backend.wait_assets(site["id"], lambda a: len(a) == len(rows), 20)
    ws = WsCollector(f"{backend.ws_base}/ws/sites/{site['id']}")
    snap = ws.snapshot_state()
    ws.close()
    record("edge2/pipe_unicode_keys", assets=len(a), ws_snapshot=len(snap))
    assert set(a) == {r["bed_id"] for r in rows}
    assert a["سرير/٢?#"]["label"] == "שלום 🛏️ 病床" and a["سرير/٢?#"]["zone"] == "العناية"
    assert len(snap) == len(rows)


@pytest.mark.xfail(strict=True, reason="LIVEOPS-86: header-only CSV has no columns, can't be mapped")
def test_edge_empty_csv_header_only(backend: Backend) -> None:
    src = csv_source(backend, b"bed_id,status\n")
    ds = dataset_of(backend, src)
    site = backend.add_site("qa empty csv", [])
    m = backend.add_mapping(
        site["id"], src["id"], ds, {"id_field": "bed_id", "fields": {"state": "status"}}, {"poll_interval_s": 1}
    )
    h = wait_health(backend, m["id"], lambda h: h["status"] in ("running", "error"), 15)
    record("edge2/empty_csv", status=h["status"], error=h["last_error"])
    assert h["status"] == "running" and backend.assets(site["id"]) == {}


def test_edge_poll_row_cap_boundary(backend: Backend, pg: PgSource) -> None:
    pg.exec("CREATE TABLE big (id int PRIMARY KEY, status text)")
    pg.exec("INSERT INTO big SELECT g, 'ok' FROM generate_series(1, 50000) g")
    src = pg_source(backend, pg)
    site = backend.add_site("qa cap", [])
    t0 = time.time()
    m = backend.add_mapping(
        site["id"], src["id"], "public.big", {"id_field": "id", "fields": {"state": "status"}}, {"poll_interval_s": 2}
    )
    backend.wait_assets(site["id"], lambda a: len(a) == 50_000, 180)
    load_s = round(time.time() - t0, 1)
    h0 = wait_health(backend, m["id"], lambda h: h["status"] == "running", 30)
    pg.exec("INSERT INTO big VALUES (50001, 'over')")
    h1 = wait_health(backend, m["id"], lambda h: h["status"] == "error", 30)
    a = backend.assets(site["id"])
    pg.exec("DELETE FROM big WHERE id = 50001")
    pg.exec("UPDATE big SET status='back' WHERE id = 1")
    t1 = time.time()
    backend.wait_assets(site["id"], lambda a: a.get("1", {}).get("state") == "back", 120)
    record(
        "edge2/row_cap_boundary",
        load_50000_s=load_s,
        status_at_50000=h0["status"],
        status_at_50001=h1["status"],
        error=h1["last_error"],
        hint=h1["last_error_hint"],
        assets_kept_while_over_cap=len(a),
        recover_s=round(time.time() - t1, 1),
    )
    assert h1["last_error_hint"] and "50,000" in (h1["last_error"] or "")
    assert len(a) == 50_000  # nothing deleted while over the cap


@pytest.mark.xfail(strict=True, reason="LIVEOPS-84: rows sharing a key collapse silently, last write wins")
def test_edge_duplicate_and_composite_keys(backend: Backend, pg: PgSource) -> None:
    # composite primary key (ward, bed): the mapping can only take ONE id column
    pg.exec("CREATE TABLE ward_beds (ward text, bed int, status text, PRIMARY KEY (ward, bed))")
    pg.exec("INSERT INTO ward_beds VALUES ('A',1,'a1'),('B',1,'b1'),('A',2,'a2')")
    src = pg_source(backend, pg)
    ds = {d["name"]: d for d in backend.api("GET", f"/api/sources/{src['id']}/datasets", 200)}
    site = backend.add_site("qa dup keys", [])
    composite_rejected = raw(
        backend,
        "POST",
        "/api/mappings",
        json={
            "site_id": site["id"],
            "source_id": src["id"],
            "dataset": "public.ward_beds",
            "config": {"id_field": "ward,bed"},
        },
    )[0]  # no way to pick two ID columns
    m = backend.add_mapping(
        site["id"],
        src["id"],
        "public.ward_beds",
        {"id_field": "bed", "fields": {"state": "status"}},
        {"poll_interval_s": 1},
    )
    a = backend.wait_assets(site["id"], lambda a: len(a) >= 2, 15)
    time.sleep(2)
    first = a["1"]["state"]
    # update the row that is NOT shown: it moves to the end of the heap and now wins
    other = "b1" if first == "a1" else "a1"
    pg.exec("UPDATE ward_beds SET status = status || '!' WHERE status = %s", (other,))
    time.sleep(3)
    second = backend.assets(site["id"])["1"]["state"]
    h = backend.mapping_health(m["id"])
    record(
        "edge2/dup_composite_keys",
        pk=ds["public.ward_beds"]["primary_key"],
        composite_id_field=composite_rejected,
        assets=sorted(backend.assets(site["id"])),
        shown_first=first,
        shown_after_other_row_updated=second,
        skipped=h and h["skipped_records"],
        last_error=h and h["last_error"],
    )
    # Three source rows, two assets, and the value of asset "1" depends on which row was written last.
    assert h and (h["skipped_records"] or h["last_error"]), (
        f"rows sharing key '1' silently collapse (shown {first!r} then {second!r}); Health says nothing: {h}"
    )


def test_edge_numeric_vs_string_keys_merge(backend: Backend, pg: PgSource) -> None:
    pg.exec("CREATE TABLE num_k (k int PRIMARY KEY, status text)")
    pg.exec("INSERT INTO num_k VALUES (1,'from-int'),(2,'from-int')")
    pg.exec("CREATE TABLE dec_k (k numeric(10,2) PRIMARY KEY, temp text)")
    pg.exec("INSERT INTO dec_k VALUES (1.00,'from-numeric')")
    pg.exec("CREATE TABLE flt_k (k double precision PRIMARY KEY, extra text)")
    pg.exec("INSERT INTO flt_k VALUES (2,'from-float')")
    src = pg_source(backend, pg)
    csv = csv_source(backend, [{"k": "1", "label": "from-csv"}, {"k": "01", "label": "zero-one"}])
    site = backend.add_site("qa key types", [])
    opts = {"poll_interval_s": 1}
    backend.add_mapping(site["id"], src["id"], "public.num_k", {"id_field": "k", "fields": {"state": "status"}}, opts)
    backend.add_mapping(site["id"], src["id"], "public.dec_k", {"id_field": "k", "attributes": ["temp"]}, opts)
    backend.add_mapping(site["id"], src["id"], "public.flt_k", {"id_field": "k", "attributes": ["extra"]}, opts)
    backend.add_mapping(
        site["id"], csv["id"], dataset_of(backend, csv), {"id_field": "k", "fields": {"label": "label"}}, opts
    )
    a = backend.wait_assets(site["id"], lambda a: len(a) >= 4, 20)
    time.sleep(2)
    a = backend.assets(site["id"])
    record(
        "edge2/numeric_vs_string_keys",
        asset_ids=sorted(a),
        one={k: v for k, v in a.get("1", {}).items() if k in ("state", "label", "attributes")},
    )
    assert a["1"]["state"] == "from-int" and a["1"]["label"] == "from-csv"  # int 1 and "1" merge
    assert a["1"]["attributes"]["temp"] == "from-numeric"  # numeric 1.00 -> 1
    assert "01" in a  # "01" is a different key
    # double precision 2.0 becomes "2.0", which does NOT merge with int 2 (documented here, not filed)
    assert "2.0" in a and "2" in a


def test_edge_delete_site_and_source_with_running_mappings(backend: Backend, pg: PgSource) -> None:
    src = pg_source(backend, pg)
    keep = pg_source(backend, pg, name="other")
    s1, s2 = backend.add_site("qa del site", []), backend.add_site("qa del source", [])
    m1 = backend.add_mapping(s1["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
    m2 = backend.add_mapping(s2["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
    m3 = backend.add_mapping(
        s2["id"],
        keep["id"],
        "public.beds",
        {"id_field": "bed_id", "attributes": ["patient_count"]},
        {"poll_interval_s": 1},
    )
    backend.wait_assets(s1["id"], lambda a: len(a) == 10)
    backend.wait_assets(s2["id"], lambda a: len(a) == 10)
    res: dict[str, Any] = {}
    res["delete_site"] = raw(backend, "DELETE", f"/api/sites/{s1['id']}")[0]
    maps = {m["id"] for m in backend.api("GET", "/api/mappings", 200)}
    res["m1_gone"] = m1["id"] not in maps
    res["s1_assets_after"] = raw(backend, "GET", f"/api/sites/{s1['id']}/assets")
    res["delete_source"] = raw(backend, "DELETE", f"/api/sources/{src['id']}")[0]
    maps = {m["id"] for m in backend.api("GET", "/api/mappings", 200)}
    res["m2_gone"], res["m3_kept"] = m2["id"] not in maps, m3["id"] in maps
    time.sleep(3)
    a2 = backend.assets(s2["id"])
    res["s2_assets"] = len(a2)
    res["s2_state_left"] = sorted({x.get("state") for x in a2.values()}, key=str)
    health_ids = {h["mapping_id"]: h["status"] for h in backend.api("GET", "/api/health/mappings", 200)}
    res["health_m1"], res["health_m2"] = health_ids.get(m1["id"]), health_ids.get(m2["id"])
    pg.exec("UPDATE beds SET status='after-delete' WHERE bed_id='B01'")
    time.sleep(3)
    res["deleted_mapping_still_writes"] = backend.assets(s2["id"]).get("B01", {}).get("state") == "after-delete"
    res["readers_left"] = pg.q(f"SELECT count(*) FROM pg_stat_activity WHERE usename = '{pg.role}'")[0][0]
    record("edge2/delete_site_source", **res)
    assert res["delete_site"] == 204 and res["m1_gone"] and res["s1_assets_after"][1] in ("[]", "")
    assert res["delete_source"] == 204 and res["m2_gone"] and res["m3_kept"]
    assert res["s2_assets"] == 10 and res["s2_state_left"] == [None]  # only m3's attributes remain
    assert not res["deleted_mapping_still_writes"]


def test_edge_100_sites_startup_time(backend: Backend) -> None:
    rows = [{"bed_id": f"B{i:02d}", "unit": "ICU", "status": "vacant", "bed_label": f"Bed {i}"} for i in range(20)]
    src = csv_source(backend, rows)
    ds = dataset_of(backend, src)
    cfg = {"id_field": "bed_id", "fields": {"zone": "unit", "state": "status", "label": "bed_label"}}
    t0 = time.time()
    sites, maps = [], []
    for i in range(100):
        s = backend.add_site(f"site {i:03d}", ["ICU"])
        sites.append(s["id"])
        maps.append(backend.add_mapping(s["id"], src["id"], ds, cfg, {"poll_interval_s": 3})["id"])
    create_s = round(time.time() - t0, 1)
    backend.stop()
    t0 = time.time()
    backend.start(migrate=False)
    ready_s = round(time.time() - t0, 1)
    until = time.time() + 120
    running = 0
    while time.time() < until:
        hs = backend.api("GET", "/api/health/mappings", 200)
        running = sum(1 for h in hs if h["status"] == "running")
        if running == 100:
            break
        time.sleep(0.5)
    all_running_s = round(time.time() - t0, 1)
    t1 = time.time()
    r = httpx.get(backend.base + "/api/mappings", timeout=30)
    list_ms = round((time.time() - t1) * 1000)
    full = sum(1 for sid in sites[::10] if len(backend.assets(sid)) == 20)
    record(
        "edge2/100_sites",
        create_100_s=create_s,
        restart_ready_s=ready_s,
        all_running_s=all_running_s,
        running=running,
        list_mappings_ms=list_ms,
        list_status=r.status_code,
        sampled_sites_full=f"{full}/10",
    )
    assert running == 100 and full == 10
    assert all_running_s < 60
