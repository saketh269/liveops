"""State-store fixtures: every test using ``store``/``store_factory`` runs
against the in-memory reference store and the Redis store. The Redis variant
needs ``LIVEOPS_TEST_REDIS_URL`` and uses a unique key prefix per test, deleting
only its own keys afterwards."""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest

from app.core.state import InMemoryStateStore, StateStore

REDIS_URL = os.environ.get("LIVEOPS_TEST_REDIS_URL")
requires_redis = pytest.mark.skipif(not REDIS_URL, reason="LIVEOPS_TEST_REDIS_URL not set")

StoreFactory = Callable[..., StateStore]


async def delete_prefix(prefix: str) -> None:
    import redis.asyncio as aioredis

    assert REDIS_URL
    r = aioredis.Redis.from_url(REDIS_URL, decode_responses=True)
    try:
        keys = [k async for k in r.scan_iter(match=f"{prefix}:*", count=500)]
        if keys:
            await r.delete(*keys)
    finally:
        await r.aclose()


@pytest.fixture
async def redis_prefix() -> AsyncIterator[str]:
    if not REDIS_URL:
        pytest.skip("LIVEOPS_TEST_REDIS_URL not set")
    prefix = f"lotest-{uuid.uuid4().hex}"
    yield prefix
    await delete_prefix(prefix)


@pytest.fixture(params=["memory", pytest.param("redis", marks=requires_redis)])
async def store_factory(request: pytest.FixtureRequest) -> AsyncIterator[StoreFactory]:
    """Makes stores of the parametrized kind. Redis stores made by one factory
    share a prefix, i.e. they behave like several backend processes."""
    made: list[StateStore] = []
    prefix = f"lotest-{uuid.uuid4().hex}"

    def factory(**kwargs: Any) -> StateStore:
        if request.param == "memory":
            s: StateStore = InMemoryStateStore(**kwargs)
        else:
            from app.core.redis_state import RedisStateStore

            assert REDIS_URL
            s = RedisStateStore.from_url(REDIS_URL, prefix=prefix, **kwargs)
        made.append(s)
        return s

    factory.kind = request.param  # type: ignore[attr-defined]
    yield factory
    for s in made:
        await s.close()
    if request.param == "redis":
        await delete_prefix(prefix)


@pytest.fixture
def store(store_factory: StoreFactory) -> StateStore:
    return store_factory()
