"""QA 2, 4, 5, 7: multi-source merge, resilience/restart, upgrade + secret key,
edge cases. All through the real backend's HTTP API."""

from __future__ import annotations

import subprocess
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet

from tests.qa.harness import (
    BEDS_CONFIG,
    Backend,
    MySqlSource,
    PgSource,
    WsCollector,
    all_green,
    dsn_for,
    qa,
    record,
)
from tests.qa.test_connectors_e2e import BEDS, _pg_beds, beds_csv

pytestmark = qa


@pytest.fixture
def backend() -> Iterator[Backend]:
    be = Backend()
    try:
        be.start()
        yield be
    finally:
        be.cleanup()


@pytest.fixture
def redis_backend() -> Iterator[Backend]:
    be = Backend(redis=True)
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


@pytest.fixture
def pgcdc() -> Iterator[PgSource]:
    s = PgSource(cdc=True)
    try:
        _pg_beds(s)
        yield s
    finally:
        s.cleanup()


def pg_source(be: Backend, pg: PgSource, type_: str = "postgres") -> dict[str, Any]:
    return be.add_source(f"qa {type_}", type_, pg.settings(), {"password": pg.password})


def wait_health(be: Backend, mapping_id: str, pred: Any, timeout: float = 60) -> dict[str, Any]:
    until = time.time() + timeout
    h: dict[str, Any] | None = None
    while time.time() < until:
        h = be.mapping_health(mapping_id)
        if h and pred(h):
            return h
        time.sleep(0.5)
    raise AssertionError(f"health never matched: {h}")


# --------------------------------------------------------------------------
# 2. Multi-source merge
# --------------------------------------------------------------------------


@pytest.mark.xfail(strict=True, reason="LIVEOPS-44: attributes from two sources overwrite each other")
@pytest.mark.parametrize("store", ["memory", "redis"])
def test_multi_source_merge(store: str, pg: PgSource) -> None:
    be = Backend(redis=store == "redis")
    try:
        be.start()
        beds = pg_source(be, pg)
        hk = be.add_source("qa housekeeping", "csv_file", {}, {})
        rows = [{"bed_id": b["bed_id"], "cleaning": "clean", "cleaner": f"C{i}"} for i, b in enumerate(BEDS)]
        be.api("POST", f"/api/sources/{hk['id']}/upload", 201, files={"file": ("hk.csv", beds_csv(rows), "text/csv")})
        site = be.add_site("qa merge", ["ICU", "Ward 4"])
        m1 = be.add_mapping(
            site["id"], beds["id"], "public.beds", {**BEDS_CONFIG, "match_key": "bed_id"}, {"poll_interval_s": 1}
        )
        m2 = be.add_mapping(
            site["id"],
            hk["id"],
            "hk.csv",
            {
                "id_field": "bed_id",
                "match_key": "bed_id",
                "fields": {"cleaning": "cleaning"},
                "attributes": ["cleaner"],
            },
            {"poll_interval_s": 1},
        )
        a = be.wait_assets(
            site["id"], lambda a: len(a) == 10 and all("cleaning" in x and "state" in x for x in a.values())
        )
        b = a["B01"]
        assert b["state"] == "vacant" and b["zone"] == "ICU" and b["cleaning"] == "clean", b
        assert b["_sources"]["state"] == beds["id"] and b["_sources"]["cleaning"] == hk["id"], b["_sources"]
        attrs_ok = b.get("attributes", {}).get("patient_count") == 0 and b.get("attributes", {}).get("cleaner") == "C0"
        # Removing B01 from housekeeping drops only housekeeping's fields.
        be.api(
            "POST", f"/api/sources/{hk['id']}/upload", 201, files={"file": ("hk.csv", beds_csv(rows[1:]), "text/csv")}
        )
        a = be.wait_assets(site["id"], lambda a: "cleaning" not in a.get("B01", {"cleaning": 1}))
        assert a["B01"]["state"] == "vacant", a["B01"]
        # Pausing the beds mapping clears its fields; housekeeping-only fields stay.
        be.api("PUT", f"/api/mappings/{m1['id']}", 200, json={"active": False})
        a = be.wait_assets(site["id"], lambda a: "B01" not in a and "state" not in a.get("B02", {"state": 1}))
        assert a["B02"]["cleaning"] == "clean"
        record(
            f"merge/{store}", ok=True, attributes_merged=attrs_ok, b01_attributes=b.get("attributes"), m2=m2["id"][:4]
        )
        assert attrs_ok, f"attributes from two sources not merged: {b.get('attributes')} (_sources={b['_sources']})"
    finally:
        be.cleanup()


# --------------------------------------------------------------------------
# 4. Resilience
# --------------------------------------------------------------------------


@pytest.mark.xfail(strict=True, reason="LIVEOPS-45: poll connection errors have no hint")
def test_poll_source_lost_shows_hint_and_recovers(backend: Backend, pg: PgSource) -> None:
    """Source goes away (reader's sessions killed, then permission revoked) -> Health error with a hint -> recovery."""
    src = pg_source(backend, pg)
    site = backend.add_site("qa res", ["ICU"])
    m = backend.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
    backend.wait_assets(site["id"], lambda a: len(a) == 10)
    pg.exec(f"REVOKE SELECT ON beds FROM {pg.role}")
    pg.terminate_reader()
    h = wait_health(backend, m["id"], lambda h: h["status"] == "error", 30)
    h_perm = wait_health(backend, m["id"], lambda h: "readable" in (h["last_error"] or ""), 30)
    pg.exec(f"GRANT SELECT ON beds TO {pg.role}")
    pg.exec("UPDATE beds SET status='back' WHERE bed_id='B01'")
    t0 = time.time()
    backend.wait_assets(site["id"], lambda a: a.get("B01", {}).get("state") == "back", 90)
    recovered = round(time.time() - t0, 1)
    # Source unreachable (wrong port) -> Health error; is there a hint?
    backend.api("PUT", f"/api/sources/{src['id']}", 200, json={"settings": {**pg.settings(), "port": 1}})
    h_down = wait_health(backend, m["id"], lambda h: "refused" in (h["last_error"] or ""), 30)
    record(
        "resilience/postgres_poll",
        killed_error=h["last_error"],
        killed_hint=h["last_error_hint"],
        revoked_error=h_perm["last_error"],
        revoked_hint=h_perm["last_error_hint"],
        recovered_s=recovered,
        unreachable_error=h_down["last_error"],
        unreachable_hint=h_down["last_error_hint"],
    )
    assert h_perm["last_error_hint"]
    assert h["last_error_hint"] and h_down["last_error_hint"], (
        f"Health shows a connection error without a hint: killed={h}, unreachable={h_down}"
    )


def test_cdc_reader_killed_then_recovers(backend: Backend, pgcdc: PgSource) -> None:
    src = pg_source(backend, pgcdc, "postgres_cdc")
    site = backend.add_site("qa res cdc", ["ICU"])
    m = backend.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
    backend.wait_assets(site["id"], lambda a: len(a) == 10)
    pgcdc.terminate_reader()
    h = wait_health(backend, m["id"], lambda h: bool(h["last_error"]), 30)
    pgcdc.exec("UPDATE beds SET status='after-kill' WHERE bed_id='B02'")
    t0 = time.time()
    backend.wait_assets(site["id"], lambda a: a.get("B02", {}).get("state") == "after-kill", 60)
    record(
        "resilience/postgres_cdc_kill",
        error=h["last_error"],
        hint=h["last_error_hint"],
        recovered_s=round(time.time() - t0, 1),
    )
    assert h["last_error_hint"]


@pytest.mark.xfail(strict=True, reason="LIVEOPS-43: CDC doesn't report a dropped table")
def test_cdc_table_dropped_is_reported(backend: Backend, pgcdc: PgSource) -> None:
    src = pg_source(backend, pgcdc, "postgres_cdc")
    site = backend.add_site("qa drop cdc", ["ICU"])
    m = backend.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
    backend.wait_assets(site["id"], lambda a: len(a) == 10)
    pgcdc.exec("DROP TABLE beds")
    time.sleep(10)
    h = backend.mapping_health(m["id"])
    n = len(backend.assets(site["id"]))
    _pg_beds(pgcdc)
    pgcdc.exec("UPDATE beds SET status='recreated' WHERE bed_id='B03'")
    t0 = time.time()
    backend.wait_assets(site["id"], lambda a: a.get("B03", {}).get("state") == "recreated", 60)
    record(
        "resilience/postgres_cdc_drop_recreate",
        status_after_drop=h and h["status"],
        error_after_drop=h and h["last_error"],
        assets_after_drop=n,
        recreate_recovered_s=round(time.time() - t0, 1),
    )
    assert h and h["status"] == "error" and h["last_error_hint"], (
        f"mapped table dropped, but Health says {h and h['status']} and the map still shows {n} assets"
    )


@pytest.mark.xfail(strict=True, reason="LIVEOPS-39: MySQL CDC stalls after the binlog connection drops")
def test_mysql_cdc_connection_killed(backend: Backend) -> None:
    my = MySqlSource()
    try:
        my.exec(
            f"CREATE TABLE `{my.db}`.beds (bed_id VARCHAR(16) PRIMARY KEY, unit VARCHAR(32), "
            "status VARCHAR(64), bed_label VARCHAR(64), patient_count INT)"
        )
        my.executemany(
            f"INSERT INTO `{my.db}`.beds VALUES (%(bed_id)s,%(unit)s,%(status)s,%(bed_label)s,%(patient_count)s)", BEDS
        )
        src = backend.add_source("qa my", "mysql", my.settings("cdc"), {"password": my.password})
        site = backend.add_site("qa my res", ["ICU"])
        m = backend.add_mapping(site["id"], src["id"], f"{my.db}.beds", BEDS_CONFIG)
        backend.wait_assets(site["id"], lambda a: len(a) == 10)
        with my.admin.cursor() as cur:
            cur.execute("SELECT id FROM information_schema.processlist WHERE user=%s", (my.user,))
            ids = [r[0] for r in cur.fetchall()]
        for i in ids:
            my.exec(f"KILL {int(i)}")
        my.exec(f"UPDATE `{my.db}`.beds SET status='after-kill' WHERE bed_id='B02'")
        t0 = time.time()
        backend.wait_assets(site["id"], lambda a: a.get("B02", {}).get("state") == "after-kill", 90)
        h = backend.mapping_health(m["id"])
        record(
            "resilience/mysql_cdc_kill",
            killed=len(ids),
            recovered_s=round(time.time() - t0, 1),
            last_error=h and h["last_error"],
        )
    finally:
        my.cleanup()


@pytest.mark.parametrize(
    "store",
    [
        "memory",
        pytest.param(
            "redis", marks=pytest.mark.xfail(strict=True, reason="LIVEOPS-40: deleted-while-down assets stay in Redis")
        ),
    ],
)
def test_backend_restart_resumes_and_rebuilds(store: str, pgcdc: PgSource) -> None:
    be = Backend(redis=store == "redis")
    try:
        be.start()
        src = pg_source(be, pgcdc, "postgres_cdc")
        site = be.add_site("qa restart", ["ICU"])
        m = be.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        be.stop()
        # Changes while the backend is down: update, insert, DELETE.
        pgcdc.exec("UPDATE beds SET status='while-down' WHERE bed_id='B01'")
        pgcdc.exec("INSERT INTO beds VALUES ('B50','ICU','occupied','Bed 50',1)")
        pgcdc.exec("DELETE FROM beds WHERE bed_id='B10'")
        t0 = time.time()
        be.start(migrate=False)
        a = be.wait_assets(site["id"], lambda a: a.get("B01", {}).get("state") == "while-down" and "B50" in a, 60)
        rebuilt_s = round(time.time() - t0, 1)
        time.sleep(3)
        a = be.assets(site["id"])
        ms = be.api("GET", "/api/mappings", 200)
        ws = WsCollector(f"{be.ws_base}/ws/sites/{site['id']}")
        ws_ids = set(ws.snapshot_state())
        ws.close()
        record(
            f"restart/{store}",
            rebuilt_s=rebuilt_s,
            running=ms[0]["running"],
            b10_still_there="B10" in a,
            ws_has_b10="B10" in ws_ids,
            n_assets=len(a),
        )
        assert ms[0]["running"] and ms[0]["id"] == m["id"]
        assert "B10" not in a, f"B10 deleted at the source while down is still on the map ({store})"
    finally:
        be.cleanup()


# --------------------------------------------------------------------------
# 5. Upgrade + secret key
# --------------------------------------------------------------------------


def _dump_data(be: Backend) -> str:
    r = subprocess.run(
        ["pg_dump", "--data-only", "--exclude-table=alembic_version", dsn_for(be.portal_db)],
        capture_output=True,
        text=True,
        check=True,
    )
    return r.stdout


@pytest.mark.xfail(strict=True, reason="LIVEOPS-41: different secret key -> startup crash / 500s")
def test_upgrade_roundtrip_and_secret_key(pg: PgSource) -> None:
    be = Backend()
    try:
        be.start()
        src = pg_source(be, pg)
        site = be.add_site("qa upgrade", ["ICU", "Ward 4"])
        m = be.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        be.stop()
        # a) re-running "upgrade head" (what docker compose up does on every update) keeps everything
        r = be.alembic("upgrade", "head")
        assert r.returncode == 0, r.stderr
        # b) downgrade base -> upgrade head (schema round-trip); restore the data dump into the new schema
        dump = _dump_data(be)
        r1, r2 = be.alembic("downgrade", "base"), be.alembic("upgrade", "head")
        assert r1.returncode == 0 and r2.returncode == 0, r1.stderr + r2.stderr
        subprocess.run(
            ["psql", dsn_for(be.portal_db), "-v", "ON_ERROR_STOP=1", "-q"],
            input=dump,
            text=True,
            check=True,
            capture_output=True,
        )
        be.start(migrate=False)
        assert be.api("GET", f"/api/sources/{src['id']}", 200)["secrets_set"] == {"password": True}
        assert be.api("GET", f"/api/sites/{site['id']}", 200)["layout"]["zones"]
        assert be.api("GET", "/api/mappings", 200)[0]["running"]
        assert all_green(be.api("POST", f"/api/sources/{src['id']}/test", 200))  # secret decrypts
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        be.stop()
        # c) different secret key
        good = be.secret_key
        be.secret_key = Fernet.generate_key().decode()
        startup: dict[str, Any] = {}
        try:
            be.start(migrate=False)
            startup["started"] = True
        except RuntimeError as e:
            startup["started"] = False
            startup["log"] = str(e)[-600:]
        results: dict[str, Any] = {"backend_started": startup["started"]}
        if startup["started"]:
            for method, path in (
                ("GET", "/api/sources"),
                ("GET", f"/api/sources/{src['id']}"),
                ("POST", f"/api/sources/{src['id']}/test"),
                ("GET", "/api/mappings"),
            ):
                rr = httpx.request(method, be.base + path, timeout=30)
                results[f"{method} {path.replace(src['id'], '{id}')}"] = (rr.status_code, rr.text[:160])
            results["mapping_health"] = be.api("GET", "/api/health/mappings")
        record("upgrade/different_key", **results, startup_log=startup.get("log", "")[-300:])
        be.stop()
        be.secret_key = good
        be.start(migrate=False)
        assert all_green(be.api("POST", f"/api/sources/{src['id']}/test", 200))
        assert startup["started"], f"backend doesn't start with a different LIVEOPS_SECRET_KEY: {startup['log']}"
        assert all(not (isinstance(v, tuple) and v[0] >= 500) for v in results.values()), results
        _ = m
    finally:
        be.cleanup()


# --------------------------------------------------------------------------
# 7. Edge cases
# --------------------------------------------------------------------------


def test_edge_empty_table(backend: Backend, pg: PgSource) -> None:
    pg.exec("CREATE TABLE empty_t (bed_id text PRIMARY KEY, status text)")
    src = pg_source(backend, pg)
    prev = backend.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": "public.empty_t"})
    site = backend.add_site("qa empty", [])
    m = backend.add_mapping(
        site["id"],
        src["id"],
        "public.empty_t",
        {"id_field": "bed_id", "fields": {"state": "status"}},
        {"poll_interval_s": 1},
    )
    time.sleep(3)
    h = backend.mapping_health(m["id"])
    pg.exec("INSERT INTO empty_t VALUES ('E1','ok')")
    backend.wait_assets(site["id"], lambda a: a.get("E1", {}).get("state") == "ok", 15)
    record("edge/empty_table", preview=len(prev), status=h and h["status"])
    assert h and h["status"] == "running"


@pytest.mark.parametrize(
    "type_",
    [
        pytest.param(
            "postgres", marks=pytest.mark.xfail(strict=True, reason="LIVEOPS-42: NULL key stops the poll mapping")
        ),
        "postgres_cdc",
    ],
)
def test_edge_null_and_duplicate_keys(type_: str, backend: Backend, pgcdc: PgSource) -> None:
    # key column that is not the PK: NULLs and duplicates allowed
    pgcdc.exec("CREATE TABLE tags (id serial PRIMARY KEY, tag text, status text)")
    pgcdc.exec("INSERT INTO tags (tag, status) VALUES ('T1','a'),('T2','b'),(NULL,'nokey'),('T2','dup')")
    src = pg_source(backend, pgcdc, type_)
    site = backend.add_site(f"qa null {type_}", [])
    m = backend.add_mapping(
        site["id"], src["id"], "public.tags", {"id_field": "tag", "fields": {"state": "status"}}, {"poll_interval_s": 1}
    )
    time.sleep(6)
    h = backend.mapping_health(m["id"])
    a = backend.assets(site["id"])
    pgcdc.exec("UPDATE tags SET status='a2' WHERE tag='T1'")
    time.sleep(4)
    a2 = backend.assets(site["id"])
    record(
        f"edge/null_dup_key/{type_}",
        status=h and h["status"],
        last_error=h and h["last_error"],
        skipped=h and h["skipped_records"],
        assets=sorted(a),
        t2=a.get("T2", {}).get("state"),
        t1_after_update=a2.get("T1", {}).get("state"),
    )
    assert a2.get("T1", {}).get("state") == "a2", (
        f"one NULL key row stops the whole mapping ({type_}): health={h}, assets={sorted(a2)}"
    )


def test_edge_unicode_and_long_strings(backend: Backend, pgcdc: PgSource) -> None:
    pgcdc.exec("CREATE TABLE uni (bed_id text PRIMARY KEY, status text, label text)")
    long = "x" * 100_000
    rows = [("Bett-ä-01", "belegt ✓", "病床 🛏️ 01"), ("سرير-2", "حر", "שלום"), ("LONG", "ok", long)]
    for r in rows:
        pgcdc.exec("INSERT INTO uni VALUES (%s,%s,%s)", r)
    for type_ in ("postgres", "postgres_cdc"):
        src = pg_source(backend, pgcdc, type_)
        prev = backend.api("GET", f"/api/sources/{src['id']}/preview", 200, params={"dataset": "public.uni"})
        assert {p["bed_id"] for p in prev} == {r[0] for r in rows}
        site = backend.add_site(f"qa uni {type_}", [])
        backend.add_mapping(
            site["id"],
            src["id"],
            "public.uni",
            {"id_field": "bed_id", "fields": {"state": "status", "label": "label"}},
            {"poll_interval_s": 1},
        )
        a = backend.wait_assets(site["id"], lambda a: len(a) == 3, 20)
        assert a["Bett-ä-01"]["label"] == "病床 🛏️ 01" and a["سرير-2"]["state"] == "حر"
        assert len(a["LONG"]["label"]) == 100_000
        ws = WsCollector(f"{backend.ws_base}/ws/sites/{site['id']}")
        mark = ws.mark()
        pgcdc.exec("UPDATE uni SET status='frei ✗' WHERE bed_id='Bett-ä-01'")
        ws.wait_asset("Bett-ä-01", lambda x: x.get("state") == "frei ✗", 15, since=mark)
        ws.close()
        pgcdc.exec("UPDATE uni SET status='belegt ✓' WHERE bed_id='Bett-ä-01'")
    record("edge/unicode_long", ok=True)


@pytest.mark.xfail(strict=True, reason="LIVEOPS-46: poll cap truncates silently")
def test_edge_50k_rows_poll_cap(backend: Backend, pg: PgSource) -> None:
    pg.exec("CREATE TABLE big (id int PRIMARY KEY, status text)")
    pg.exec("INSERT INTO big SELECT g, 'ok' FROM generate_series(1, 50000) g")
    src = pg_source(backend, pg)
    site = backend.add_site("qa big", [])
    t0 = time.time()
    m = backend.add_mapping(
        site["id"], src["id"], "public.big", {"id_field": "id", "fields": {"state": "status"}}, {"poll_interval_s": 3}
    )
    backend.wait_assets(site["id"], lambda a: len(a) == 50_000, 120)
    load_s = round(time.time() - t0, 1)
    pg.exec("UPDATE big SET status='changed' WHERE id=49999")
    t0 = time.time()
    backend.wait_assets(site["id"], lambda a: a["49999"]["state"] == "changed", 60)
    change_s = round(time.time() - t0, 1)
    # Over the cap: 50,001+ rows.
    pg.exec("INSERT INTO big SELECT g, 'over' FROM generate_series(50001, 50100) g")
    time.sleep(12)
    h = backend.mapping_health(m["id"])
    a = backend.assets(site["id"])
    over = [k for k in a if int(k) > 50000]
    record(
        "edge/50k_poll",
        initial_load_s=load_s,
        change_s=change_s,
        assets_after_over_cap=len(a),
        over_cap_rows_on_map=len(over),
        status=h and h["status"],
        last_error=h and h["last_error"],
        hint=h and h["last_error_hint"],
    )
    assert h and (h["last_error"] or len(a) == 50100), (
        f"table has 50,100 rows but map shows {len(a)} and health says nothing: {h}"
    )


@pytest.mark.parametrize(
    "type_",
    [
        "postgres",
        pytest.param(
            "postgres_cdc", marks=pytest.mark.xfail(strict=True, reason="LIVEOPS-43: CDC ignores a renamed table")
        ),
    ],
)
def test_edge_table_renamed_while_mapped(type_: str, backend: Backend, pgcdc: PgSource) -> None:
    src = pg_source(backend, pgcdc, type_)
    site = backend.add_site(f"qa rename {type_}", [])
    m = backend.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG, {"poll_interval_s": 1})
    backend.wait_assets(site["id"], lambda a: len(a) == 10)
    pgcdc.exec("ALTER TABLE beds RENAME TO beds_old")
    pgcdc.exec("UPDATE beds_old SET status='renamed' WHERE bed_id='B01'")
    time.sleep(8)
    h = backend.mapping_health(m["id"])
    a = backend.assets(site["id"])
    record(
        f"edge/rename/{type_}",
        status=h and h["status"],
        last_error=h and h["last_error"],
        hint=h and h["last_error_hint"],
        assets=len(a),
        b01=a.get("B01", {}).get("state"),
    )
    assert h and h["status"] == "error" and h["last_error_hint"], f"renamed table not reported clearly: {h}"
