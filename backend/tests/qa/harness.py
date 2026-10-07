"""QA harness: runs the REAL backend (alembic + uvicorn subprocess) against a
temporary portal DB and drives it only through HTTP + WebSocket, like a user.

Everything created carries a random suffix (DBs, roles, MySQL users, Redis key
prefix, data dir) and is removed by ``cleanup()`` so parallel runs never
collide.

Enable with ``LIVEOPS_QA=1`` (these tests are slow and need Postgres 16 with
wal_level=logical, MySQL 8 with ROW binlog and Redis):

    LIVEOPS_QA=1 pytest -q tests/qa -s
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import signal
import socket
import statistics
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
from cryptography.fernet import Fernet

BACKEND_DIR = Path(__file__).resolve().parents[2]
PG_ADMIN = os.environ.get("LIVEOPS_TEST_PG_DSN", "postgresql://postgres:postgres@localhost:5432/postgres")
REDIS_URL = os.environ.get("LIVEOPS_QA_REDIS_URL", "redis://localhost:6379/0")
MYSQL_ADMIN = {"host": "127.0.0.1", "port": 3306, "user": "root", "password": "root"}
RESULTS_FILE = Path(os.environ.get("LIVEOPS_QA_RESULTS", tempfile.gettempdir() + "/liveops_qa_results.jsonl"))

qa = pytest.mark.skipif(os.environ.get("LIVEOPS_QA") != "1", reason="set LIVEOPS_QA=1 to run QA system tests")


def sfx() -> str:
    return uuid.uuid4().hex[:8]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def dsn_for(db: str, user: str | None = None, password: str | None = None) -> str:
    info = psycopg.conninfo.conninfo_to_dict(PG_ADMIN)
    info["dbname"] = db
    if user:
        info["user"], info["password"] = user, password
    return psycopg.conninfo.make_conninfo(**{k: v for k, v in info.items() if v is not None})


def pg_admin_exec(*stmts: str, db: str = "postgres") -> None:
    with psycopg.connect(dsn_for(db), autocommit=True) as c:
        for s in stmts:
            c.execute(s)  # type: ignore[arg-type]


def record(test: str, **numbers: Any) -> None:
    """Append one result line (read by the final report)."""
    RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with RESULTS_FILE.open("a") as f:
        f.write(json.dumps({"test": test, "ts": time.time(), **numbers}) + "\n")
    print(f"[qa] {test}: {numbers}")


def pctl(values: list[float], p: float) -> float | None:
    if not values:
        return None
    v = sorted(values)
    k = max(0, min(len(v) - 1, round(p / 100 * (len(v) - 1))))
    return round(v[k], 1)


def latency_summary(ms: list[float]) -> dict[str, Any]:
    return {
        "n": len(ms),
        "p50_ms": pctl(ms, 50),
        "p95_ms": pctl(ms, 95),
        "max_ms": round(max(ms), 1) if ms else None,
        "mean_ms": round(statistics.fmean(ms), 1) if ms else None,
    }


# --------------------------------------------------------------------------
# Source fixtures
# --------------------------------------------------------------------------


class PgSource:
    """A temp source database + unique read-only role (+ optional REPLICATION/publication)."""

    def __init__(self, *, cdc: bool = False) -> None:
        s = sfx()
        self.db, self.role, self.password = f"qa_src_{s}", f"qa_ro_{s}", f"pw_{s}"
        self.publication = f"qa_pub_{s}" if cdc else None
        pg_admin_exec(f'CREATE DATABASE "{self.db}"', f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.password}'")
        if cdc:
            pg_admin_exec(f"ALTER ROLE {self.role} WITH REPLICATION")
        self.exec(f"GRANT USAGE ON SCHEMA public TO {self.role}")
        self.exec(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO {self.role}")
        if cdc:
            self.exec(f"CREATE PUBLICATION {self.publication} FOR ALL TABLES")
        self.conn = psycopg.connect(dsn_for(self.db), autocommit=True)

    def exec(self, sql: str, params: Any = None) -> None:
        with psycopg.connect(dsn_for(self.db), autocommit=True) as c:
            c.execute(sql, params)  # type: ignore[arg-type]

    def q(self, sql: str, params: Any = None) -> list[tuple[Any, ...]]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)  # type: ignore[arg-type]
            return cur.fetchall() if cur.description else []

    def settings(self) -> dict[str, Any]:
        info = psycopg.conninfo.conninfo_to_dict(PG_ADMIN)
        s: dict[str, Any] = {
            "host": info.get("host", "localhost"),
            "port": int(info.get("port", 5432)),
            "database": self.db,
            "user": self.role,
            "encryption": "off",
        }
        if self.publication:
            s["publication"] = self.publication
        return s

    def terminate_reader(self) -> None:
        pg_admin_exec(
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '{self.role}'",
        )

    def cleanup(self) -> None:
        with contextlib.suppress(Exception):
            self.conn.close()
        # The backend under test may still be reconnecting (runner backoff), and its
        # temporary replication slots only die with their session: retry a few times.
        last: Exception | None = None
        for _ in range(10):
            try:
                pg_admin_exec(
                    f"ALTER ROLE {self.role} NOLOGIN",
                    f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '{self.role}'",
                    f'DROP DATABASE IF EXISTS "{self.db}" WITH (FORCE)',
                    f"DROP ROLE IF EXISTS {self.role}",
                )
                return
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(1)
        print(f"[qa] cleanup of {self.db}/{self.role} failed: {last}")


class MySqlSource:
    def __init__(self) -> None:
        import pymysql

        s = sfx()
        self.db, self.user, self.password = f"qa_src_{s}", f"qa_ro_{s}", f"Pw_{s}!x"
        self._pymysql = pymysql
        self.admin = pymysql.connect(**MYSQL_ADMIN, autocommit=True, charset="utf8mb4")
        self.exec(f"CREATE DATABASE `{self.db}` CHARACTER SET utf8mb4")
        self.exec(f"CREATE USER '{self.user}'@'%' IDENTIFIED BY '{self.password}'")
        self.exec(f"GRANT SELECT ON `{self.db}`.* TO '{self.user}'@'%'")
        self.exec(f"GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '{self.user}'@'%'")

    def exec(self, sql: str, params: Any = None) -> None:
        with self.admin.cursor() as cur:
            cur.execute(sql, params)

    def executemany(self, sql: str, rows: list[Any]) -> None:
        with self.admin.cursor() as cur:
            cur.executemany(sql, rows)

    def settings(self, mode: str) -> dict[str, Any]:
        return {
            "host": "127.0.0.1",
            "port": 3306,
            "database": self.db,
            "user": self.user,
            "mode": mode,
            "encryption": "off",
        }

    def cleanup(self) -> None:
        for s in (f"DROP DATABASE IF EXISTS `{self.db}`", f"DROP USER IF EXISTS '{self.user}'@'%'"):
            with contextlib.suppress(Exception):
                self.exec(s)
        with contextlib.suppress(Exception):
            self.admin.close()


# --------------------------------------------------------------------------
# The backend under test
# --------------------------------------------------------------------------


class Backend:
    def __init__(self, *, redis: bool = False, secret_key: str | None = None) -> None:
        s = sfx()
        self.portal_db = f"qa_portal_{s}"
        self.secret_key = secret_key or Fernet.generate_key().decode()
        self.redis_prefix = f"qa{s}" if redis else None
        self.data_dir = tempfile.mkdtemp(prefix=f"qa-data-{s}-")
        self.log_path = Path(tempfile.mkdtemp(prefix=f"qa-log-{s}-")) / "backend.log"
        self.port = 0
        self.proc: subprocess.Popen[bytes] | None = None
        pg_admin_exec(f'CREATE DATABASE "{self.portal_db}"')

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def ws_base(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    def env(self) -> dict[str, str]:
        url = dsn_for(self.portal_db)
        info = psycopg.conninfo.conninfo_to_dict(url)
        sa_url = (
            f"postgresql+psycopg://{info.get('user')}:{info.get('password')}@{info.get('host', 'localhost')}:"
            f"{info.get('port', 5432)}/{self.portal_db}"
        )
        env = {
            **os.environ,
            "LIVEOPS_DATABASE_URL": sa_url,
            "LIVEOPS_SECRET_KEY": self.secret_key,
            "LIVEOPS_DATA_DIR": self.data_dir,
            "LIVEOPS_LOG_LEVEL": "INFO",
        }
        env.pop("LIVEOPS_REDIS_URL", None)
        if self.redis_prefix:
            env["LIVEOPS_REDIS_URL"] = REDIS_URL
            env["LIVEOPS_REDIS_KEY_PREFIX"] = self.redis_prefix
        return env

    def alembic(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["alembic", *args], cwd=BACKEND_DIR, env=self.env(), capture_output=True, text=True, check=False
        )

    def start(self, *, migrate: bool = True, wait: bool = True) -> None:
        if migrate:
            r = self.alembic("upgrade", "head")
            assert r.returncode == 0, r.stderr
        self.port = free_port()
        log = self.log_path.open("ab")
        self.proc = subprocess.Popen(
            ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(self.port)],
            cwd=BACKEND_DIR,
            env=self.env(),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        if wait:
            self.wait_ready()

    def wait_ready(self, timeout: float = 60) -> None:
        until = time.time() + timeout
        while time.time() < until:
            assert self.proc is not None
            if self.proc.poll() is not None:
                raise RuntimeError(f"backend exited ({self.proc.returncode}); log:\n{self.log_tail()}")
            with contextlib.suppress(Exception):
                if httpx.get(self.base + "/api/health", timeout=2).status_code == 200:
                    return
            time.sleep(0.3)
        raise RuntimeError(f"backend didn't start; log:\n{self.log_tail()}")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait(5)
        self.proc = None

    def restart(self) -> None:
        self.stop()
        self.start(migrate=False)

    def pid(self) -> int:
        assert self.proc is not None
        return self.proc.pid

    def log_tail(self, n: int = 60) -> str:
        try:
            return "\n".join(self.log_path.read_text(errors="replace").splitlines()[-n:])
        except FileNotFoundError:
            return ""

    def cleanup(self) -> None:
        self.stop()
        with contextlib.suppress(Exception):
            pg_admin_exec(f'DROP DATABASE IF EXISTS "{self.portal_db}" WITH (FORCE)')
        shutil.rmtree(self.data_dir, ignore_errors=True)
        if self.redis_prefix:
            with contextlib.suppress(Exception):
                import redis

                r = redis.Redis.from_url(REDIS_URL)
                keys = list(r.scan_iter(match=f"{self.redis_prefix}*", count=1000))
                if keys:
                    r.delete(*keys)

    # -- HTTP -------------------------------------------------------------

    def api(self, method: str, path: str, expect: int | None = None, **kw: Any) -> Any:
        r = httpx.request(method, self.base + path, timeout=60, **kw)
        if expect is not None:
            assert r.status_code == expect, f"{method} {path} -> {r.status_code}: {r.text[:500]}"
        if not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            return r.text

    def add_source(self, name: str, type_: str, settings: dict[str, Any], secrets: dict[str, Any]) -> dict[str, Any]:
        return self.api(
            "POST",
            "/api/sources",
            201,
            json={"name": name, "type": type_, "settings": settings, "secrets": secrets},
        )

    def add_site(self, name: str, zones: list[str] | None = None) -> dict[str, Any]:
        layout = {
            "zones": [
                {"id": f"z{i}", "name": z, "x": i * 12, "y": 0, "w": 10, "h": 10} for i, z in enumerate(zones or [])
            ]
        }
        return self.api("POST", "/api/sites", 201, json={"name": name, "layout": layout})

    def add_mapping(
        self, site_id: str, source_id: str, dataset: str, config: dict[str, Any], options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"site_id": site_id, "source_id": source_id, "dataset": dataset, "config": config}
        if options is not None:
            body["options"] = options
        return self.api("POST", "/api/mappings", 201, json=body)

    def mapping_health(self, mapping_id: str) -> dict[str, Any] | None:
        for h in self.api("GET", "/api/health/mappings", 200):
            if h["mapping_id"] == mapping_id:
                return h
        return None

    def assets(self, site_id: str) -> dict[str, dict[str, Any]]:
        return {a["asset_id"]: a for a in self.api("GET", f"/api/sites/{site_id}/assets", 200)}

    def wait_assets(
        self, site_id: str, pred: Callable[[dict[str, dict[str, Any]]], bool], timeout: float = 30
    ) -> dict[str, dict[str, Any]]:
        until = time.time() + timeout
        a: dict[str, dict[str, Any]] = {}
        while time.time() < until:
            a = self.assets(site_id)
            if pred(a):
                return a
            time.sleep(0.25)
        raise AssertionError(f"assets never matched; last={json.dumps(a)[:800]}\nlog:\n{self.log_tail(30)}")


# --------------------------------------------------------------------------
# WebSocket collector (runs in its own thread with its own loop)
# --------------------------------------------------------------------------


class WsCollector:
    """Subscribes to /ws/sites/{id}; keeps every asset seen with its receive time."""

    def __init__(self, ws_url: str) -> None:
        self.url = ws_url
        self.messages: list[tuple[float, dict[str, Any]]] = []
        self.lock = threading.Lock()
        self.state: dict[str, dict[str, Any]] = {}
        self.cond = threading.Condition(self.lock)
        self._stop = threading.Event()
        self.closed_code: int | None = None
        self.thread = threading.Thread(target=self._thread, daemon=True)
        self.thread.start()
        self.wait(lambda m: any(x["type"] == "snapshot" for _, x in m), 20)

    def _thread(self) -> None:
        asyncio.run(self._run())

    async def _run(self) -> None:
        import websockets

        try:
            async with websockets.connect(self.url, max_size=None, open_timeout=10) as ws:
                while not self._stop.is_set():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), 0.5)
                    except TimeoutError:
                        continue
                    now = time.time()
                    msg = json.loads(raw)
                    with self.cond:
                        self.messages.append((now, msg))
                        if msg["type"] == "snapshot":
                            self.state = {a["asset_id"]: a for a in msg["assets"]}
                        elif msg["type"] == "upsert":
                            for a in msg["assets"]:
                                self.state[a["asset_id"]] = a
                        elif msg["type"] == "remove":
                            for a in msg["assets"]:
                                self.state.pop(a["asset_id"], None)
                        self.cond.notify_all()
        except Exception as e:  # noqa: BLE001
            code = getattr(getattr(e, "rcvd", None), "code", None)
            with self.cond:
                self.closed_code = code if code is not None else -1
                self.cond.notify_all()

    def wait(self, pred: Callable[[list[tuple[float, dict[str, Any]]]], bool], timeout: float) -> None:
        with self.cond:
            ok = self.cond.wait_for(lambda: pred(self.messages) or self.closed_code is not None, timeout)
        if not ok or (self.closed_code is not None and not pred(self.messages)):
            raise AssertionError(f"WS condition not met in {timeout}s (closed={self.closed_code})")

    def mark(self) -> int:
        with self.lock:
            return len(self.messages)

    def wait_asset(
        self, asset_id: str, pred: Callable[[dict[str, Any]], bool], timeout: float = 30, since: int | None = None
    ) -> float:
        """Return the receive time of the first upsert for asset_id matching pred
        (looking only at messages after ``since``, default: from now on)."""
        start = self.mark() if since is None else since
        hit: list[float] = []

        def check(msgs: list[tuple[float, dict[str, Any]]]) -> bool:
            for t, m in msgs[start:]:
                if m["type"] == "upsert":
                    for a in m["assets"]:
                        if a["asset_id"] == asset_id and pred(a):
                            hit.append(t)
                            return True
            return False

        self.wait(check, timeout)
        return hit[0]

    def wait_removed(self, asset_id: str, timeout: float = 30, since: int | None = None) -> float:
        start = self.mark() if since is None else since
        hit: list[float] = []

        def check(msgs: list[tuple[float, dict[str, Any]]]) -> bool:
            for t, m in msgs[start:]:
                if m["type"] == "remove" and any(a["asset_id"] == asset_id for a in m["assets"]):
                    hit.append(t)
                    return True
            return False

        self.wait(check, timeout)
        return hit[0]

    def snapshot_state(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return {k: dict(v) for k, v in self.state.items()}

    def close(self) -> None:
        self._stop.set()
        self.thread.join(5)


BEDS_CONFIG = {
    "id_field": "bed_id",
    "fields": {"zone": "unit", "state": "status", "label": "bed_label"},
    "state_map": {"occupied": "in_use"},
    "attributes": ["patient_count"],
    "kind": "bed",
}


def all_green(report: dict[str, Any]) -> bool:
    return bool(report.get("ok")) and all(s["ok"] for s in report["steps"])
