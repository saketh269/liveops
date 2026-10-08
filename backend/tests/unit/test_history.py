"""Asset history: what is recorded, the batching recorder, and the readable timeline."""

from __future__ import annotations

import time
from typing import Any

import pytest

from app.api.history import Places, build_history, dataset_label, fmt_minutes, humanize, milestones
from app.core.events import AssetEvent, AssetOp
from app.core.history import HistoryRecorder, context_of, history_row
from app.core.state import StateStore
from tests.unit.conftest import StoreFactory

LAYOUT: dict[str, Any] = {
    "floors": [{"id": "1", "name": "Floor 1"}, {"id": "3", "name": "Floor 3"}],
    "zones": [
        {"id": "ED-WR", "name": "ED Waiting Room", "floor_id": "1", "polygon": []},
        {"id": "ED-02", "name": "ED-02", "floor_id": "1", "polygon": []},
        {"id": "3W-305A", "name": "3W-305A", "floor_id": "3", "polygon": []},
    ],
}


def entry(
    changes: dict[str, list[Any]], *, removed: bool = False, ts: float = 100.0, mapping: str = "mp"
) -> dict[str, Any]:
    return {
        "ts": ts,
        "site_id": "s",
        "asset_id": "P1",
        "op": "remove" if removed else "upsert",
        "removed": removed,
        "source_id": "src",
        "mapping_id": mapping,
        "changes": changes,
    }


def test_history_row_keeps_only_story_fields_and_context() -> None:
    asset = {
        "asset_id": "P1",
        "zone": "ED-02",
        "state": "in_use",
        "anchor": "ED-02",
        "attributes": {"status": "in_treatment", "esi_acuity": 3, "admit_time": "2026-10-07T10:00:00Z"},
    }
    row = history_row(
        entry({"zone": ["ED Waiting Room", "ED-02"], "attributes.esi_acuity": [2, 3], "attributes.status": ["a", "b"]}),
        asset,
    )
    assert row is not None
    assert set(row["changes"]) == {"zone", "attributes.status"}  # acuity is not history
    assert row["ctx"] == {
        "zone": "ED-02",
        "state": "in_use",
        "anchor": "ED-02",
        "status": "in_treatment",
        "times": {"admit_time": "2026-10-07T10:00:00Z"},
    }
    assert history_row(entry({"attributes.esi_acuity": [2, 3]}), asset) is None
    gone = history_row(entry({"zone": ["ED-02", None]}, removed=True), None)
    assert gone is not None and gone["removed"] and gone["ctx"] is None


def test_context_cuts_long_values() -> None:
    ctx = context_of({"zone": "x" * 1000, "attributes": {"created_at": {"nested": 1}}})
    assert len(ctx["zone"]) == 200 and "times" not in ctx


async def test_recorder_queue_is_bounded_and_never_blocks() -> None:
    rec = HistoryRecorder(max_pending=3, session_factory=lambda: pytest.fail("no DB in this test"))  # type: ignore[arg-type,return-value]
    for i in range(10):
        rec.record(entry({"zone": [None, f"Z{i}"]}, ts=float(i)), {"zone": f"Z{i}"})
    assert rec.pending == 3 and rec.dropped == 7
    rec.record({"garbage": True}, None)  # unreadable entries are skipped, not raised
    off = HistoryRecorder(retention_days=0)
    off.record(entry({"zone": [None, "A"]}), {"zone": "A"})
    assert off.pending == 0 and not off.enabled


async def test_recorder_keeps_rows_when_the_db_fails() -> None:
    class Broken:
        def __enter__(self) -> Broken:
            raise RuntimeError("db down")

        def __exit__(self, *a: object) -> None: ...

    rec = HistoryRecorder(session_factory=Broken)  # type: ignore[arg-type]
    rec.record(entry({"zone": [None, "A"]}), {"zone": "A"})
    assert await rec.flush() == 0
    assert rec.pending == 1 and rec.write_errors == 1


async def test_store_hands_every_change_to_the_sink(store_factory: StoreFactory) -> None:
    store: StateStore = store_factory()
    got: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    store.history_sink = lambda e, a: got.append((e, a))

    def ev(
        fields: dict[str, Any], *, asset: str = "P1", mapping: str = "mp", op: AssetOp = AssetOp.UPSERT
    ) -> AssetEvent:
        return AssetEvent(
            site_id="s", asset_id=asset, op=op, source_id="src", mapping_id=mapping, dataset="d", fields=fields
        )

    await store.apply(ev({"zone": "ED-WR", "attributes": {"status": "waiting_room"}}))
    await store.apply(ev({"zone": "ED-02"}))
    await store.apply(ev({"zone": "ED-02"}))  # no change: nothing recorded
    # A transport attached through a match key lands on the patient.
    await store.apply(ev({"attributes": {"from": "ED-02"}}, mapping="mt"))
    await store.apply(ev({"zone": "B"}, asset="P2"))
    await store.reconcile("s", "mp", {"P1"})  # P2 removed by the snapshot reconcile
    assert [(e["asset_id"], e["removed"]) for e, _ in got] == [
        ("P1", False),
        ("P1", False),
        ("P1", False),
        ("P2", False),
        ("P2", True),
    ]
    first_asset = got[0][1]
    assert first_asset is not None and first_asset["attributes"]["status"] == "waiting_room"
    assert got[1][0]["changes"] == {"zone": ["ED-WR", "ED-02"]}
    assert got[2][0]["mapping_id"] == "mt"
    assert got[4][1] is None
    await store.close()


def rows_for_patient(t0: float) -> list[dict[str, Any]]:
    return [
        {
            "ts": t0,
            "removed": False,
            "mapping_id": "mp",
            "source_id": "src",
            "changes": {"zone": [None, "ED Waiting Room"], "attributes.status": [None, "waiting_room"]},
            "ctx": {
                "zone": "ED Waiting Room",
                "status": "waiting_room",
                "times": {"admit_time": "2026-10-07T10:00:00Z"},
            },
        },
        {
            "ts": t0 + 600,
            "removed": False,
            "mapping_id": "mp",
            "source_id": "src",
            "changes": {
                "zone": ["ED Waiting Room", "ED-02"],
                "anchor": [None, "ED-02"],
                "attributes.status": ["waiting_room", "in_treatment"],
            },
            "ctx": {"zone": "ED-02", "anchor": "ED-02", "status": "in_treatment"},
        },
        {
            "ts": t0 + 900,
            "removed": False,
            "mapping_id": "mt",
            "source_id": "src-t",
            "changes": {
                "attributes.status": [None, "requested"],
                "attributes.from": [None, "ED-02"],
                "attributes.to": [None, "3W-305A"],
            },
            "ctx": {"zone": "ED-02", "anchor": "ED-02", "status": "requested"},  # merged view: the transport's status
        },
        {
            "ts": t0 + 3120,
            "removed": False,
            "mapping_id": "mp",
            "source_id": "src",
            "changes": {"attributes.status": ["in_treatment", "boarding"]},
            "ctx": {"zone": "ED-02", "anchor": "ED-02", "status": "boarding"},
        },
        {
            "ts": t0 + 4000,
            "removed": False,
            "mapping_id": "mp",
            "source_id": "src",
            "changes": {
                "zone": ["ED-02", "3W-305A"],
                "anchor": ["ED-02", "3W-305A"],
                "attributes.status": ["boarding", "admitted"],
            },
            "ctx": {"zone": "3W-305A", "anchor": "3W-305A", "status": "admitted"},
        },
    ]


def test_build_history_reads_like_a_journey() -> None:
    t0 = 1_000_000.0
    items = build_history(
        rows_for_patient(t0),
        places=Places(LAYOUT),
        attached={"mt": "Transport request"},
        source_names={"src": "Patients"},
        present=True,
        now=t0 + 4600,
        started_ts=t0 - 10,
    )
    assert [i["kind"] for i in items] == ["arrived", "move", "task", "status", "move"]
    assert items[0]["text"] == "In ED Waiting Room when Live Ops started watching · Waiting room"
    assert items[1]["text"] == "Moved from ED Waiting Room to ED-02 · now In treatment"
    assert items[1]["duration_text"] == "in ED-02 for 56 min"  # 600 → 4000
    assert items[2]["text"] == "Transport request opened: Requested, ED-02 → 3W-305A"
    assert items[2]["status"] == "In treatment"  # the transport does not change the patient's status
    assert items[3]["text"] == "In treatment → Boarding"
    assert items[3]["duration_text"] == "Boarding for 14 min"
    last = items[4]
    assert last["text"] == "Moved from ED-02 to 3W-305A (Floor 1 → Floor 3) · now Admitted"
    assert last["floor_change"] == {"from": "1", "to": "3"}
    assert (last["zone"], last["bed"], last["floor"]) == ("3W-305A", "3W-305A", "Floor 3")
    assert last["ongoing"] and last["duration_text"] == "in 3W-305A for 10 min so far"


def test_build_history_left_and_back_and_restart_noise() -> None:
    t0 = 2_000_000.0
    base = {"mapping_id": "mp", "source_id": "src"}
    rows = [
        {**base, "ts": t0, "removed": False, "changes": {"zone": [None, "ED-02"]}, "ctx": {"zone": "ED-02"}},
        # Live Ops restarted (in-memory store): the same values arrive again.
        {**base, "ts": t0 + 60, "removed": False, "changes": {"zone": [None, "ED-02"]}, "ctx": {"zone": "ED-02"}},
        {**base, "ts": t0 + 120, "removed": True, "changes": {"zone": ["ED-02", None]}, "ctx": None},
        {**base, "ts": t0 + 300, "removed": False, "changes": {"zone": [None, "ED-WR"]}, "ctx": {"zone": "ED-WR"}},
    ]
    items = build_history(
        rows,
        places=Places(LAYOUT),
        attached={},
        source_names={"src": "Patients"},
        present=False,
        now=t0 + 900,
        started_ts=t0 - 3600,
    )
    assert [i["kind"] for i in items] == ["arrived", "left", "arrived"]
    assert items[0]["text"] == "First seen in ED-02" and items[0]["duration_text"] == "in ED-02 for 2 min"
    assert items[1]["text"].startswith("Left the map: Patients no longer lists it")
    assert items[2]["text"] == "Back on the map in ED Waiting Room"
    assert "duration_s" not in items[2]  # not on the map now, and nothing came after


def test_cleaning_task_on_a_bed_reads_as_a_task() -> None:
    t0 = 3_000_000.0
    rows = [
        {
            "ts": t0,
            "removed": False,
            "mapping_id": "mb",
            "source_id": "b",
            "changes": {"state": [None, "cleaning"], "attributes.status": [None, "dirty"]},
            "ctx": {"zone": "ED-02", "state": "cleaning", "status": "dirty"},
        },
        {
            "ts": t0 + 5,
            "removed": False,
            "mapping_id": "mc",
            "source_id": "c",
            "changes": {"attributes.status": ["dirty", "queued"]},
            "ctx": {"zone": "ED-02", "status": "queued", "times": {"created_at": "2026-10-07T11:00:00Z"}},
        },
        {
            "ts": t0 + 600,
            "removed": False,
            "mapping_id": "mc",
            "source_id": "c",
            "changes": {"attributes.status": ["queued", "in_progress"], "attributes.assigned_to": [None, "S1"]},
            "ctx": {
                "zone": "ED-02",
                "status": "in_progress",
                "times": {"created_at": "2026-10-07T11:00:00Z", "started_at": "2026-10-07T11:10:00Z"},
            },
        },
        {
            "ts": t0 + 1500,
            "removed": False,
            "mapping_id": "mc",
            "source_id": "c",
            "changes": {"attributes.status": ["in_progress", None], "attributes.assigned_to": ["S1", None]},
            "ctx": {"zone": "ED-02"},
        },
    ]
    items = build_history(
        rows,
        places=Places(LAYOUT),
        attached={"mc": "Cleaning task"},
        source_names={},
        present=True,
        now=t0 + 1600,
        started_ts=t0,
    )
    assert [i["text"] for i in items[1:]] == [
        "Cleaning task opened: Queued",
        "Cleaning task: Queued → In progress",
        "Cleaning task closed (was In progress)",
    ]
    ms = milestones(rows, {})
    assert [m["key"] for m in ms] == ["created_at", "started_at"] and ms[0]["label"] == "Created"


def test_helpers() -> None:
    assert humanize("waiting_for_provider") == "Waiting for provider"
    assert humanize("AT_HOSPITAL_OFFLOADING") == "At hospital offloading"
    assert humanize("ED-02") == "ED-02" and humanize("3W-305A") == "3W-305A"
    assert dataset_label("/api/cleaning-tasks") == "Cleaning task"
    assert dataset_label("transport_requests") == "Transport request"
    assert fmt_minutes(30) == "under a minute" and fmt_minutes(2520) == "42 min" and fmt_minutes(3900) == "1 h 05 min"
    p = Places(LAYOUT)
    assert p.floor_id(3) == "3" and p.floor_id("Floor 3") == "3" and p.floor_id("9") is None
    assert p.place({"zone": "En route ED-07 → 4E-405A"})["zone"] == "En route ED-07 → 4E-405A"
    assert p.place({"anchor": "3W-305A"})["floor"] == "Floor 3"


def test_many_rows_are_fast() -> None:
    t0 = time.time() - 86400
    rows = [
        {
            "ts": t0 + i,
            "removed": False,
            "mapping_id": "mp",
            "source_id": "s",
            "changes": {"zone": [None, z]},
            "ctx": {"zone": z},
        }
        for i, z in enumerate(["ED-02", "ED-WR"] * 2500)
    ]
    start = time.perf_counter()
    items = build_history(
        rows, places=Places(LAYOUT), attached={}, source_names={}, present=True, now=t0 + 6000, started_ts=t0
    )
    assert len(items) == 5000 and time.perf_counter() - start < 2.0
