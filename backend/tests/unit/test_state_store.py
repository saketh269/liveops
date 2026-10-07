"""State store semantics, event log, feed and concurrency, run against both the
in-memory and the Redis store (see conftest.py)."""

from __future__ import annotations

import asyncio
import random
import time
from typing import Any

import pytest

from app.core.eventlog import describe
from app.core.events import AssetEvent, AssetOp, StreamMessage
from app.core.state import StateStore
from tests.unit.conftest import StoreFactory, requires_redis


def ev(
    fields: dict[str, Any] | None = None,
    *,
    asset: str = "B1",
    src: str = "ehr",
    mapping: str = "m1",
    op: AssetOp = AssetOp.UPSERT,
    ts: float | None = None,
    site: str = "s",
) -> AssetEvent:
    return AssetEvent(
        site_id=site,
        asset_id=asset,
        op=op,
        source_id=src,
        mapping_id=mapping,
        dataset="d",
        fields=fields or {},
        received_ts=time.time() if ts is None else ts,
    )


async def next_msg(gen: Any) -> StreamMessage:
    return await asyncio.wait_for(anext(gen), 2.0)


async def test_values_round_trip_exactly(store: StateStore) -> None:
    fields = {
        "state": "in_use",
        "count": 3,
        "big": 2**60 + 1,  # beyond double precision
        "ratio": 0.1 + 0.2,
        "flag": False,
        "none": None,
        "label": "Bett ü · 床 🛏",
        "attributes": {"b": [1, 2.5, "x"], "a": {"nested": True}},
    }
    await store.apply(ev(fields, asset="Ward:1/B{1}"))
    [asset] = await store.site_assets("s")
    assert asset.asset_id == "Ward:1/B{1}"
    flat = asset.flat()
    for k, v in fields.items():
        assert flat[k] == v and type(flat[k]) is type(v), k
    assert set(flat["_sources"]) == set(fields)


async def test_remove_is_per_mapping_and_noop_when_nothing_to_drop(store: StateStore) -> None:
    assert await store.apply(ev(op=AssetOp.REMOVE)) is None  # unknown asset
    await store.apply(ev({"state": "in_use"}, src="ehr", mapping="m1", ts=1))
    assert await store.apply(ev(src="hk", mapping="m2", op=AssetOp.REMOVE, ts=2)) is None
    assert await store.apply(ev({}, ts=3)) is None  # empty upsert changes nothing
    [asset] = await store.site_assets("s")
    assert asset.flat()["state"] == "in_use"


async def test_empty_upsert_does_not_create_asset(store: StateStore) -> None:
    assert await store.apply(ev({}, asset="ghost")) is None
    assert await store.site_assets("s") == []


async def test_same_value_from_other_source_updates_attribution(store: StateStore) -> None:
    await store.apply(ev({"state": "x"}, src="a", mapping="m1", ts=1))
    msg = await store.apply(ev({"state": "x"}, src="b", mapping="m2", ts=2))
    assert msg is not None and msg.assets[0]["_sources"] == {"state": "b"}
    assert await store.events("s") and len(await store.events("s")) == 1  # no value change, no log entry


async def test_clear_mapping_drops_only_that_mapping(store: StateStore) -> None:
    await store.apply(ev({"state": "in_use"}, asset="B1", src="ehr", mapping="m1", ts=1))
    await store.apply(ev({"cleaning": "due"}, asset="B1", src="hk", mapping="m2", ts=2))
    await store.apply(ev({"cleaning": "done"}, asset="B2", src="hk", mapping="m2", ts=3))
    await store.clear_mapping("s", "m2")
    assets = {a.asset_id: a.flat() for a in await store.site_assets("s")}
    assert set(assets) == {"B1"}
    assert "cleaning" not in assets["B1"] and assets["B1"]["state"] == "in_use"


async def test_sites_are_isolated(store: StateStore) -> None:
    await store.apply(ev({"state": "a"}, site="s1"))
    await store.apply(ev({"state": "b"}, site="s2"))
    assert [a.flat()["state"] for a in await store.site_assets("s1")] == ["a"]
    assert [e["changes"] for e in await store.events("s2")] == [{"state": [None, "b"]}]


async def test_event_log_entries_paging_and_text(store: StateStore) -> None:
    await store.apply(ev({"state": "free", "zone": "ICU"}, ts=1))
    await store.apply(ev({"state": "in_use"}, ts=2))
    await store.apply(ev({"state": "in_use"}, ts=3))  # unchanged: no entry
    await store.apply(ev(op=AssetOp.REMOVE, ts=4))
    entries = await store.events("s")
    assert [e["changes"] for e in entries] == [
        {"state": [None, "free"], "zone": [None, "ICU"]},
        {"state": ["free", "in_use"]},
        {"state": ["in_use", None], "zone": ["ICU", None]},
    ]
    assert [e["removed"] for e in entries] == [False, False, True]
    assert all(e["asset_id"] == "B1" and e["source_id"] == "ehr" and e["site_id"] == "s" for e in entries)
    ts = [e["ts"] for e in entries]
    assert ts == sorted(ts) and len(set(ts)) == 3
    assert describe(entries[1]) == "B1 state free → in_use"
    assert describe(entries[2]) == "B1 removed"

    assert await store.events("s", since=ts[0]) == entries[1:]
    assert await store.events("s", since=ts[0], limit=1) == [entries[1]]
    assert await store.events("s", since=ts[-1]) == []
    assert await store.events("s", limit=2) == entries[1:]  # latest N, oldest first
    assert await store.events("nope") == []


async def test_event_log_limit_capped_at_1000(store: StateStore) -> None:
    for i in range(1005):
        await store.apply(ev({"n": i}, ts=float(i + 1)))
    assert len(await store.events("s", limit=5000)) == 1000
    assert len(await store.events("s", since=0, limit=5000)) == 1000


async def test_event_log_is_bounded(store_factory: StoreFactory) -> None:
    store = store_factory(eventlog_maxlen=10)
    for i in range(400):
        await store.apply(ev({"n": i}, ts=float(i + 1)))
    entries = await store.events("s", since=0, limit=1000)
    if store_factory.kind == "memory":  # type: ignore[attr-defined]
        assert len(entries) == 10
    else:  # Redis trims approximately, whole stream nodes (100 entries) at a time
        assert 10 <= len(entries) <= 110
    assert entries[-1]["changes"] == {"n": [398, 399]}


async def test_subscriber_gets_upsert_then_feed_event(store: StateStore) -> None:
    await store.apply(ev({"state": "free"}, asset="B01", ts=1))
    gen = store.subscribe("s")
    assert (await next_msg(gen)).type == "snapshot"
    await store.apply(ev({"state": "in_use"}, asset="B01", ts=2))
    up = await next_msg(gen)
    assert up.type == "upsert" and up.assets[0]["state"] == "in_use"
    fe = await next_msg(gen)
    assert fe.type == "event" and fe.event is not None
    assert fe.event["text"] == "B01 state free → in_use"
    assert fe.event["asset_id"] == "B01" and fe.event["source_id"] == "ehr"
    assert fe.event["changes"] == {"state": ["free", "in_use"]}
    await store.apply(ev(asset="B01", op=AssetOp.REMOVE, ts=3))
    rm = await next_msg(gen)
    assert rm.type == "remove" and rm.assets == [{"asset_id": "B01"}]
    assert (await next_msg(gen)).event["text"] == "B01 removed"  # type: ignore[index]
    await gen.aclose()


async def test_subscriber_only_sees_its_site(store: StateStore) -> None:
    gen = store.subscribe("s1")
    await next_msg(gen)
    await store.apply(ev({"state": "x"}, site="s2"))
    await store.apply(ev({"state": "y"}, site="s1"))
    msg = await next_msg(gen)
    assert msg.site_id == "s1" and msg.assets[0]["state"] == "y"
    await gen.aclose()


async def test_slow_subscriber_gets_fresh_snapshot(store_factory: StoreFactory) -> None:
    store = store_factory(queue_size=4)
    gen = store.subscribe("s")
    await next_msg(gen)
    for i in range(50):  # nobody reads: the queue overflows
        await store.apply(ev({"n": i}, ts=float(i + 1)))
    await asyncio.sleep(0.3)  # Redis: let pub/sub deliver
    msg = await next_msg(gen)
    assert msg.type == "snapshot" and msg.assets[0]["n"] == 49
    await gen.aclose()


async def test_unsubscribe_cleans_up(store: StateStore) -> None:
    gens = [store.subscribe("s") for _ in range(3)]
    for g in gens:
        await next_msg(g)
    for g in gens:
        await g.aclose()
    assert store._fanout.count("s") == 0
    # A new subscriber right after still works.
    g = store.subscribe("s")
    await next_msg(g)
    await store.apply(ev({"state": "z"}))
    assert (await next_msg(g)).assets[0]["state"] == "z"
    await g.aclose()


async def test_concurrent_applies_to_one_asset_lose_nothing(store_factory: StoreFactory) -> None:
    # Two store objects: two backend processes when Redis, one shared lock each when in memory.
    a = store_factory()
    b = a if store_factory.kind == "memory" else store_factory()  # type: ignore[attr-defined]
    n = 200
    await asyncio.gather(
        *[(a if i % 2 else b).apply(ev({f"f{i}": i}, src=f"src{i % 2}", mapping=f"m{i % 2}")) for i in range(n)]
    )
    [asset] = await a.site_assets("s")
    assert {k: v.value for k, v in asset.fields.items()} == {f"f{i}": i for i in range(n)}

    # Latest-wins under contention: whatever order they land in, the newest ts wins.
    stamps = [1000.0 + i for i in range(n)]
    random.shuffle(stamps)
    await asyncio.gather(*[(a if i % 2 else b).apply(ev({"state": t}, ts=t)) for i, t in enumerate(stamps)])
    [asset] = await b.site_assets("s")
    assert asset.fields["state"].value == max(stamps)
    assert asset.fields["state"].updated_ts == max(stamps)


@requires_redis
async def test_two_processes_share_state_and_updates(store_factory: StoreFactory) -> None:
    if store_factory.kind != "redis":  # type: ignore[attr-defined]
        pytest.skip("only meaningful for the shared Redis store")
    viewer, writer = store_factory(), store_factory()
    gen = viewer.subscribe("s")
    assert (await next_msg(gen)).assets == []
    started = time.perf_counter()
    await writer.apply(ev({"state": "in_use"}, asset="B01", src="ehr", mapping="m1"))
    up = await next_msg(gen)
    latency_ms = (time.perf_counter() - started) * 1000
    print(f"apply in process B -> subscriber in process A: {latency_ms:.1f} ms")
    assert up.type == "upsert" and up.assets[0]["state"] == "in_use"
    assert (await next_msg(gen)).type == "event"
    await writer.apply(ev({"cleaning": "due"}, asset="B01", src="hk", mapping="m2"))
    up = await next_msg(gen)
    assert up.assets[0]["_sources"] == {"state": "ehr", "cleaning": "hk"}
    [asset] = await viewer.site_assets("s")
    assert asset.flat()["cleaning"] == "due"
    assert len(await viewer.events("s")) == 2
    await gen.aclose()
