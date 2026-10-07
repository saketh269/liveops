"""QA round 2 (core): multi-source merge, two backend processes on one Redis,
restart rebuild / stale cleanup, load with two viewers, reconcile bursts and
event-log paging. Real uvicorn processes, driven over HTTP + WebSocket only.

    LIVEOPS_QA=1 TMPDIR=/tmp/qa-core pytest -q tests/qa/test_core_r2.py -s
"""

from __future__ import annotations

import os
import random
import signal
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import psutil
import psycopg
import pytest

from tests.qa.harness import (
    BEDS_CONFIG,
    PG_ADMIN,
    Backend,
    PgSource,
    WsCollector,
    dsn_for,
    latency_summary,
    qa,
    record,
    sfx,
)
from tests.qa.test_connectors_e2e import BEDS, _pg_beds, beds_csv, post_signed
from tests.qa.test_load import ProcSampler

pytestmark = qa
RATE = int(os.environ.get("LIVEOPS_QA_RATE", "200"))
DURATION = int(os.environ.get("LIVEOPS_QA_DURATION", "60"))
ASSETS = 2000


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


class PeerBackend(Backend):
    """A second backend process sharing the primary's portal DB, secret key,
    Redis prefix and data dir (a real two-process deployment)."""

    def __init__(self, primary: Backend) -> None:  # noqa: D107 - no DB is created here
        self.portal_db = primary.portal_db
        self.secret_key = primary.secret_key
        self.redis_prefix = primary.redis_prefix
        self.data_dir = primary.data_dir
        self.log_path = Path(tempfile.mkdtemp(prefix=f"qa-log-peer-{sfx()}-")) / "backend.log"
        self.port = 0
        self.proc = None

    def cleanup(self) -> None:
        self.stop()


def kill9(be: Backend) -> None:
    assert be.proc is not None
    os.killpg(be.proc.pid, signal.SIGKILL)
    be.proc.wait(10)
    be.proc = None


def slots(pg: PgSource) -> list[tuple[Any, ...]]:
    """Replication slots on the source DB: (slot_name, active, client_port)."""
    with psycopg.connect(PG_ADMIN, autocommit=True) as c:
        return c.execute(
            "SELECT s.slot_name, s.active, a.client_port FROM pg_replication_slots s"
            " LEFT JOIN pg_stat_activity a ON a.pid = s.active_pid WHERE s.database = %s",
            (pg.db,),
        ).fetchall()


def slot_owner(pg: PgSource, *bes: Backend) -> list[Backend]:
    """Which backend processes hold an active replication connection (by client port)."""
    ports = {r[2] for r in slots(pg) if r[1] and r[2]}
    out = []
    for be in bes:
        if be.proc is None or be.proc.poll() is not None:
            continue
        mine = {c.laddr.port for c in psutil.Process(be.proc.pid).net_connections("tcp") if c.raddr}
        if ports & mine:
            out.append(be)
    return out


def wait_until(pred: Any, timeout: float, what: str, step: float = 0.2) -> float:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return time.time() - t0
        time.sleep(step)
    raise AssertionError(f"timed out after {timeout}s waiting for {what}")


def comparable(state: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {k: {f: v for f, v in a.items() if f != "updated_ts"} for k, a in state.items()}


def resyncs(ws: WsCollector) -> int:
    with ws.lock:
        return sum(1 for _, m in ws.messages if m["type"] == "snapshot") - 1


def page_all(be: Backend, site_id: str, since: float | None, limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    while True:
        params: dict[str, Any] = {"limit": limit}
        if since is not None:
            params["since"] = repr(since)
        page = be.api("GET", f"/api/sites/{site_id}/events", 200, params=params)
        if not page:
            return out
        out += page
        since = page[-1]["ts"]


def paging_problems(entries: list[dict[str, Any]]) -> dict[str, int]:
    ts = [e["ts"] for e in entries]
    return {
        "non_increasing_ts": sum(1 for a, b in zip(ts, ts[1:], strict=False) if b <= a),
        "duplicate_ts": len(ts) - len(set(ts)),
    }


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


def big_table(pg: PgSource, n: int = ASSETS) -> None:
    pg.exec("CREATE TABLE assets (id text PRIMARY KEY, zone text, status text, seq int)")
    pg.exec(f"INSERT INTO assets SELECT 'A'||g, 'Z'||(g%20), 'v0', 0 FROM generate_series(1,{n}) g")


BIG_CONFIG = {"id_field": "id", "fields": {"zone": "zone", "state": "status"}, "attributes": ["seq"]}


# --------------------------------------------------------------------------
# 1. Multi-source merge: postgres + csv + webhook (LIVEOPS-44 regression)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("store", ["memory", "redis"])
def test_merge_three_sources(store: str, pg: PgSource) -> None:
    be = Backend(redis=store == "redis")
    try:
        be.start()
        beds = be.add_source("qa beds", "postgres", pg.settings(), {"password": pg.password})
        hk = be.add_source("qa housekeeping", "csv_file", {}, {})
        hk_rows = [{"bed_id": b["bed_id"], "cleaning": "clean", "cleaner": f"C{i}"} for i, b in enumerate(BEDS)]
        be.api(
            "POST", f"/api/sources/{hk['id']}/upload", 201, files={"file": ("hk.csv", beds_csv(hk_rows), "text/csv")}
        )
        secret = "qa-merge-" + os.urandom(6).hex()
        wh = be.add_source(
            "qa nurse call", "webhook", {"key_field": "bed_id", "dataset_name": "calls"}, {"signing_secret": secret}
        )
        calls = [{"bed_id": b["bed_id"], "call": "none", "badge": f"N{i}"} for i, b in enumerate(BEDS)]
        assert post_signed(be, wh["id"], secret, calls).status_code == 202
        site = be.add_site("qa merge3", ["ICU", "Ward 4"])
        be.add_mapping(
            site["id"], beds["id"], "public.beds", {**BEDS_CONFIG, "match_key": "bed_id"}, {"poll_interval_s": 1}
        )
        be.add_mapping(
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
        be.add_mapping(
            site["id"],
            wh["id"],
            "calls",
            {"id_field": "bed_id", "match_key": "bed_id", "fields": {"call": "call"}, "attributes": ["badge"]},
        )

        def merged(a: dict[str, Any]) -> bool:
            return len(a) == 10 and all(
                {"state", "cleaning", "call"} <= set(x)
                and {"patient_count", "cleaner", "badge"} <= set(x.get("attributes", {}))
                for x in a.values()
            )

        a = be.wait_assets(site["id"], merged, 40)
        b = a["B01"]
        src = b["_sources"]
        assert b["attributes"] == {"patient_count": 0, "cleaner": "C0", "badge": "N0"}, b
        assert src["state"] == beds["id"] and src["cleaning"] == hk["id"] and src["call"] == wh["id"], src
        assert (
            src.get("attributes.patient_count") == beds["id"]
            and src.get("attributes.cleaner") == hk["id"]
            and src.get("attributes.badge") == wh["id"]
        ), src
        ws = WsCollector(f"{be.ws_base}/ws/sites/{site['id']}")
        assert comparable(ws.snapshot_state()) == comparable(be.assets(site["id"]))
        # An attribute update from one source leaves the others' attributes alone.
        pg.exec("UPDATE beds SET patient_count=3 WHERE bed_id='B01'")
        ws.wait_asset("B01", lambda x: x.get("attributes", {}).get("patient_count") == 3, 15, since=0)
        assert ws.snapshot_state()["B01"]["attributes"] == {"patient_count": 3, "cleaner": "C0", "badge": "N0"}
        # Webhook deletes B01 -> only call + badge go.
        assert post_signed(be, wh["id"], secret, {"bed_id": "B01", "_deleted": True}).status_code == 202
        a = be.wait_assets(site["id"], lambda a: "call" not in a.get("B01", {"call": 1}), 15)
        assert a["B01"]["attributes"] == {"patient_count": 3, "cleaner": "C0"}, a["B01"]
        assert a["B01"]["state"] == "vacant" and a["B01"]["cleaning"] == "clean"
        assert "attributes.badge" not in a["B01"]["_sources"], a["B01"]["_sources"]
        # csv drops B01 -> only cleaning + cleaner go.
        be.api(
            "POST",
            f"/api/sources/{hk['id']}/upload",
            201,
            files={"file": ("hk.csv", beds_csv(hk_rows[1:]), "text/csv")},
        )
        a = be.wait_assets(site["id"], lambda a: "cleaning" not in a.get("B01", {"cleaning": 1}), 15)
        assert a["B01"]["attributes"] == {"patient_count": 3}, a["B01"]
        assert set(a["B01"]["_sources"].values()) == {beds["id"]}, a["B01"]["_sources"]
        # postgres deletes B01 -> asset gone everywhere.
        pg.exec("DELETE FROM beds WHERE bed_id='B01'")
        be.wait_assets(site["id"], lambda a: "B01" not in a, 15)
        ws.wait_removed("B01", 10, since=0)
        time.sleep(1)
        assert comparable(ws.snapshot_state()) == comparable(be.assets(site["id"]))
        ws.close()
        record(f"r2/merge3/{store}", ok=True)
    finally:
        be.cleanup()


@pytest.mark.xfail(strict=True, reason="LIVEOPS-92: overwritten shared field is not restored when the winner leaves")
@pytest.mark.parametrize("store", ["memory", "redis"])
def test_merge_shared_field_lost_when_winner_leaves(store: str, pg: PgSource) -> None:
    """Two sources map the same field. The newer one wins; when it removes the
    asset, the field disappears although the other source still has a value."""
    be = Backend(redis=store == "redis")
    try:
        be.start()
        beds = be.add_source("qa beds", "postgres", pg.settings(), {"password": pg.password})
        secret = "qa-shared-" + os.urandom(6).hex()
        wh = be.add_source(
            "qa override", "webhook", {"key_field": "bed_id", "dataset_name": "ov"}, {"signing_secret": secret}
        )
        site = be.add_site("qa shared field", ["ICU", "Ward 4"])
        be.add_mapping(
            site["id"], beds["id"], "public.beds", {**BEDS_CONFIG, "match_key": "bed_id"}, {"poll_interval_s": 1}
        )
        be.wait_assets(site["id"], lambda a: len(a) == 10)
        assert post_signed(be, wh["id"], secret, [{"bed_id": "B01", "label": "Isolation"}]).status_code == 202
        be.add_mapping(
            site["id"], wh["id"], "ov", {"id_field": "bed_id", "match_key": "bed_id", "fields": {"label": "label"}}
        )
        be.wait_assets(site["id"], lambda a: a["B01"].get("label") == "Isolation", 15)
        assert post_signed(be, wh["id"], secret, {"bed_id": "B01", "_deleted": True}).status_code == 202
        a = be.wait_assets(site["id"], lambda a: a["B01"].get("label") != "Isolation", 15)
        time.sleep(3)  # several postgres polls
        a = be.assets(site["id"])
        record(f"r2/merge_shared_field/{store}", b01_label_after=a["B01"].get("label"), pg_label="Bed 01")
        assert a["B01"].get("label") == "Bed 01", (
            f"label after override removed: {a['B01'].get('label')!r} (postgres still has 'Bed 01')"
        )
    finally:
        be.cleanup()


# --------------------------------------------------------------------------
# 2. Two backend processes behind one Redis (LIVEOPS-36 regression)
# --------------------------------------------------------------------------


def test_two_processes_ownership_and_takeover(pgcdc: PgSource) -> None:
    a = Backend(redis=True)
    b = PeerBackend(a)
    writer_stop = threading.Event()
    viewers: list[WsCollector] = []
    try:
        a.start()
        b.start(migrate=False)
        both = (a, b)
        src = a.add_source("qa cdc", "postgres_cdc", pgcdc.settings(), {"password": pgcdc.password})
        site = a.add_site("qa cluster", ["ICU", "Ward 4"])
        m = a.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
        for be in both:
            be.wait_assets(site["id"], lambda x: len(x) == 10, 30)
        # LIVEOPS-79: B booted with no mappings and never joined; restart it so it adopts.
        b.restart()
        wait_until(lambda: len(slots(pgcdc)) == 1 and len(slot_owner(pgcdc, a, b)) == 1, 15, "one slot")
        time.sleep(4)  # > one tick: nobody else starts it
        assert len(slots(pgcdc)) == 1, slots(pgcdc)
        owners = slot_owner(pgcdc, a, b)
        assert len(owners) == 1
        wa, wb = WsCollector(f"{a.ws_base}/ws/sites/{site['id']}"), WsCollector(f"{b.ws_base}/ws/sites/{site['id']}")
        viewers += [wa, wb]
        pgcdc.exec("UPDATE beds SET status='s1' WHERE bed_id='B02'")
        for w in viewers:
            w.wait_asset("B02", lambda x: x.get("state") == "s1", 10, since=0)
        for be in both:
            wait_until(
                lambda be=be: all(x["running"] for x in be.api("GET", "/api/mappings", 200)), 8, "running on both"
            )
        # Pause via B (whoever owns it): gone everywhere, slot released.
        b.api("PUT", f"/api/mappings/{m['id']}", 200, json={"active": False})
        for be in both:
            be.wait_assets(site["id"], lambda x: len(x) == 0, 15)
        wait_until(lambda: len(slots(pgcdc)) == 0, 15, "slot released after pause")
        time.sleep(4)
        assert not slots(pgcdc), "a process restarted the paused mapping"
        for be in both:
            assert not be.api("GET", "/api/mappings", 200)[0]["running"]
        # Resume via A.
        a.api("PUT", f"/api/mappings/{m['id']}", 200, json={"active": True})
        for be in both:
            be.wait_assets(site["id"], lambda x: len(x) == 10, 30)
        wait_until(lambda: len(slots(pgcdc)) == 1, 15, "slot after resume")
        # Edit via B: add label; both maps show it, still exactly one runner.
        cfg = {**BEDS_CONFIG, "fields": {**BEDS_CONFIG["fields"], "label": "bed_label"}, "kind": "cot"}
        b.api("PUT", f"/api/mappings/{m['id']}", 200, json={"config": cfg})
        for be in both:
            be.wait_assets(site["id"], lambda x: len(x) == 10 and all(y.get("kind") == "cot" for y in x.values()), 30)
        time.sleep(4)
        assert len(slots(pgcdc)) == 1, slots(pgcdc)
        time.sleep(1)
        sa, sb = comparable(wa.snapshot_state()), comparable(wb.snapshot_state())
        assert sa == sb == comparable(a.assets(site["id"])), "viewers on the two processes differ"
        # kill -9 the owner, keep writing, measure takeover.
        owner = slot_owner(pgcdc, a, b)
        assert len(owner) == 1, slots(pgcdc)
        dead = owner[0]
        alive = b if dead is a else a
        w_alive = wb if alive is b else wa
        seq = [0]

        def writer() -> None:
            with psycopg.connect(dsn_for(pgcdc.db), autocommit=True) as c:
                while not writer_stop.is_set():
                    seq[0] += 1
                    c.execute("UPDATE beds SET status=%s WHERE bed_id='B03'", (f"k{seq[0]}",))
                    time.sleep(0.1)

        t = threading.Thread(target=writer, daemon=True)
        t.start()
        time.sleep(1)
        mark = w_alive.mark()
        t_kill = time.time()
        kill9(dead)
        seq_at_kill = seq[0]
        t_first = w_alive.wait_asset(
            "B03", lambda x: int(str(x.get("state", "k0"))[1:]) > seq_at_kill + 1, 60, since=mark
        )
        takeover_s = round(t_first - t_kill, 1)
        wait_until(lambda: slot_owner(pgcdc, alive) == [alive] and len(slots(pgcdc)) == 1, 30, "takeover slot")
        slot_s = round(time.time() - t_kill, 1)
        writer_stop.set()
        t.join(5)
        final = f"k{seq[0]}"
        w_alive.wait_asset("B03", lambda x: x.get("state") == final, 15, since=0)
        h = alive.mapping_health(m["id"])
        # Restart the killed process: it must not take the mapping back or start a second runner.
        dead.start(migrate=False)
        time.sleep(5)
        n_slots_after_rejoin = len(slots(pgcdc))
        w_new = WsCollector(f"{dead.ws_base}/ws/sites/{site['id']}")
        viewers.append(w_new)
        pgcdc.exec("UPDATE beds SET status='rejoined' WHERE bed_id='B04'")
        for w in (w_alive, w_new):
            w.wait_asset("B04", lambda x: x.get("state") == "rejoined", 10, since=0)
        time.sleep(1)
        same = comparable(w_alive.snapshot_state()) == comparable(w_new.snapshot_state())
        # Delete via the rejoined process.
        dead.api("DELETE", f"/api/mappings/{m['id']}", 204)
        for be in both:
            be.wait_assets(site["id"], lambda x: len(x) == 0, 15)
        wait_until(lambda: not slots(pgcdc), 15, "slot gone after delete")
        time.sleep(4)
        record(
            "r2/cluster/takeover",
            killed="a" if dead is a else "b",
            takeover_first_update_s=takeover_s,
            takeover_slot_s=slot_s,
            alive_health=h and h["status"],
            slots_after_rejoin=n_slots_after_rejoin,
            viewers_identical_after_rejoin=same,
            resyncs=[resyncs(w) for w in viewers],
        )
        assert not slots(pgcdc), "mapping restarted after delete"
        assert n_slots_after_rejoin == 1
        assert same
        assert takeover_s < 20, f"takeover took {takeover_s}s"
    finally:
        writer_stop.set()
        for w in viewers:
            w.close()
        b.cleanup()
        a.cleanup()


@pytest.mark.xfail(strict=True, reason="LIVEOPS-79: a process that boots with no active mappings never joins")
def test_late_joiner_takes_over(pgcdc: PgSource) -> None:
    """B boots before any mapping exists; the mapping is created via A; A dies."""
    a = Backend(redis=True)
    b = PeerBackend(a)
    try:
        a.start()
        b.start(migrate=False)
        src = a.add_source("qa cdc", "postgres_cdc", pgcdc.settings(), {"password": pgcdc.password})
        site = a.add_site("qa late joiner", ["ICU", "Ward 4"])
        a.add_mapping(site["id"], src["id"], "public.beds", BEDS_CONFIG)
        b.wait_assets(site["id"], lambda x: len(x) == 10, 30)
        time.sleep(4)
        b_running = b.api("GET", "/api/mappings", 200)[0]["running"]
        kill9(a)
        pgcdc.exec("UPDATE beds SET status='after-kill' WHERE bed_id='B01'")
        try:
            b.wait_assets(site["id"], lambda x: x["B01"]["state"] == "after-kill", 30)
            took_over = True
        except AssertionError:
            took_over = False
        record(
            "r2/cluster/late_joiner",
            b_running_before_kill=b_running,
            took_over_within_30s=took_over,
            slots=len(slots(pgcdc)),
        )
        assert b_running and took_over
    finally:
        b.cleanup()
        a.cleanup()


# --------------------------------------------------------------------------
# 3. Restart: rebuild time (memory) and stale cleanup (Redis, LIVEOPS-40)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("type_", ["postgres_cdc", "postgres"])
@pytest.mark.parametrize("store", ["memory", "redis"])
def test_restart_rebuild_and_stale_cleanup(store: str, type_: str) -> None:
    pg = PgSource(cdc=type_ == "postgres_cdc")
    be = Backend(redis=store == "redis")
    try:
        big_table(pg)
        be.start()
        src = be.add_source("qa restart", type_, pg.settings(), {"password": pg.password})
        site = be.add_site("qa restart", [f"Z{i}" for i in range(20)])
        opts = {"poll_interval_s": 1} if type_ == "postgres" else None
        be.add_mapping(site["id"], src["id"], "public.assets", BIG_CONFIG, opts)
        be.wait_assets(site["id"], lambda a: len(a) == ASSETS, 60)
        be.stop()
        pg.exec("DELETE FROM assets WHERE (substr(id,2))::int % 4 = 0")  # 500 deleted while down
        pg.exec("UPDATE assets SET status='down' WHERE id='A1'")
        pg.exec("INSERT INTO assets VALUES ('NEW1','Z1','new',0)")
        expected = {r[0] for r in pg.q("SELECT id FROM assets")}
        t0 = time.time()
        be.start(migrate=False, wait=False)
        be.wait_ready(60)
        ready_s = round(time.time() - t0, 1)
        try:
            a = be.wait_assets(site["id"], lambda a: set(a) == expected and a["A1"]["state"] == "down", 60)
        except AssertionError:
            a = be.assets(site["id"])
        full_s = round(time.time() - t0, 1)
        stale = len(set(a) - expected)
        missing = len(expected - set(a))
        record(
            f"r2/restart/{type_}/{store}",
            assets=ASSETS,
            http_ready_s=ready_s,
            map_correct_s=full_s,
            stale_after_restart=stale,
            missing_after_restart=missing,
        )
        assert stale == 0 and missing == 0, f"stale={stale} missing={missing}"
    finally:
        be.cleanup()
        pg.cleanup()


# --------------------------------------------------------------------------
# 4 + 5. Load with two viewers + event-log paging under load (LIVEOPS-48)
# --------------------------------------------------------------------------


class EventPager:
    """Pages /events?since= continuously while load runs."""

    def __init__(self, be: Backend, site_id: str, since: float, limit: int = 250) -> None:
        self.be, self.site_id, self.since, self.limit = be, site_id, since, limit
        self.entries: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.calls = 0
        self._stop = threading.Event()
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self) -> None:
        with httpx.Client(base_url=self.be.base, timeout=30) as c:
            while True:
                stopping = self._stop.is_set()
                try:
                    r = c.get(
                        f"/api/sites/{self.site_id}/events", params={"since": repr(self.since), "limit": self.limit}
                    )
                    self.calls += 1
                    if r.status_code != 200:
                        self.errors.append(f"{r.status_code} {r.text[:200]}")
                        time.sleep(0.5)
                        continue
                    page = r.json()
                except Exception as e:  # noqa: BLE001
                    self.errors.append(repr(e)[:200])
                    time.sleep(0.5)
                    continue
                if page:
                    self.entries += page
                    self.since = page[-1]["ts"]
                if len(page) < self.limit:
                    if stopping:
                        return
                    time.sleep(0.2)

    def stop(self) -> None:
        self._stop.set()
        self.t.join(60)


@pytest.mark.parametrize("type_,interval", [("postgres_cdc", None), ("postgres", 1)])
@pytest.mark.parametrize("store", ["memory", "redis"])
def test_load_two_viewers_and_paging(store: str, type_: str, interval: int | None) -> None:
    pg = PgSource(cdc=type_ == "postgres_cdc")
    be = Backend(redis=store == "redis")
    viewers: list[WsCollector] = []
    pager: EventPager | None = None
    try:
        big_table(pg)
        be.start()
        src = be.add_source(f"qa load {type_}", type_, pg.settings(), {"password": pg.password})
        site = be.add_site(f"qa load {type_}", [f"Z{i}" for i in range(20)])
        m = be.add_mapping(
            site["id"], src["id"], "public.assets", BIG_CONFIG, {"poll_interval_s": interval} if interval else None
        )
        be.wait_assets(site["id"], lambda a: len(a) == ASSETS, 60)
        time.sleep(1)
        viewers = [WsCollector(f"{be.ws_base}/ws/sites/{site['id']}") for _ in range(2)]
        t_start = time.time()
        pager = EventPager(be, site["id"], since=t_start - 0.001)
        sampler = ProcSampler(be.pid())
        sys_cpu0 = psutil.cpu_times()
        sent: dict[tuple[str, str], float] = {}
        behind = 0.0
        with psycopg.connect(dsn_for(pg.db), autocommit=True) as c:
            start = time.time()
            for i in range(RATE * DURATION):
                due = start + i / RATE
                now = time.time()
                if due > now:
                    time.sleep(due - now)
                else:
                    behind = max(behind, now - due)
                aid, val = f"A{random.randint(1, ASSETS)}", f"v{i + 1}"
                sent[(aid, val)] = time.time()
                c.execute("UPDATE assets SET status=%s, seq=%s WHERE id=%s", (val, i + 1, aid))
            write_s = time.time() - start
        final_db = {r[0]: r[1] for r in pg.q("SELECT id, status FROM assets")}
        deadline = time.time() + 30
        while time.time() < deadline:
            states = [w.snapshot_state() for w in viewers]
            if all(all(st.get(k, {}).get("state") == v for k, v in final_db.items()) for st in states):
                break
            time.sleep(0.5)
        drain_s = round(time.time() - (start + write_s), 1)
        res = sampler.stop()
        sys_cpu1 = psutil.cpu_times()
        busy = lambda t: t.user + t.system + t.nice + t.irq + t.softirq  # noqa: E731
        total = lambda t: busy(t) + t.idle + t.iowait  # noqa: E731
        host_cpu = round(100 * (busy(sys_cpu1) - busy(sys_cpu0)) / max(1e-9, total(sys_cpu1) - total(sys_cpu0)), 1)
        time.sleep(1)
        pager.stop()
        per_viewer = []
        for w in viewers:
            st = w.snapshot_state()
            seen: dict[tuple[str, str], float] = {}
            with w.lock:
                for t, msg in w.messages:
                    if msg["type"] in ("upsert", "snapshot"):
                        for a in msg["assets"]:
                            seen.setdefault((a["asset_id"], str(a.get("state"))), t)
            lat = [(seen[k] - t0) * 1000 for k, t0 in sent.items() if k in seen]
            per_viewer.append(
                {
                    "mismatch": sum(1 for k, v in final_db.items() if st.get(k, {}).get("state") != v),
                    "resyncs": resyncs(w),
                    "closed": w.closed_code,
                    "values_seen": len(lat),
                    **{k: v for k, v in latency_summary(lat).items() if k in ("p50_ms", "p95_ms", "max_ms")},
                }
            )
        rest = be.assets(site["id"])
        rest_mismatch = sum(1 for k, v in final_db.items() if rest.get(k, {}).get("state") != v)
        # paging checks
        ents = pager.entries
        probs = paging_problems(ents)
        paged_vals = {(e["asset_id"], e["changes"]["state"][1]) for e in ents if "state" in e.get("changes", {})}
        missing_events = sum(1 for k in sent if k not in paged_vals) if type_ == "postgres_cdc" else None
        # re-page the same window after the fact: same entries?
        again = page_all(be, site["id"], t_start - 0.001, 1000)
        # the log keeps ~10,000 entries per site: the re-read must equal the live tail
        same_as_live = bool(again) and [e["ts"] for e in again] == [e["ts"] for e in ents][-len(again) :]
        h = be.mapping_health(m["id"])
        record(
            f"r2/load/{type_}/{store}",
            rate=RATE,
            duration_s=DURATION,
            sent=len(sent),
            writer_rate=round(len(sent) / write_s, 1),
            writer_max_behind_s=round(behind, 2),
            viewers=per_viewer,
            rest_mismatch=rest_mismatch,
            drain_s=drain_s,
            pager_entries=len(ents),
            pager_calls=pager.calls,
            pager_errors=pager.errors[:3],
            pager_missing_events=missing_events,
            repage_identical=same_as_live,
            repage_entries=len(again),
            health=h and {k: h[k] for k in ("status", "lag_ms_p95", "events_total")},
            host_cpu_pct=host_cpu,
            loadavg=os.getloadavg(),
            **res,
        )
        assert rest_mismatch == 0 and all(v["mismatch"] == 0 for v in per_viewer), per_viewer
        assert not pager.errors, pager.errors[:3]
        assert same_as_live, "re-paging the window returned different entries than live paging"
        assert probs == {"non_increasing_ts": 0, "duplicate_ts": 0}, probs
        if missing_events is not None:
            assert missing_events == 0, f"{missing_events} changes never showed up when paging /events"
        assert all(v["resyncs"] == 0 for v in per_viewer), per_viewer
    finally:
        if pager:
            pager.stop()
        for w in viewers:
            w.close()
        be.cleanup()
        pg.cleanup()


# --------------------------------------------------------------------------
# Reconcile / clear bursts of 2,000 removes (LIVEOPS-55) + paging of the burst
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "how",
    [
        pytest.param(
            "pause", marks=pytest.mark.xfail(strict=True, reason="LIVEOPS-55: clear_mapping burst resyncs viewers")
        ),
        "source_delete",
    ],
)
@pytest.mark.parametrize("store", ["memory", "redis"])
def test_remove_burst_2000(store: str, how: str) -> None:
    pg = PgSource(cdc=True)
    be = Backend(redis=store == "redis")
    viewers: list[WsCollector] = []
    try:
        big_table(pg)
        be.start()
        src = be.add_source("qa burst", "postgres_cdc", pg.settings(), {"password": pg.password})
        site = be.add_site("qa burst", [f"Z{i}" for i in range(20)])
        m = be.add_mapping(site["id"], src["id"], "public.assets", BIG_CONFIG)
        be.wait_assets(site["id"], lambda a: len(a) == ASSETS, 60)
        time.sleep(1)
        viewers = [WsCollector(f"{be.ws_base}/ws/sites/{site['id']}") for _ in range(2)]
        t0 = time.time()
        if how == "pause":
            be.api("PUT", f"/api/mappings/{m['id']}", 200, json={"active": False})
        else:
            pg.exec("DELETE FROM assets")
        api_s = round(time.time() - t0, 2)
        for w in viewers:
            w.wait(lambda _m, w=w: len(w.state) == 0, 60)
        empty_s = round(time.time() - t0, 2)
        time.sleep(1)
        ents = page_all(be, site["id"], t0 - 0.001, 100)
        removed_paged = {e["asset_id"] for e in ents if e.get("removed")}
        probs = paging_problems(ents)
        all_at_once = be.api(
            "GET", f"/api/sites/{site['id']}/events", 200, params={"since": repr(t0 - 0.001), "limit": 1000}
        )
        record(
            f"r2/remove_burst/{how}/{store}",
            removes=ASSETS,
            api_s=api_s,
            viewers_empty_s=empty_s,
            resyncs=[resyncs(w) for w in viewers],
            paged_entries=len(ents),
            paged_removed_assets=len(removed_paged),
            **probs,
            first_page_1000_distinct_ts=len({e["ts"] for e in all_at_once}),
        )
        assert len(removed_paged) == ASSETS, (
            f"paging since= (limit 100) returned {len(removed_paged)}/{ASSETS} removes; {probs}"
        )
        assert all(resyncs(w) == 0 for w in viewers), [resyncs(w) for w in viewers]
    finally:
        for w in viewers:
            w.close()
        be.cleanup()
        pg.cleanup()
