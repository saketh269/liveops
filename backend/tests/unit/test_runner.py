"""Runner: rebuild after restart (LIVEOPS-40) and mapping ownership across
processes sharing Redis (LIVEOPS-36). A fake poll connector stands in for the
source; tables live in ``TABLES`` and ``OPEN`` counts running streams."""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import pytest

from app.connectors.base import (
    Category,
    Change,
    ConnectorSpec,
    Dataset,
    Mode,
    PollingConnector,
    Record,
)
from app.connectors.base import (
    TestReport as Report,
)
from app.core.mapping import MappingConfig
from app.core.runner import MappingSpec, RunnerManager
from app.core.state import InMemoryStateStore, StateStore
from tests.unit.conftest import REDIS_URL, StoreFactory, requires_redis

TABLES: dict[str, list[Record]] = {}
OPEN: Counter[str] = Counter()


class FakeTable(PollingConnector):
    spec = ConnectorSpec(
        type="test_fake_table", display_name="Fake table", category=Category.DATABASE, modes=[Mode.POLL],
        settings_schema={"type": "object"},
    )  # fmt: skip

    async def test(self) -> Report:
        return Report.from_steps([], time.monotonic())

    async def discover(self) -> list[Dataset]:
        return []

    async def snapshot(self, dataset: str) -> list[Record]:
        return [dict(r) for r in TABLES[self.settings["table"]]]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        table = self.settings["table"]
        OPEN[table] += 1
        try:
            async for change in super().stream(dataset, key_fields, options):
                yield change
        finally:
            OPEN[table] -= 1


@pytest.fixture(autouse=True)
def fake_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.core.runner.build",
        lambda _type, settings, secrets, source_id=None: FakeTable(settings, secrets, source_id=source_id),
    )


def spec(table: str, mapping_id: str = "m1") -> MappingSpec:
    return MappingSpec(
        mapping_id=mapping_id,
        site_id="s",
        source_id="src",
        source_type="test_fake_table",
        settings={"table": table},
        secrets={},
        dataset="t",
        config=MappingConfig(id_field="id", fields={"state": "state"}),
        options={"poll_interval_s": 0.5},
    )


async def wait_until(pred: Callable[[], Awaitable[bool] | bool], what: str, within: float = 8.0) -> float:
    started = time.monotonic()
    while True:
        ok = pred()
        if not isinstance(ok, bool):
            ok = await ok
        if ok:
            return time.monotonic() - started
        assert time.monotonic() - started < within, f"timed out waiting for {what}"
        await asyncio.sleep(0.05)


async def states(store: StateStore) -> dict[str, Any]:
    return {a.asset_id: a.flat().get("state") for a in await store.site_assets("s")}


# LIVEOPS-40 ------------------------------------------------------------------


async def test_restart_rebuilds_and_drops_rows_deleted_while_down(store_factory: StoreFactory) -> None:
    table = f"beds-{store_factory.kind}"  # type: ignore[attr-defined]
    TABLES[table] = [{"id": "B01", "state": "free"}, {"id": "B10", "state": "free"}]
    store1 = store_factory()
    rm1 = RunnerManager(store1)
    await rm1.start(spec(table))

    async def two_assets() -> bool:
        return set(await states(store1)) == {"B01", "B10"}

    await wait_until(two_assets, "first load")
    await rm1.stop_all()  # backend goes down; its state stays in the store

    TABLES[table] = [{"id": "B01", "state": "while-down"}, {"id": "B50", "state": "new"}]
    # Redis: a new process with a new store object; in memory the state only survives in the same object.
    store2 = store_factory() if store_factory.kind == "redis" else store1  # type: ignore[attr-defined]
    rm2 = RunnerManager(store2)
    await rm2.start(spec(table))

    async def rebuilt() -> bool:
        return await states(store2) == {"B01": "while-down", "B50": "new"}

    took = await wait_until(rebuilt, "rebuild without B10")
    print(f"[{store_factory.kind}] rebuilt after restart in {took:.2f}s")  # type: ignore[attr-defined]
    assert rm2.health["m1"].status == "running"
    texts = [e["asset_id"] for e in await store2.events("s") if e["removed"]]
    assert texts == ["B10"]
    await rm2.stop_all()


# LIVEOPS-48 ------------------------------------------------------------------


async def test_runner_yields_during_a_big_batch() -> None:
    TABLES["big"] = [{"id": f"B{i:04d}", "state": "free"} for i in range(600)]
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    gen = store.subscribe("s")
    await anext(gen)
    seen_before_end: list[int] = []

    async def reader() -> None:
        n = 0
        async for _m in gen:
            n += 1
            if len(await store.site_assets("s")) < 600:
                seen_before_end.append(n)  # we got a turn while the batch was still being applied

    task = asyncio.create_task(reader())
    await rm.start(spec("big"))
    await wait_until(lambda: rm.health["m1"].status == "running", "load")
    task.cancel()
    await rm.stop_all()
    assert seen_before_end, "the WebSocket side never ran while 600 changes were applied"
    assert store._fanout.resyncs == 0


# LIVEOPS-36 ------------------------------------------------------------------


def test_in_memory_mode_keeps_the_plain_runner() -> None:
    from app.main import make_runner

    assert type(make_runner(InMemoryStateStore())) is RunnerManager


class Cluster:
    """Two backend processes (store + runner each) on one Redis, sharing a fake portal DB."""

    def __init__(self, prefix: str) -> None:
        from app.core.cluster import ClusterRunnerManager
        from app.core.redis_state import RedisStateStore

        assert REDIS_URL
        self.db: dict[str, MappingSpec | None] = {}
        self.stores = [RedisStateStore.from_url(REDIS_URL, prefix=prefix) for _ in range(2)]
        self.rms = [
            ClusterRunnerManager.for_store(s, spec_loader=self.load, lease_ttl_s=1.5, instance_id=f"proc{i}")
            for i, s in enumerate(self.stores)
        ]

    async def load(self, mapping_id: str) -> MappingSpec | None:
        return self.db.get(mapping_id)

    def owners(self, mapping_id: str = "m1") -> list[int]:
        return [i for i, rm in enumerate(self.rms) if rm.owns(mapping_id)]

    async def close(self) -> None:
        for rm in self.rms:
            await rm.stop_all()
        for s in self.stores:
            await s.close()


@pytest.fixture
async def cluster(redis_prefix: str) -> AsyncIterator[Cluster]:
    c = Cluster(redis_prefix)
    yield c
    await c.close()


@requires_redis
async def test_cluster_one_owner_and_stop_from_other_process(cluster: Cluster) -> None:
    TABLES["c1"] = [{"id": "B01", "state": "free"}, {"id": "B02", "state": "free"}]
    s = spec("c1")
    cluster.db["m1"] = s
    for rm in cluster.rms:  # both processes boot with the mapping active
        await rm.adopt(s)

    async def loaded() -> bool:
        return len(await states(cluster.stores[0])) == 2

    await wait_until(loaded, "load")
    assert len(cluster.owners()) == 1 and OPEN["c1"] == 1
    await asyncio.sleep(2.0)  # several lease ticks later: still exactly one runner
    assert len(cluster.owners()) == 1 and OPEN["c1"] == 1

    owner_i = cluster.owners()[0]
    other = cluster.rms[1 - owner_i]
    await wait_until(lambda: other.is_running("m1"), "owner's health visible to the other process")
    assert other.health["m1"].as_dict()["owner"] == f"proc{owner_i}"
    assert other.health["m1"].status == "running"

    # Delete the mapping via the process that does NOT run it.
    cluster.db["m1"] = None
    started = time.monotonic()
    await other.stop("m1", site_id="s")
    print(f"stop from non-owner reached the owner in {time.monotonic() - started:.2f}s")
    assert cluster.owners() == [] and OPEN["c1"] == 0
    assert await states(cluster.stores[0]) == {}
    TABLES["c1"].append({"id": "B03", "state": "free"})
    await asyncio.sleep(1.5)  # nobody brings it back
    assert await states(cluster.stores[1]) == {} and OPEN["c1"] == 0


@requires_redis
async def test_cluster_edit_from_other_process_restarts_owner_with_new_spec(cluster: Cluster) -> None:
    TABLES["e1"] = [{"id": "B01", "state": "old"}]
    TABLES["e2"] = [{"id": "B01", "state": "new"}]
    cluster.db["m1"] = spec("e1")
    for rm in cluster.rms:
        await rm.adopt(spec("e1"))

    async def shows(value: str) -> bool:
        return await states(cluster.stores[0]) == {"B01": value}

    await wait_until(lambda: shows("old"), "old spec")
    owner_i = cluster.owners()[0]
    other = cluster.rms[1 - owner_i]
    cluster.db["m1"] = spec("e2")  # the API commits the edit, then restarts via start()
    await other.start(spec("e2"))
    took = await wait_until(lambda: shows("new"), "new spec")
    print(f"edit from non-owner applied in {took:.2f}s")
    await asyncio.sleep(1.0)
    assert len(cluster.owners()) == 1 and OPEN["e1"] == 0 and OPEN["e2"] == 1


@requires_redis
async def test_cluster_takes_over_when_owner_dies(cluster: Cluster) -> None:
    TABLES["f1"] = [{"id": "B01", "state": "free"}]
    cluster.db["m1"] = spec("f1")
    for rm in cluster.rms:
        await rm.adopt(spec("f1"))
    await wait_until(lambda: len(cluster.owners()) == 1, "an owner")
    owner_i = cluster.owners()[0]
    owner, other = cluster.rms[owner_i], cluster.rms[1 - owner_i]
    # Crash: background tasks and runner die, the lease is NOT handed back.
    for t in [*owner._bg, *owner._tasks.values()]:
        t.cancel()
    await asyncio.sleep(0.1)
    assert OPEN["f1"] == 0
    took = await wait_until(lambda: other.owns("m1"), "takeover", within=6)
    print(f"takeover after owner crash: {took:.2f}s (lease ttl 1.5 s)")
    TABLES["f1"][0]["state"] = "in_use"

    async def live() -> bool:
        return await states(cluster.stores[1 - owner_i]) == {"B01": "in_use"}

    await wait_until(live, "changes flow again")
    assert OPEN["f1"] == 1
    owner._bg = []  # already cancelled; let close() skip it
