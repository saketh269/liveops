"""Asset history end to end: migration, recording through the store, the API, retention."""

from __future__ import annotations

import time
from collections.abc import Iterator
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, insert, inspect, select

from app.core.events import AssetEvent, AssetOp

LAYOUT: dict[str, Any] = {
    "floors": [{"id": "1", "name": "Floor 1", "level": 0}, {"id": "3", "name": "Floor 3", "level": 2}],
    "zones": [
        {
            "id": "ED-WR",
            "name": "ED Waiting Room",
            "floor_id": "1",
            "kind": "waiting",
            "polygon": [[0, 0], [4, 0], [4, 4]],
        },
        {"id": "ED-02", "name": "ED-02", "floor_id": "1", "kind": "room", "polygon": [[5, 0], [9, 0], [9, 4]]},
        {"id": "3W-305A", "name": "3W-305A", "floor_id": "3", "kind": "room", "polygon": [[0, 0], [4, 0], [4, 4]]},
    ],
}


@pytest.fixture
def client(portal_db: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("LIVEOPS_START_RUNNERS", "false")
    monkeypatch.setenv("LIVEOPS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIVEOPS_HISTORY_DAYS", "30")
    monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


def setup_site(c: TestClient) -> tuple[str, dict[str, str]]:
    """A site with a patients mapping and a transport mapping attached by match key."""
    from app.db import Mapping, Source, new_session

    sid = c.post("/api/sites", json={"name": "General", "template": "hospital", "layout": LAYOUT}).json()["id"]
    with new_session() as s:
        p = Source(name="Patients", type="rest", settings={})
        t = Source(name="Transports", type="rest", settings={})
        s.add_all([p, t])
        s.flush()
        mp = Mapping(site_id=sid, source_id=p.id, dataset="patients", config={"id_field": "patient_id"}, options={})
        mt = Mapping(
            site_id=sid,
            source_id=t.id,
            dataset="transport_requests",
            config={"id_field": "request_id", "match_key": "patient_id"},
            options={},
        )
        s.add_all([mp, mt])
        s.commit()
        return sid, {"mp": mp.id, "mt": mt.id, "sp": p.id, "st": t.id}


def apply(
    c: TestClient, site: str, asset: str, fields: dict[str, Any], src: str, mapping: str, op: AssetOp = AssetOp.UPSERT
) -> None:
    ev = AssetEvent(site_id=site, asset_id=asset, op=op, source_id=src, mapping_id=mapping, dataset="d", fields=fields)
    store = c.app.state.store  # type: ignore[attr-defined]
    c.portal.call(store.apply, ev)  # type: ignore[union-attr]


def flush(c: TestClient) -> None:
    c.portal.call(c.app.state.history.flush)  # type: ignore[attr-defined,union-attr]


def test_migration_creates_indexed_table(client: TestClient) -> None:
    from app.db import engine

    insp = inspect(engine())
    assert "asset_history" in insp.get_table_names()
    idx = {i["name"]: i["column_names"] for i in insp.get_indexes("asset_history")}
    assert idx["ix_asset_history_site_asset_ts"] == ["site_id", "asset_id", "ts"]
    assert idx["ix_asset_history_ts"] == ["ts"]


def test_history_of_a_patient_with_attached_transport(client: TestClient) -> None:
    sid, ids = setup_site(client)
    mp, mt, sp, st = ids["mp"], ids["mt"], ids["sp"], ids["st"]
    apply(
        client,
        sid,
        "P1",
        {
            "zone": "ED Waiting Room",
            "kind": "patient",
            "attributes": {"status": "waiting_room", "admit_time": "2026-10-07T10:00:00Z"},
        },
        sp,
        mp,
    )
    apply(client, sid, "P1", {"zone": "ED-02", "anchor": "ED-02", "attributes": {"status": "in_treatment"}}, sp, mp)
    apply(client, sid, "P1", {"attributes": {"status": "requested", "from": "ED-02", "to": "3W-305A"}}, st, mt)
    apply(client, sid, "P1", {"zone": "3W-305A", "anchor": "3W-305A", "attributes": {"status": "admitted"}}, sp, mp)
    apply(client, sid, "P1", {"attributes": {"status": "requested"}}, st, mt, op=AssetOp.REMOVE)
    flush(client)

    r = client.get(f"/api/sites/{sid}/assets/P1/history")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["present"] is True and body["history_since"] is not None and body["retention_days"] == 30
    texts = [e["text"] for e in body["entries"]]
    assert texts[0] == "In ED Waiting Room when Live Ops started watching · Waiting room"
    assert texts[1] == "Moved from ED Waiting Room to ED-02 · now In treatment"
    assert texts[2] == "Transport request opened: Requested, ED-02 → 3W-305A"
    assert texts[3] == "Moved from ED-02 to 3W-305A (Floor 1 → Floor 3) · now Admitted"
    assert texts[4].startswith("Transport request closed")
    last_move = body["entries"][3]
    assert last_move["floor_change"] == {"from": "1", "to": "3"} and last_move["ongoing"] is True
    assert body["current"]["floor_id"] == "3" and body["current"]["bed"] == "3W-305A"
    assert [m["label"] for m in body["milestones"]] == ["Admitted"]

    # since/until window and limit
    ts = [e["ts"] for e in body["entries"]]
    win = client.get(f"/api/sites/{sid}/assets/P1/history", params={"since": ts[0], "until": ts[3]}).json()
    assert [e["ts"] for e in win["entries"]] == ts[1:4]
    assert (
        win["entries"][0]["text"] == "Moved from ED Waiting Room to ED-02 · now In treatment"
    )  # context from before the window
    lim = client.get(f"/api/sites/{sid}/assets/P1/history", params={"limit": 2}).json()
    assert lim["truncated"] is True and [e["ts"] for e in lim["entries"]] == ts[-2:]

    # discharged: removed from the map, history stays readable
    apply(client, sid, "P1", {}, sp, mp, op=AssetOp.REMOVE)
    flush(client)
    gone = client.get(f"/api/sites/{sid}/assets/P1/history").json()
    assert gone["present"] is False and gone["current"] is None
    assert gone["entries"][-1]["kind"] == "left" and "Patients no longer lists it" in gone["entries"][-1]["text"]


def test_unknown_site_and_asset_are_404_quiet_asset_is_empty(client: TestClient) -> None:
    sid, ids = setup_site(client)
    assert client.get("/api/sites/nope/assets/P1/history").status_code == 404
    r = client.get(f"/api/sites/{sid}/assets/NOPE/history")
    assert r.status_code == 404 and "No record" in r.json()["detail"]["message"]
    store = client.app.state.store  # type: ignore[attr-defined]
    sink, store.history_sink = store.history_sink, None
    apply(client, sid, "B9", {"zone": "ED-02"}, ids["sp"], ids["mp"])  # live, but never recorded
    store.history_sink = sink
    quiet = client.get(f"/api/sites/{sid}/assets/B9/history")
    assert quiet.status_code == 200 and quiet.json()["entries"] == [] and quiet.json()["present"] is True
    assert client.get(f"/api/sites/{sid}/assets/P1/history", params={"limit": 0}).status_code == 422


def test_many_entries_retention_and_site_delete(client: TestClient) -> None:
    from app.db import AssetHistory, new_session

    sid, ids = setup_site(client)
    now = time.time()
    rows = []
    for i in range(3000):
        z = "ED-02" if i % 2 else "ED Waiting Room"
        rows.append(
            {
                "site_id": sid,
                "asset_id": "S1",
                "ts": now - 40 * 86400 + i * 1200,  # 3000 steps over ~41 days: the oldest are past retention
                "op": "upsert",
                "removed": False,
                "source_id": ids["sp"],
                "mapping_id": ids["mp"],
                "changes": {"zone": [None, z]},
                "ctx": {"zone": z},
            }
        )
    with new_session() as s:
        s.execute(insert(AssetHistory), rows)
        s.commit()
    t0 = time.perf_counter()
    r = client.get(f"/api/sites/{sid}/assets/S1/history", params={"limit": 5000})
    assert r.status_code == 200 and time.perf_counter() - t0 < 5
    assert len(r.json()["entries"]) == 3000 and r.json()["entries"][1]["kind"] == "move"

    deleted = client.portal.call(partial(client.app.state.history.cleanup, now))  # type: ignore[attr-defined,union-attr]
    cutoff = now - 30 * 86400
    assert deleted == sum(1 for x in rows if x["ts"] < cutoff)
    with new_session() as s:
        left = s.scalar(select(func.count()).select_from(AssetHistory).where(AssetHistory.site_id == sid))
        oldest = s.scalar(select(func.min(AssetHistory.ts)).where(AssetHistory.site_id == sid))
    assert left == 3000 - deleted and oldest is not None and oldest >= cutoff

    assert client.delete(f"/api/sites/{sid}").status_code == 204
    with new_session() as s:
        assert s.scalar(select(func.count()).select_from(AssetHistory).where(AssetHistory.site_id == sid)) == 0
