"""State store semantics, event log, feed and concurrency, run against both the
in-memory and the Redis store (see conftest.py)."""

from __future__ import annotations

import asyncio
import contextlib
import json
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
    attached: bool = False,
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
        attached=attached,
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
    assert set(flat["_sources"]) == set(fields) | {"attributes.a", "attributes.b"}


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
    assert describe(entries[1]) == "B1 is in use (was free)"
    assert describe(entries[2]) == "B1 left the map"

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
    assert fe.event["text"] == "B01 is in use (was free)"
    assert fe.event["asset_id"] == "B01" and fe.event["source_id"] == "ehr"
    assert fe.event["changes"] == {"state": ["free", "in_use"]}
    await store.apply(ev(asset="B01", op=AssetOp.REMOVE, ts=3))
    rm = await next_msg(gen)
    assert rm.type == "remove" and rm.assets == [{"asset_id": "B01"}]
    assert (await next_msg(gen)).event["text"] == "B01 left the map"  # type: ignore[index]
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


# LIVEOPS-44: attributes merge per key, with a source per key.


async def test_attributes_merge_per_key_across_sources(store: StateStore) -> None:
    await store.apply(ev({"state": "in_use", "attributes": {"patient_count": 0}}, src="ehr", mapping="m1", ts=1))
    msg = await store.apply(ev({"cleaning": "due", "attributes": {"cleaner": "C0"}}, src="hk", mapping="m2", ts=2))
    assert msg is not None and msg.assets[0]["attributes"] == {"patient_count": 0, "cleaner": "C0"}
    [asset] = await store.site_assets("s")
    flat = asset.flat()
    assert flat["attributes"] == {"patient_count": 0, "cleaner": "C0"}
    assert flat["_sources"]["attributes.patient_count"] == "ehr"
    assert flat["_sources"]["attributes.cleaner"] == "hk"
    assert "attributes" not in flat["_sources"]  # two sources: no single owner
    assert not any(k.startswith("attributes.") for k in flat if k != "_sources")

    # A newer poll of the EHR only changes its own key.
    await store.apply(ev({"state": "in_use", "attributes": {"patient_count": 2}}, src="ehr", mapping="m1", ts=3))
    [asset] = await store.site_assets("s")
    assert asset.flat()["attributes"] == {"patient_count": 2, "cleaner": "C0"}
    last = (await store.events("s"))[-1]
    assert last["changes"] == {"attributes.patient_count": [0, 2]}
    assert describe(last) == "B1 patient count is now 2"

    # Removing housekeeping drops only its attribute key.
    msg = await store.apply(ev(src="hk", mapping="m2", op=AssetOp.REMOVE, ts=4))
    assert msg is not None and msg.assets[0]["attributes"] == {"patient_count": 2}
    assert msg.assets[0]["_sources"]["attributes"] == "ehr"  # one source again
    await store.clear_mapping("s", "m1")
    assert await store.site_assets("s") == []


async def test_single_source_attributes_keep_shape(store: StateStore) -> None:
    msg = await store.apply(ev({"attributes": {"a": 1, "b": None}}, src="ehr"))
    assert msg is not None and msg.assets[0]["attributes"] == {"a": 1, "b": None}
    assert msg.assets[0]["_sources"]["attributes"] == "ehr"
    gen = store.subscribe("s")
    snap = await next_msg(gen)
    assert snap.assets[0]["attributes"] == {"a": 1, "b": None}
    await gen.aclose()


# LIVEOPS-40: reconcile after a snapshot.


async def test_reconcile_drops_only_unseen_assets_of_that_mapping(store: StateStore) -> None:
    for a in ("B01", "B02", "B10"):
        await store.apply(ev({"state": "free"}, asset=a, src="ehr", mapping="m1", ts=1))
    await store.apply(ev({"cleaning": "due"}, asset="B10", src="hk", mapping="m2", ts=2))
    await store.apply(ev({"cleaning": "due"}, asset="B20", src="hk", mapping="m2", ts=2))
    gen = store.subscribe("s")
    await next_msg(gen)
    assert await store.reconcile("s", "m1", {"B01", "B02"}) == 1
    assets = {a.asset_id: a.flat() for a in await store.site_assets("s")}
    assert set(assets) == {"B01", "B02", "B10", "B20"}
    assert "state" not in assets["B10"] and assets["B10"]["cleaning"] == "due"  # hk keeps its fields
    up = await next_msg(gen)
    assert up.type == "upsert" and up.assets[0]["asset_id"] == "B10"
    assert (await next_msg(gen)).event["changes"] == {"state": ["free", None]}  # type: ignore[index]
    assert await store.reconcile("s", "m2", set()) == 2
    assert {a.asset_id for a in await store.site_assets("s")} == {"B01", "B02"}
    assert await store.reconcile("s", "m1", {"B01", "B02"}) == 0
    await gen.aclose()


@requires_redis
async def test_redis_reconcile_matches_generic_reconcile(store_factory: StoreFactory) -> None:
    if store_factory.kind != "redis":  # type: ignore[attr-defined]
        pytest.skip("parity of the Redis override with the generic default")
    import uuid

    from app.core.redis_state import RedisStateStore
    from tests.unit.conftest import REDIS_URL, delete_prefix

    fast = store_factory()
    generic_prefix = f"lotest-{uuid.uuid4().hex}"
    assert REDIS_URL
    generic = RedisStateStore.from_url(REDIS_URL, prefix=generic_prefix)
    try:
        for s in (fast, generic):
            for i in range(30):
                await s.apply(ev({"state": "x", "attributes": {"n": i}}, asset=f"A{i}", src="e", mapping="m1", ts=1))
                if i % 3 == 0:
                    await s.apply(ev({"cleaning": "due"}, asset=f"A{i}", src="h", mapping="m2", ts=2))
        keep = {f"A{i}" for i in range(0, 30, 2)}
        n_fast = await fast.reconcile("s", "m1", keep)
        n_generic = await StateStore.reconcile(generic, "s", "m1", keep)  # the base-class default
        assert n_fast == n_generic == 15

        def view(assets: list) -> dict:
            return {a.asset_id: {k: (v.value, v.source_id, v.mapping_id) for k, v in a.fields.items()} for a in assets}

        assert view(await fast.site_assets("s")) == view(await generic.site_assets("s"))

        def changes(entries: list) -> list:
            return sorted((e["asset_id"], json.dumps(e["changes"], sort_keys=True), e["removed"]) for e in entries)

        assert changes(await fast.events("s", limit=1000)) == changes(await generic.events("s", limit=1000))
    finally:
        await generic.close()
        await delete_prefix(generic_prefix)


# LIVEOPS-48: a big batch must not resync a client that keeps up.


async def test_big_batch_does_not_resync_a_healthy_client(store_factory: StoreFactory) -> None:
    store = store_factory()
    n = 2000
    for i in range(n):
        await store.apply(ev({"state": "free"}, asset=f"B{i:04d}", ts=1.0))
    gen = store.subscribe("s")
    snap = await next_msg(gen)
    assert len(snap.assets) == n
    got: list[StreamMessage] = []
    all_in = asyncio.Event()

    async def reader() -> None:
        async for m in gen:
            got.append(m)
            if len(got) >= 3000:
                all_in.set()

    task = asyncio.create_task(reader())
    before = store._fanout.resyncs
    # One poll's worth of changes applied back to back, without yielding in between.
    for i in range(1500):
        await store.apply(ev({"state": "in_use"}, asset=f"B{i:04d}", ts=2.0))
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(all_in.wait(), 10)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert store._fanout.resyncs == before
    assert not any(m.type == "snapshot" for m in got)
    assert sum(m.type == "upsert" for m in got) == 1500 and sum(m.type == "event" for m in got) == 1500


# LIVEOPS-92: a shared field falls back to the other source's value.


async def test_shared_field_falls_back_when_newer_source_leaves(store: StateStore) -> None:
    await store.apply(ev({"label": "Bed 01", "state": "free"}, src="ehr", mapping="m1", ts=1))
    await store.apply(ev({"label": "Isolation"}, src="wh", mapping="m2", ts=2))
    [asset] = await store.site_assets("s")
    assert asset.flat()["label"] == "Isolation" and asset.flat()["_sources"]["label"] == "wh"
    msg = await store.apply(ev(src="wh", mapping="m2", op=AssetOp.REMOVE, ts=3))
    assert msg is not None and msg.type == "upsert"
    assert msg.assets[0]["label"] == "Bed 01" and msg.assets[0]["_sources"]["label"] == "ehr"
    last = (await store.events("s"))[-1]
    assert last["changes"] == {"label": ["Isolation", "Bed 01"]} and not last["removed"]
    assert describe(last) == "B1 is now called Bed 01"


async def test_shared_field_falls_back_on_clear_mapping_and_for_attribute_keys(store: StateStore) -> None:
    await store.apply(ev({"label": "Bed 01", "attributes": {"note": "a"}}, src="ehr", mapping="m1", ts=1))
    await store.apply(ev({"label": "Isolation", "attributes": {"note": "b"}}, src="wh", mapping="m2", ts=2))
    await store.clear_mapping("s", "m2")
    [asset] = await store.site_assets("s")
    flat = asset.flat()
    assert flat["label"] == "Bed 01" and flat["attributes"] == {"note": "a"}
    assert flat["_sources"] == {"label": "ehr", "attributes.note": "ehr", "attributes": "ehr"}


async def test_older_contribution_waits_hidden_and_shows_when_winner_leaves(store: StateStore) -> None:
    await store.apply(ev({"label": "new"}, src="a", mapping="m1", ts=2))
    assert await store.apply(ev({"label": "old"}, src="b", mapping="m2", ts=1)) is None  # older: not visible
    [asset] = await store.site_assets("s")
    assert asset.flat()["label"] == "new"
    # The hidden contribution leaving changes nothing visible.
    assert await store.apply(ev(src="b", mapping="m2", op=AssetOp.REMOVE, ts=3)) is None
    await store.apply(ev({"label": "old"}, src="b", mapping="m2", ts=1))
    msg = await store.apply(ev(src="a", mapping="m1", op=AssetOp.REMOVE, ts=4))
    assert msg is not None and msg.assets[0]["label"] == "old" and msg.assets[0]["_sources"] == {"label": "b"}
    # Same mapping, older ts: ignored (its own newer value stands).
    assert await store.apply(ev({"label": "older"}, src="b", mapping="m2", ts=0.5)) is None
    msg = await store.apply(ev(src="b", mapping="m2", op=AssetOp.REMOVE, ts=5))
    assert msg is not None and msg.type == "remove"
    assert await store.site_assets("s") == []


@requires_redis
async def test_random_merge_sequences_match_between_stores(store_factory: StoreFactory) -> None:
    """Parity: the Redis store gives exactly the reference store's results."""
    if store_factory.kind != "redis":  # type: ignore[attr-defined]
        pytest.skip("compares the Redis store against the in-memory reference")
    from app.core.state import InMemoryStateStore

    rnd = random.Random(92)
    redis_store, ref = store_factory(), InMemoryStateStore()
    for step in range(900):
        mapping = rnd.choice(["m1", "m2", "m3", "m4"])  # m3, m4: attached (LIVEOPS-116)
        attached = mapping in ("m3", "m4")
        asset = rnd.choice(["A", "B", "C"])
        ts = float(rnd.randint(1, 40))  # small range: plenty of equal timestamps
        if rnd.random() < 0.25:
            e = ev(asset=asset, src=f"src-{mapping}", mapping=mapping, op=AssetOp.REMOVE, ts=ts)
        else:
            names = rnd.sample(["state", "label", "zone"], rnd.randint(1, 3))
            fields: dict[str, Any] = {n: rnd.choice(["x", "y", "z"]) for n in names}
            if rnd.random() < 0.5:
                fields["attributes"] = {rnd.choice(["status", "k2"]): rnd.choice(["a", "b", None])}
            e = ev(fields, asset=asset, src=f"src-{mapping}", mapping=mapping, ts=ts, attached=attached)
        got, want = await redis_store.apply(e), await ref.apply(e)
        assert (got and (got.type, got.assets)) == (want and (want.type, want.assets)), f"step {step}: {e}"
    assert {a.asset_id: a.flat() for a in await redis_store.site_assets("s")} == {
        a.asset_id: a.flat() for a in await ref.site_assets("s")
    }

    def changes(entries: list) -> list:
        return [(e["asset_id"], e["changes"], e["removed"]) for e in entries]

    assert changes(await redis_store.events("s", limit=1000)) == changes(await ref.events("s", limit=1000))


# LIVEOPS-116 / LIVEOPS-115: an attached mapping (transport on a patient,
# cleaning task on a bed) never takes over the record's own status.


def transport(fields: dict[str, Any] | None, ts: float, op: AssetOp = AssetOp.UPSERT) -> AssetEvent:
    return ev(fields, asset="P1", src="tr", mapping="m-tr", ts=ts, op=op, attached=True)


def patient(fields: dict[str, Any] | None, ts: float, op: AssetOp = AssetOp.UPSERT) -> AssetEvent:
    return ev(fields, asset="P1", src="ehr", mapping="m-pt", ts=ts, op=op)


async def test_attached_status_never_replaces_own_status_live_or_after_reload(store: StateStore) -> None:
    await store.apply(
        patient({"state": "alert", "attributes": {"status": "waiting_for_provider", "bed_id": "ED-02"}}, 1)
    )
    live = await store.apply(transport({"attributes": {"status": "in_progress", "to": "Radiology – MRI"}}, 2))
    assert live is not None and live.type == "upsert"
    want_attached = {"m-tr": {"source_id": "tr", "attributes": {"status": "in_progress", "to": "Radiology – MRI"}}}
    for view in (live.assets[0], (await store.site_assets("s"))[0].flat()):
        # The patient's own status wins the merged field, however new the transport is.
        assert view["attributes"]["status"] == "waiting_for_provider"
        assert view["_sources"]["attributes.status"] == "ehr" and view["state"] == "alert"
        # The transport's own values stay available; keys only it sends still merge in.
        assert view["_attached"] == want_attached
        assert view["attributes"]["to"] == "Radiology – MRI" and view["_sources"]["attributes.to"] == "tr"
    # A reload (snapshot from the store) gives exactly what the live stream gave.
    gen = store.subscribe("s")
    snap = await next_msg(gen)
    await gen.aclose()
    assert snap.assets == live.assets
    # The transport's event records its own status; the patient's records the patient's.
    assert (await store.events("s"))[-1]["changes"]["attributes.status"] == [None, "in_progress"]
    await store.apply(transport({"attributes": {"status": "done", "to": "Radiology – MRI"}}, 3))
    assert (await store.events("s"))[-1]["changes"] == {"attributes.status": ["in_progress", "done"]}
    [a] = await store.site_assets("s")
    assert a.flat()["attributes"]["status"] == "waiting_for_provider"
    assert a.flat()["_attached"]["m-tr"]["attributes"]["status"] == "done"
    await store.apply(patient({"state": "in_use", "attributes": {"status": "in_treatment", "bed_id": "ED-02"}}, 4))
    last = (await store.events("s"))[-1]
    assert last["changes"]["attributes.status"] == ["waiting_for_provider", "in_treatment"]
    # The transport leaving drops only its namespace and its own keys.
    msg = await store.apply(transport(None, 5, op=AssetOp.REMOVE))
    assert msg is not None and msg.type == "upsert"
    assert "_attached" not in msg.assets[0] and msg.assets[0]["attributes"] == {
        "status": "in_treatment",
        "bed_id": "ED-02",
    }
    assert (await store.events("s"))[-1]["changes"] == {
        "attributes.status": ["done", None],
        "attributes.to": ["Radiology – MRI", None],
    }


async def test_own_status_wins_even_when_attached_arrived_first(store: StateStore) -> None:
    await store.apply(transport({"attributes": {"status": "requested"}}, 1))
    [a] = await store.site_assets("s")
    assert a.flat()["attributes"]["status"] == "requested"  # nothing of its own yet: details only
    await store.apply(patient({"state": "alert", "attributes": {"status": "boarding"}}, 0.5))  # older, still wins
    [a] = await store.site_assets("s")
    assert a.flat()["attributes"]["status"] == "boarding" and a.flat()["_sources"]["attributes.status"] == "ehr"
    assert (await store.events("s"))[-1]["changes"]["attributes.status"] == [None, "boarding"]
    # The patient leaving: its own status is gone (not "now requested").
    await store.apply(patient(None, 2, op=AssetOp.REMOVE))
    last = (await store.events("s"))[-1]
    assert last["changes"] == {"state": ["alert", None], "attributes.status": ["boarding", None]}
    assert describe(last) == "P1 is no longer in this source (still reported by another)"
    [a] = await store.site_assets("s")
    assert a.flat()["attributes"] == {"status": "requested"}


async def test_bed_event_text_uses_the_beds_own_previous_status(store: StateStore) -> None:
    bed = {"asset": "ED-11", "src": "beds", "mapping": "m-bed"}
    task = {"asset": "ED-11", "src": "evs", "mapping": "m-clean", "attached": True}
    await store.apply(ev({"state": "in_use", "attributes": {"status": "occupied"}}, ts=1, **bed))  # type: ignore[arg-type]
    await store.apply(ev({"attributes": {"status": "queued", "priority": "stat"}}, ts=2, **task))  # type: ignore[arg-type]
    await store.apply(ev({"state": "cleaning", "attributes": {"status": "dirty"}}, ts=3, **bed))  # type: ignore[arg-type]
    last = (await store.events("s"))[-1]
    assert last["changes"]["attributes.status"] == ["occupied", "dirty"]
    assert describe(last) == "ED-11 is dirty (was occupied)"
    [a] = await store.site_assets("s")
    assert a.flat()["_attached"] == {
        "m-clean": {"source_id": "evs", "attributes": {"status": "queued", "priority": "stat"}}
    }


# LIVEOPS-55: a burst of removes (pause/delete/reconcile) must not resync viewers.


async def test_remove_burst_does_not_resync_a_healthy_client(store_factory: StoreFactory) -> None:
    store = store_factory()
    n = 2000
    for i in range(n):
        await store.apply(ev({"state": "free"}, asset=f"B{i:04d}", mapping="m2", ts=1.0))
    gen = store.subscribe("s")
    assert len((await next_msg(gen)).assets) == n
    got: list[StreamMessage] = []
    all_in = asyncio.Event()

    async def reader() -> None:
        async for m in gen:
            got.append(m)
            if sum(x.type == "remove" for x in got) >= n:
                all_in.set()

    task = asyncio.create_task(reader())
    before = store._fanout.resyncs
    await store.clear_mapping("s", "m2")
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(all_in.wait(), 15)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert store._fanout.resyncs == before
    assert sum(m.type == "remove" for m in got) == n and not any(m.type == "snapshot" for m in got)


# LIVEOPS-53: more concurrent Redis calls than the pool has connections wait instead of failing.


@requires_redis
@pytest.mark.parametrize("pool", [200, 10])
async def test_many_parallel_snapshots_succeed(store_factory: StoreFactory, pool: int) -> None:
    if store_factory.kind != "redis":  # type: ignore[attr-defined]
        pytest.skip("Redis connection pool")
    store = store_factory(max_connections=pool)
    await store.apply(ev({"state": "free"}))
    results = await asyncio.gather(*(store.site_assets("s") for _ in range(400)), return_exceptions=True)
    errors = [r for r in results if isinstance(r, BaseException)]
    assert not errors, f"{len(errors)} of 400 failed, e.g. {errors[0]!r}"
