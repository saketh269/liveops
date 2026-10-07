"""QA round 2 (qa-db): database connectors (postgres, postgres_cdc, mysql cdc + poll).

New coverage: SNAPSHOT_END reconcile after a backend restart (memory + Redis),
reconcile after the source connection is killed, mapping edits leave no ghosts,
NULL keys counted in Health ``skipped_records``, row-cap error + hint in Health,
LIVEOPS-26 (no plaintext auth when TLS is wanted) and LIVEOPS-28 (key change).
"""

from __future__ import annotations

import contextlib
import socket
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from tests.qa.harness import BEDS_CONFIG, Backend, MySqlSource, PgSource, qa, record
from tests.qa.test_connectors_e2e import BEDS, _pg_beds

pytestmark = qa

KINDS = ["postgres", "postgres_cdc", "mysql_cdc", "mysql_poll"]


class Src:
    """One mapped source of any DB kind, with SQL helpers that hide the dialect."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.pg: PgSource | None = None
        self.my: MySqlSource | None = None
        if kind.startswith("postgres"):
            self.pg = PgSource(cdc=kind == "postgres_cdc")
            self.type_, self.dataset_prefix = kind, "public."
        else:
            self.my = MySqlSource()
            self.type_ = "mysql"
            self.dataset_prefix = f"{self.my.db}."

    def table(self, name: str) -> str:
        return name if self.pg else f"`{self.my.db}`.{name}"  # type: ignore[union-attr]

    def exec(self, sql: str, params: Any = None) -> None:
        (self.pg or self.my).exec(sql, params)  # type: ignore[union-attr]

    def create_beds(self) -> None:
        if self.pg:
            _pg_beds(self.pg)
            return
        assert self.my
        self.my.exec(
            f"CREATE TABLE {self.table('beds')} (bed_id VARCHAR(16) PRIMARY KEY, unit VARCHAR(32), "
            "status VARCHAR(64), bed_label VARCHAR(64), patient_count INT)"
        )
        self.my.executemany(
            f"INSERT INTO {self.table('beds')} VALUES (%(bed_id)s,%(unit)s,%(status)s,%(bed_label)s,%(patient_count)s)",
            BEDS,
        )

    def settings(self) -> dict[str, Any]:
        if self.pg:
            return self.pg.settings()
        assert self.my
        return self.my.settings("cdc" if self.kind == "mysql_cdc" else "poll")

    @property
    def password(self) -> str:
        return (self.pg or self.my).password  # type: ignore[union-attr]

    def kill_sessions(self) -> int:
        if self.pg:
            self.pg.terminate_reader()
            return -1
        assert self.my
        with self.my.admin.cursor() as cur:
            cur.execute("SELECT id FROM information_schema.processlist WHERE user=%s", (self.my.user,))
            ids = [r[0] for r in cur.fetchall()]
        for i in ids:
            with contextlib.suppress(Exception):
                self.my.exec(f"KILL {int(i)}")
        return len(ids)

    def add(self, be: Backend) -> dict[str, Any]:
        return be.add_source(f"qa {self.kind}", self.type_, self.settings(), {"password": self.password})

    def cleanup(self) -> None:
        (self.pg or self.my).cleanup()  # type: ignore[union-attr]


@pytest.fixture(params=KINDS)
def src(request: pytest.FixtureRequest) -> Iterator[Src]:
    s = Src(request.param)
    try:
        yield s
    finally:
        s.cleanup()


@pytest.fixture
def backend() -> Iterator[Backend]:
    be = Backend()
    try:
        be.start()
        yield be
    finally:
        be.cleanup()


def wait_health(be: Backend, mapping_id: str, pred: Callable[[dict[str, Any]], bool], timeout: float = 30) -> dict:
    until = time.time() + timeout
    h: dict[str, Any] | None = None
    while time.time() < until:
        h = be.mapping_health(mapping_id)
        if h and pred(h):
            return h
        time.sleep(0.5)
    raise AssertionError(f"health never matched: {h}\nlog:\n{be.log_tail(20)}")


OPTS = {"poll_interval_s": 1}


# --------------------------------------------------------------------------
# SNAPSHOT_END reconcile
# --------------------------------------------------------------------------


@pytest.mark.parametrize("store", ["memory", "redis"])
def test_reconcile_after_restart(store: str, src: Src) -> None:
    """Rows deleted (and changed/inserted) while the backend is stopped are reflected after restart."""
    be = Backend(redis=store == "redis")
    try:
        be.start()
        src.create_beds()
        s = src.add(be)
        site = be.add_site("qa reconcile", ["ICU", "Ward 4"])
        be.add_mapping(site["id"], s["id"], src.dataset_prefix + "beds", BEDS_CONFIG, OPTS)
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        be.stop()
        t = src.table("beds")
        src.exec(f"DELETE FROM {t} WHERE bed_id IN ('B09','B10')")
        src.exec(f"UPDATE {t} SET status='while-down' WHERE bed_id='B01'")
        src.exec(f"INSERT INTO {t} VALUES ('B50','ICU','vacant','Bed 50',0)")
        t0 = time.time()
        be.start(migrate=False)
        a = be.wait_assets(
            site["id"],
            lambda a: "B50" in a and a.get("B01", {}).get("state") == "while-down",
            60,
        )
        time.sleep(3)  # give a late (wrong) re-add a chance to show up
        a = be.assets(site["id"])
        record(
            f"r2/reconcile_restart/{src.kind}/{store}",
            rebuilt_s=round(time.time() - t0 - 3, 1),
            n=len(a),
            ghosts=sorted({"B09", "B10"} & set(a)),
        )
        assert not {"B09", "B10"} & set(a), f"deleted-while-down rows still on the map: {sorted(a)}"
        assert len(a) == 9
    finally:
        be.cleanup()


def test_reconcile_after_session_kill(backend: Backend, src: Src) -> None:
    """Sessions killed + a row deleted right away: after recovery the asset is gone, others intact."""
    src.create_beds()
    s = src.add(backend)
    site = backend.add_site("qa kill", ["ICU", "Ward 4"])
    m = backend.add_mapping(site["id"], s["id"], src.dataset_prefix + "beds", BEDS_CONFIG, OPTS)
    backend.wait_assets(site["id"], lambda a: len(a) == 10)
    t = src.table("beds")
    killed = src.kill_sessions()
    src.exec(f"DELETE FROM {t} WHERE bed_id='B05'")
    src.exec(f"UPDATE {t} SET status='after-kill' WHERE bed_id='B06'")
    t0 = time.time()
    a = backend.wait_assets(site["id"], lambda a: "B05" not in a and a.get("B06", {}).get("state") == "after-kill", 60)
    rec_s = round(time.time() - t0, 1)
    # still live after recovery
    src.exec(f"UPDATE {t} SET status='live-again' WHERE bed_id='B07'")
    backend.wait_assets(site["id"], lambda a: a.get("B07", {}).get("state") == "live-again", 30)
    h = backend.mapping_health(m["id"])
    record(
        f"r2/session_kill/{src.kind}",
        killed=killed,
        recovered_s=rec_s,
        n=len(a),
        status=h and h["status"],
        last_error=h and h["last_error"],
        hint=h and h["last_error_hint"],
    )
    assert len(a) == 9


# --------------------------------------------------------------------------
# Mapping edit: no ghosts
# --------------------------------------------------------------------------


def test_mapping_edit_no_ghosts(backend: Backend, src: Src) -> None:
    src.create_beds()
    s = src.add(backend)
    site = backend.add_site("qa edit", ["ICU", "Ward 4"])
    m = backend.add_mapping(site["id"], s["id"], src.dataset_prefix + "beds", BEDS_CONFIG, OPTS)
    backend.wait_assets(site["id"], lambda a: len(a) == 10 and a["B01"].get("label") == "Bed 01")
    # 1) change the key: id_field bed_label (asset ids "Bed 01".."Bed 10")
    cfg2 = {"id_field": "bed_label", "fields": {"zone": "unit", "state": "status"}, "kind": "bed"}
    backend.api("PUT", f"/api/mappings/{m['id']}", 200, json={"config": cfg2})
    a = backend.wait_assets(site["id"], lambda a: "Bed 01" in a and len(a) == 10, 30)
    time.sleep(2)
    a = backend.assets(site["id"])
    old_ids = sorted(k for k in a if k.startswith("B") and not k.startswith("Bed"))
    b = a.get("Bed 01", {})
    # 2) change only the fields: drop zone, map label again
    cfg3 = {"id_field": "bed_label", "fields": {"state": "status", "label": "bed_id"}, "kind": "bed"}
    backend.api("PUT", f"/api/mappings/{m['id']}", 200, json={"config": cfg3})
    a3 = backend.wait_assets(site["id"], lambda a: a.get("Bed 01", {}).get("label") == "B01", 30)
    time.sleep(2)
    a3 = backend.assets(site["id"])
    # 3) the edited mapping keeps streaming
    src.exec(f"UPDATE {src.table('beds')} SET status='edited' WHERE bed_id='B03'")
    backend.wait_assets(site["id"], lambda a: a.get("Bed 03", {}).get("state") == "edited", 30)
    record(
        f"r2/mapping_edit/{src.kind}",
        ghosts_after_key_change=old_ids,
        n_after_key_change=len(a),
        zone_after_field_change=a3.get("Bed 01", {}).get("zone"),
        n_after_field_change=len(a3),
    )
    assert not old_ids, f"old asset ids left after key change: {old_ids}"
    assert b.get("label") in (None, "Bed 01") and len(a3) == 10
    assert "zone" not in a3["Bed 01"] or a3["Bed 01"]["zone"] in (None, ""), (
        f"unmapped field zone still on asset: {a3['Bed 01']}"
    )


# --------------------------------------------------------------------------
# NULL keys -> skipped_records
# --------------------------------------------------------------------------


def test_null_keys_counted(backend: Backend, src: Src) -> None:
    t = src.table("tags")
    if src.pg:
        src.exec("CREATE TABLE tags (id serial PRIMARY KEY, tag text, status text)")
    else:
        src.exec(f"CREATE TABLE {t} (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(16), status VARCHAR(16))")
    src.exec(f"INSERT INTO {t} (tag, status) VALUES ('T1','a'),(NULL,'n1'),(NULL,'n2'),('T3','c')")
    s = src.add(backend)
    site = backend.add_site("qa nullkey", [])
    m = backend.add_mapping(
        site["id"], s["id"], src.dataset_prefix + "tags", {"id_field": "tag", "fields": {"state": "status"}}, OPTS
    )
    backend.wait_assets(site["id"], lambda a: set(a) == {"T1", "T3"})
    h1 = wait_health(backend, m["id"], lambda h: h["skipped_records"] >= 2, 15)
    # a change event that turns a key into NULL: T3 should disappear, rows still counted
    src.exec(f"UPDATE {t} SET tag=NULL WHERE tag='T3'")
    a = backend.wait_assets(site["id"], lambda a: "T3" not in a, 30)
    src.exec(f"UPDATE {t} SET status='a2' WHERE tag='T1'")
    backend.wait_assets(site["id"], lambda a: a.get("T1", {}).get("state") == "a2", 30)
    time.sleep(2)
    h2 = backend.mapping_health(m["id"])
    record(
        f"r2/null_keys/{src.kind}",
        skipped_initial=h1["skipped_records"],
        skipped_after_key_to_null=h2 and h2["skipped_records"],
        status=h2 and h2["status"],
        assets=sorted(a),
    )
    assert h1["status"] == "running"
    assert h2 and h2["skipped_records"] >= 3, f"key->NULL row not counted: {h2}"


# --------------------------------------------------------------------------
# Row cap -> Health error + hint
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kind",
    [
        "postgres",
        "postgres_cdc",  # LIVEOPS-61 fixed
        "mysql_cdc",  # LIVEOPS-88 fixed
        "mysql_poll",
    ],
)
def test_row_cap_in_health(backend: Backend, kind: str) -> None:
    src = Src(kind)
    try:
        _row_cap(backend, src)
    finally:
        src.cleanup()


def _row_cap(backend: Backend, src: Src) -> None:
    t = src.table("big")
    if src.pg:
        src.exec("CREATE TABLE big (id int PRIMARY KEY, status text)")
        src.exec("INSERT INTO big SELECT g, 'ok' FROM generate_series(1, 50001) g")
    else:
        src.exec(f"CREATE TABLE {t} (id INT PRIMARY KEY, status VARCHAR(8))")
        src.exec("SET SESSION cte_max_recursion_depth = 100000")
        src.exec(
            f"INSERT INTO {t} WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n < 50001) "
            "SELECT n, 'ok' FROM g"
        )
    s = src.add(backend)
    site = backend.add_site("qa cap", [])
    t0 = time.time()
    m = backend.add_mapping(
        site["id"], s["id"], src.dataset_prefix + "big", {"id_field": "id", "fields": {"state": "status"}}, OPTS
    )
    h = wait_health(backend, m["id"], lambda h: bool(h["last_error"]), 90)
    took = round(time.time() - t0, 1)
    time.sleep(3)
    n = len(backend.assets(site["id"]))
    record(
        f"r2/row_cap/{src.kind}",
        took_s=took,
        status=h["status"],
        error=h["last_error"],
        hint=h["last_error_hint"],
        assets_on_map=n,
    )
    assert h["status"] == "error" and "50,000" in h["last_error"], h
    assert h["last_error_hint"], h
    assert n == 0, f"{n} partial assets on the map although the table is over the cap"
    if src.kind.endswith("cdc"):
        assert "poll" not in h["last_error"] and "CDC" not in h["last_error_hint"], f"poll wording on a CDC source: {h}"


# --------------------------------------------------------------------------
# LIVEOPS-28: postgres_cdc key column change (not the PK)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["postgres_cdc", "mysql_cdc"])
def test_key_change_leaves_no_ghost(backend: Backend, kind: str) -> None:
    s = Src(kind)
    try:
        t = s.table("tags")
        if s.pg:
            s.exec("CREATE TABLE tags (id serial PRIMARY KEY, tag text, status text)")  # REPLICA IDENTITY DEFAULT
        else:
            s.exec(f"CREATE TABLE {t} (id INT AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(16), status VARCHAR(16))")
        s.exec(f"INSERT INTO {t} (tag, status) VALUES ('T1','a'),('T2','b')")
        src = s.add(backend)
        site = backend.add_site("qa keychg", [])
        backend.add_mapping(
            site["id"], src["id"], s.dataset_prefix + "tags", {"id_field": "tag", "fields": {"state": "status"}}
        )
        backend.wait_assets(site["id"], lambda a: set(a) == {"T1", "T2"})
        s.exec(f"UPDATE {t} SET tag='T9' WHERE tag='T1'")
        backend.wait_assets(site["id"], lambda a: "T9" in a, 30)
        time.sleep(2)
        a = backend.assets(site["id"])
        record(f"r2/key_change/{kind}", assets=sorted(a))
        assert set(a) == {"T2", "T9"}, f"ghost after key change: {sorted(a)}"
    finally:
        s.cleanup()


# --------------------------------------------------------------------------
# LIVEOPS-26: MySQL "required" must not authenticate without TLS
# --------------------------------------------------------------------------


class StripSslProxy:
    """TCP proxy to MySQL that clears CLIENT_SSL in the server greeting and logs
    whether the client sent anything after the greeting (an auth packet)."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.client_bytes: list[bytes] = []
        self.stop = False
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while not self.stop:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(c,), daemon=True).start()

    def _handle(self, c: socket.socket) -> None:
        u = socket.create_connection(("127.0.0.1", 3306))
        try:
            hdr = u.recv(4, socket.MSG_WAITALL)
            body = bytearray(u.recv(int.from_bytes(hdr[:3], "little"), socket.MSG_WAITALL))
            i = body.index(0, 1) + 1 + 4 + 8 + 1  # proto, version\0, conn id, salt1, filler
            caps = int.from_bytes(body[i : i + 2], "little") & ~0x0800
            body[i : i + 2] = caps.to_bytes(2, "little")
            c.sendall(hdr + bytes(body))
            c.settimeout(5)
            data = c.recv(65536)
            self.client_bytes.append(data)
        except Exception:  # noqa: BLE001
            self.client_bytes.append(b"")
        finally:
            c.close()
            u.close()

    def close(self) -> None:
        self.stop = True
        self.sock.close()


def test_mysql_required_tls_stripped(backend: Backend) -> None:
    my = MySqlSource()
    proxy = StripSslProxy()
    try:
        st = {**my.settings("poll"), "port": proxy.port, "encryption": "required"}
        src = backend.add_source("qa my tls", "mysql", st, {"password": my.password})
        rep = backend.api("POST", f"/api/sources/{src['id']}/test", 200)
        time.sleep(1)
        leaked = [b for b in proxy.client_bytes if my.user.encode() in b]
        failed = [x for x in rep["steps"] if not x["ok"]]
        record(
            "r2/mysql_tls_stripped",
            ok=rep["ok"],
            connections=len(proxy.client_bytes),
            auth_packets_with_user=len(leaked),
            step=failed and failed[0]["name"],
            detail=failed and failed[0]["detail"][:160],
        )
        assert not rep["ok"]
        assert proxy.client_bytes, "proxy saw no connection"
        assert not leaked, "client sent the auth packet (user name) although TLS was not offered"
    finally:
        proxy.close()
        my.cleanup()
