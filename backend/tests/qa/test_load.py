"""QA 3: load. 200 changes/s for 60 s against postgres_cdc and poll postgres,
2,000 assets (the per-site design target). Reports change -> WebSocket
latency, missed updates (final DB vs final map) and backend CPU/RSS."""

from __future__ import annotations

import os
import random
import threading
import time
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from tests.qa.harness import Backend, PgSource, WsCollector, dsn_for, latency_summary, qa, record

pytestmark = qa
RATE = int(os.environ.get("LIVEOPS_QA_RATE", "200"))
DURATION = int(os.environ.get("LIVEOPS_QA_DURATION", "60"))
ASSETS = 2000


class ProcSampler:
    def __init__(self, pid: int) -> None:
        import psutil

        self.p = psutil.Process(pid)
        self.procs = [self.p, *self.p.children(recursive=True)]
        self.cpu: list[float] = []
        self.rss: list[float] = []
        self._stop = threading.Event()
        for p in self.procs:
            p.cpu_percent(None)
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self) -> None:
        while not self._stop.wait(1.0):
            self.cpu.append(sum(p.cpu_percent(None) for p in self.procs))
            self.rss.append(sum(p.memory_info().rss for p in self.procs) / 2**20)

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        self.t.join()
        return {
            "cpu_avg_pct": round(sum(self.cpu) / len(self.cpu), 1) if self.cpu else None,
            "cpu_max_pct": round(max(self.cpu), 1) if self.cpu else None,
            "rss_start_mb": round(self.rss[0], 1) if self.rss else None,
            "rss_end_mb": round(self.rss[-1], 1) if self.rss else None,
            "rss_max_mb": round(max(self.rss), 1) if self.rss else None,
        }


@pytest.fixture(params=["memory", "redis"])
def backend(request: pytest.FixtureRequest) -> Iterator[Backend]:
    be = Backend(redis=request.param == "redis")
    try:
        be.start()
        yield be
    finally:
        be.cleanup()


@pytest.mark.parametrize("type_,interval", [("postgres_cdc", None), ("postgres", 3)])
def test_load(backend: Backend, type_: str, interval: int | None) -> None:
    pg = PgSource(cdc=type_ == "postgres_cdc")
    ws: WsCollector | None = None
    try:
        pg.exec("CREATE TABLE assets (id text PRIMARY KEY, zone text, status text, seq int)")
        pg.exec(f"INSERT INTO assets SELECT 'A'||g, 'Z'||(g%20), 'v0', 0 FROM generate_series(1,{ASSETS}) g")
        src = backend.add_source(f"qa load {type_}", type_, pg.settings(), {"password": pg.password})
        site = backend.add_site(f"qa load {type_}", [f"Z{i}" for i in range(20)])
        opts = {"poll_interval_s": interval} if interval else None
        m = backend.add_mapping(
            site["id"],
            src["id"],
            "public.assets",
            {"id_field": "id", "fields": {"zone": "zone", "state": "status"}, "attributes": ["seq"]},
            opts,
        )
        backend.wait_assets(site["id"], lambda a: len(a) == ASSETS, 60)
        ws = WsCollector(f"{backend.ws_base}/ws/sites/{site['id']}")
        sampler = ProcSampler(backend.pid())
        sent: dict[tuple[str, str], float] = {}
        seq = 0
        lag_behind = 0.0
        with psycopg.connect(dsn_for(pg.db), autocommit=True) as c:
            start = time.time()
            n_total = RATE * DURATION
            for i in range(n_total):
                due = start + i / RATE
                now = time.time()
                if due > now:
                    time.sleep(due - now)
                else:
                    lag_behind = max(lag_behind, now - due)
                seq += 1
                aid = f"A{random.randint(1, ASSETS)}"
                val = f"v{seq}"
                sent[(aid, val)] = time.time()
                c.execute("UPDATE assets SET status=%s, seq=%s WHERE id=%s", (val, seq, aid))
            write_s = time.time() - start
        # let it drain
        final_db = {r[0]: r[1] for r in pg.q("SELECT id, status FROM assets")}
        deadline = time.time() + (30 if interval else 20)
        while time.time() < deadline:
            st = ws.snapshot_state()
            if all(st.get(k, {}).get("state") == v for k, v in final_db.items()):
                break
            time.sleep(0.5)
        drain_s = round(time.time() - (start + write_s), 1)
        res = sampler.stop()
        st = ws.snapshot_state()
        rest = backend.assets(site["id"])
        ws_mismatch = [k for k, v in final_db.items() if st.get(k, {}).get("state") != v]
        rest_mismatch = [k for k, v in final_db.items() if rest.get(k, {}).get("state") != v]
        # latency per (asset,value) seen on the WS
        seen: dict[tuple[str, str], float] = {}
        resyncs = 0
        with ws.lock:
            for t, msg in ws.messages:
                if msg["type"] == "snapshot":
                    resyncs += 1
                if msg["type"] in ("upsert", "snapshot"):
                    for a in msg["assets"]:
                        seen.setdefault((a["asset_id"], str(a.get("state"))), t)
        lat = [(seen[k] - t0) * 1000 for k, t0 in sent.items() if k in seen]
        h = backend.mapping_health(m["id"])
        store = "redis" if backend.redis_prefix else "memory"
        record(
            f"load/{type_}/{store}",
            rate=RATE,
            duration_s=DURATION,
            sent=len(sent),
            writer_actual_rate=round(len(sent) / write_s, 1),
            writer_max_behind_s=round(lag_behind, 2),
            values_seen_on_ws=len(lat),
            **{f"lat_{k}": v for k, v in latency_summary(lat).items()},
            ws_final_mismatch=len(ws_mismatch),
            rest_final_mismatch=len(rest_mismatch),
            drain_s=drain_s,
            ws_resync_snapshots=resyncs - 1,
            ws_closed=ws.closed_code,
            health_lag_p95=h and h["lag_ms_p95"],
            health_status=h and h["status"],
            **res,
        )
        assert not rest_mismatch, f"{len(rest_mismatch)} assets differ from the DB after drain: {rest_mismatch[:5]}"
        assert not ws_mismatch, f"{len(ws_mismatch)} assets on the WS map differ from the DB: {ws_mismatch[:5]}"
        if resyncs - 1 > 0 and store == "memory":
            pytest.xfail(f"LIVEOPS-48: {resyncs - 1} full resync snapshots for a client that kept up")
        assert resyncs - 1 == 0, f"{resyncs - 1} resync snapshots"
        if type_ == "postgres_cdc":
            assert latency_summary(lat)["p95_ms"] < 2000, "CDC p95 over the 2 s target"
    finally:
        if ws:
            ws.close()
        pg.cleanup()
