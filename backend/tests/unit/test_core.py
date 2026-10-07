from __future__ import annotations

import asyncio
import datetime as dt
import decimal
import json
import uuid

import pytest

from app.connectors.base import Change, ChangeOp, diff_snapshots, normalize_record, record_key
from app.core.events import AssetEvent, AssetOp
from app.core.mapping import MappingConfig, MappingProblem, apply_mapping, validate_against_columns
from app.core.state import StateStore


def test_normalize_record_is_json_safe() -> None:
    rec = normalize_record(
        {
            "ts": dt.datetime(2026, 10, 6, 12, 0, tzinfo=dt.UTC),
            "d": dt.date(2026, 1, 2),
            "n": decimal.Decimal("1.50"),
            "i": decimal.Decimal("3"),
            "u": uuid.UUID(int=1),
            "b": b"\x00\x01",
            "nan": float("nan"),
            "nested": {"when": dt.time(8, 30)},
            "lst": (1, dt.timedelta(seconds=90)),
        }
    )
    json.dumps(rec)
    assert rec["ts"] == "2026-10-06T12:00:00+00:00"
    assert rec["n"] == 1.5 and rec["i"] == 3
    assert rec["nan"] is None
    assert rec["lst"] == [1, 90.0]


def test_record_key_composite_and_missing() -> None:
    assert record_key({"a": 1, "b": "x"}, ["a", "b"]) == "1|x"
    with pytest.raises(KeyError):
        record_key({"a": None}, ["a"])
    with pytest.raises(ValueError):
        record_key({"a": 1}, [])


def test_diff_snapshots() -> None:
    first = diff_snapshots("t", None, {"1": {"s": "a"}})
    assert [(c.op, c.key) for c in first] == [(ChangeOp.UPSERT, "1"), (ChangeOp.SNAPSHOT_END, "")]
    changes = diff_snapshots("t", {"1": {"s": "a"}, "2": {"s": "b"}}, {"1": {"s": "z"}, "3": {"s": "c"}})
    assert {(c.op, c.key) for c in changes} == {(ChangeOp.UPSERT, "1"), (ChangeOp.UPSERT, "3"), (ChangeOp.DELETE, "2")}


CFG = MappingConfig(
    id_field="bed_id",
    fields={"zone": "unit", "state": "status"},
    state_map={"occupied": "in_use"},
    attributes=["note"],
    kind="bed",
)


def test_apply_mapping_upsert_and_state_map() -> None:
    ch = Change(
        op=ChangeOp.UPSERT,
        dataset="d",
        key="B1",
        record={"bed_id": "B1", "unit": "ICU", "status": "occupied", "note": "x"},
    )
    ev = apply_mapping(ch, CFG, site_id="s", source_id="src", mapping_id="m")
    assert ev.asset_id == "B1" and ev.fields == {
        "zone": "ICU",
        "state": "in_use",
        "kind": "bed",
        "attributes": {"note": "x"},
    }


def test_apply_mapping_missing_key() -> None:
    ch = Change(op=ChangeOp.UPSERT, dataset="d", key="?", record={"unit": "ICU"})
    with pytest.raises(MappingProblem):
        apply_mapping(ch, CFG, site_id="s", source_id="src", mapping_id="m")


def test_validate_columns() -> None:
    assert validate_against_columns(CFG, {"bed_id", "unit", "status", "note"}) == []
    assert validate_against_columns(CFG, {"bed_id"}) != []


def _ev(src: str, mapping: str, fields: dict, op: AssetOp = AssetOp.UPSERT, ts: float = 1.0) -> AssetEvent:
    return AssetEvent(
        site_id="s", asset_id="B1", op=op, source_id=src, mapping_id=mapping, dataset="d", fields=fields, received_ts=ts
    )


# The state-store tests below run against both stores (see tests/unit/conftest.py).


async def test_state_merges_two_sources_and_removes_per_source(store: StateStore) -> None:
    await store.apply(_ev("ehr", "m1", {"state": "in_use", "zone": "ICU"}, ts=1))
    await store.apply(_ev("housekeeping", "m2", {"cleaning": "due"}, ts=2))
    [asset] = await store.site_assets("s")
    flat = asset.flat()
    assert flat["state"] == "in_use" and flat["cleaning"] == "due"
    assert flat["_sources"] == {"state": "ehr", "zone": "ehr", "cleaning": "housekeeping"}

    # Older value never overwrites a newer one
    assert await store.apply(_ev("ehr", "m1", {"state": "free"}, ts=0.5)) is None

    msg = await store.apply(_ev("housekeeping", "m2", {}, op=AssetOp.REMOVE, ts=3))
    assert msg is not None and msg.type == "upsert" and "cleaning" not in msg.assets[0]
    msg = await store.apply(_ev("ehr", "m1", {}, op=AssetOp.REMOVE, ts=4))
    assert msg is not None and msg.type == "remove"
    assert await store.site_assets("s") == []


async def test_state_unchanged_value_not_broadcast(store: StateStore) -> None:
    assert await store.apply(_ev("a", "m", {"state": "x"}, ts=1)) is not None
    assert await store.apply(_ev("a", "m", {"state": "x"}, ts=2)) is None


async def test_subscribe_snapshot_then_live(store: StateStore) -> None:
    await store.apply(_ev("a", "m", {"state": "x"}, ts=1))
    gen = store.subscribe("s")
    first = await anext(gen)
    assert first.type == "snapshot" and len(first.assets) == 1
    await store.apply(_ev("a", "m", {"state": "y"}, ts=2))
    nxt = await asyncio.wait_for(anext(gen), 1)
    assert nxt.type == "upsert" and nxt.assets[0]["state"] == "y"
    await gen.aclose()
