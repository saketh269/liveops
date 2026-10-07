"""Mapping ownership across backend processes that share a Redis store (LIVEOPS-36).

Without this, every process would run every mapping (N× source load, N
replication slots) and a stop or edit would only reach the process that
handled the request.

How it works (keys under ``<prefix>:``):

- **Lease** ``runner:lease:<mapping_id>`` = owner instance id, ``SET NX PX``.
  Only the holder runs the mapping and renews the lease every ttl/3. A holder
  that fails to renew stops its runner. Every process that wants the mapping
  tries to take the lease on each tick, so when a holder dies another process
  takes over within about one lease ttl.
- **Control**: ``start``/``stop`` bump ``{runner}:ver[mapping_id]``, record
  ``{runner}:op[mapping_id]`` and PUBLISH on ``runner:ctl`` in one script.
  Every process reacts at once (start: reload the spec from the portal DB, so
  no secrets travel through Redis; stop: drop it). The tick also re-reads the
  version hash, so a missed message is caught up within one tick.
- **Health**: the holder writes its mapping health to ``runner:health``; any
  process answers ``/api/health/mappings`` with the owner's view.

In-memory deployments keep using ``RunnerManager`` (single process).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import socket
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.core.redis_state import RedisStateStore
from app.core.runner import MappingHealth, MappingSpec, RunnerManager
from app.core.state import StateStore

log = logging.getLogger("liveops.cluster")

SpecLoader = Callable[[str], Awaitable[MappingSpec | None]]

_RENEW_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
"""
_RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""
# KEYS: 1 version hash, 2 op hash. ARGV: 1 mapping id, 2 op, 3 channel, 4 sender.
_ANNOUNCE_LUA = """
local v = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('PUBLISH', ARGV[3], cjson.encode({mapping_id = ARGV[1], v = v, op = ARGV[2], sender = ARGV[4]}))
return v
"""


class _RemoteHealth(MappingHealth):
    """Health reported by the process that owns the mapping."""

    def __init__(self, data: dict[str, Any]) -> None:
        super().__init__(str(data.get("mapping_id", "")), str(data.get("source_id", "")))
        self.status = str(data.get("status", "running"))
        self._data = data

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self._data.items() if k != "reported_ts"}


class ClusterRunnerManager(RunnerManager):
    def __init__(
        self,
        state: StateStore,
        redis: aioredis.Redis,
        *,
        prefix: str,
        spec_loader: SpecLoader,
        lease_ttl_s: float = 10.0,
        instance_id: str | None = None,
    ) -> None:
        super().__init__(state)
        self._r: Any = redis
        self._load = spec_loader
        self.instance_id = instance_id or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self._ttl_s = lease_ttl_s
        self._tick_s = lease_ttl_s / 3
        # LIVEOPS-52: we only trust a lease until (time the SET/renew was sent +
        # ttl - margin), measured on our own monotonic clock. The watchdog stops
        # the local runner at that point whatever Redis is doing, so the lease
        # can never lapse to another process while we still run the mapping.
        self._margin_s = lease_ttl_s / 4
        self._call_timeout_s = lease_ttl_s / 5
        self._valid_until: dict[str, float] = {}
        # After our lease went stale, leave the mapping to healthy peers for one ttl.
        self._backoff_until: dict[str, float] = {}
        self._lease_prefix = f"{prefix}:runner:lease:"
        self._ver_key = f"{prefix}:{{runner}}:ver"
        self._op_key = f"{prefix}:{{runner}}:op"
        self._health_key = f"{prefix}:runner:health"
        self._channel = f"{prefix}:runner:ctl"
        self._renew = redis.register_script(_RENEW_LUA)
        self._release_lease = redis.register_script(_RELEASE_LUA)
        self._announce_script = redis.register_script(_ANNOUNCE_LUA)
        self._wanted: dict[str, MappingSpec] = {}  # mappings this process may run
        self._seen_ver: dict[str, int] = {}
        self._remote: dict[str, dict[str, Any]] = {}  # fresh health of mappings owned elsewhere
        self._lock = asyncio.Lock()
        self._bg: list[asyncio.Task[None]] = []
        self._listening = asyncio.Event()

    @classmethod
    def for_store(cls, store: RedisStateStore, *, spec_loader: SpecLoader, **kwargs: Any) -> ClusterRunnerManager:
        return cls(store, store.redis, prefix=store.prefix, spec_loader=spec_loader, **kwargs)

    # -- public API (same as RunnerManager) ---------------------------------

    @property
    def health(self) -> dict[str, MappingHealth]:
        out: dict[str, MappingHealth] = dict(self._health)
        for mid, data in self._remote.items():
            if not self._running_here(mid):
                out[mid] = _RemoteHealth(data)
        return out

    def is_running(self, mapping_id: str) -> bool:
        return self._running_here(mapping_id) or mapping_id in self._remote

    def owns(self, mapping_id: str) -> bool:
        return self._running_here(mapping_id)

    async def start(self, spec: MappingSpec) -> None:
        """Start or restart a mapping on whichever process gets its lease."""
        await self._ensure_background()
        mid = spec.mapping_id
        async with self._lock:
            self._wanted.pop(mid, None)
            await self._release(mid)
            self._seen_ver[mid] = await self._announce(mid, "start")
            self._wanted[mid] = spec
            await self._try_acquire(mid)

    async def adopt(self, spec: MappingSpec) -> None:
        """At startup: want an active mapping without restarting its current owner."""
        await self._ensure_background()
        mid = spec.mapping_id
        async with self._lock:
            ver = await self._r.hget(self._ver_key, mid)
            self._seen_ver[mid] = int(ver or 0)
            self._wanted[mid] = spec
            await self._try_acquire(mid)

    async def stop(self, mapping_id: str, *, clear: bool = True, site_id: str | None = None) -> None:
        """Stop a mapping on every process. Waits (up to 5 s) until its owner let
        go before clearing state, so a remote runner can't re-add assets."""
        await self._ensure_background()
        async with self._lock:
            self._wanted.pop(mapping_id, None)
            await self._release(mapping_id)
            self._seen_ver[mapping_id] = await self._announce(mapping_id, "stop")
            self._remote.pop(mapping_id, None)
        if not await self._wait_lease_free(mapping_id, max_wait_s=5.0):
            log.warning("mapping %s: owner did not stop within 5 s; its lease will lapse", mapping_id)
        if clear and site_id:
            await self.state.clear_mapping(site_id, mapping_id)

    async def stop_all(self) -> None:
        """Shutdown: stop local runners and hand their leases back at once."""
        for t in self._bg:
            t.cancel()
        for t in self._bg:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._bg = []
        for mid in list(self._tasks):
            with contextlib.suppress(RedisError, OSError):
                await self._release(mid)
            await self._stop_local(mid)

    # -- internals ---------------------------------------------------------

    def _running_here(self, mapping_id: str) -> bool:
        return RunnerManager.is_running(self, mapping_id)

    def _lease(self, mapping_id: str) -> str:
        return self._lease_prefix + mapping_id

    async def join(self) -> None:
        """Take part in the cluster from startup, even with no mappings yet: listen
        for control messages, pick up mappings started elsewhere, and take over
        when an owner dies (LIVEOPS-79)."""
        await self._ensure_background()

    async def _ensure_background(self) -> None:
        if self._bg and all(not t.done() for t in self._bg):
            return
        for t in self._bg:
            t.cancel()
        self._listening.clear()
        self._bg = [
            asyncio.create_task(self._listen_loop(), name="cluster-control"),
            asyncio.create_task(self._tick_loop(), name="cluster-tick"),
            asyncio.create_task(self._watchdog_loop(), name="cluster-lease-watchdog"),
        ]
        # Make sure control messages reach us before we act on our own.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._listening.wait(), timeout=5)

    async def _announce(self, mapping_id: str, op: str) -> int:
        return int(
            await self._announce_script(
                keys=[self._ver_key, self._op_key], args=[mapping_id, op, self._channel, self.instance_id]
            )
        )

    async def _release(self, mapping_id: str) -> None:
        """Stop the local runner (if any) and give its lease back."""
        was_running = self._running_here(mapping_id) or mapping_id in self._tasks
        await self._stop_local(mapping_id)
        if was_running:
            released = await self._release_lease(keys=[self._lease(mapping_id)], args=[self.instance_id])
            if released:
                await self._r.hdel(self._health_key, mapping_id)

    async def _try_acquire(self, mapping_id: str) -> None:
        spec = self._wanted.get(mapping_id)
        if spec is None or self._running_here(mapping_id):
            return
        if time.monotonic() < self._backoff_until.get(mapping_id, 0.0):
            return
        sent = time.monotonic()
        got = await asyncio.wait_for(
            self._r.set(self._lease(mapping_id), self.instance_id, nx=True, px=int(self._ttl_s * 1000)),
            self._call_timeout_s,
        )
        if got:
            self._valid_until[mapping_id] = sent + self._ttl_s
            log.info("mapping %s: this process (%s) owns it now", mapping_id, self.instance_id)
            self._remote.pop(mapping_id, None)
            await self._start_local(spec)
            await self._publish_health(mapping_id)

    async def _wait_lease_free(self, mapping_id: str, max_wait_s: float) -> bool:
        deadline = time.monotonic() + max_wait_s
        while await self._r.exists(self._lease(mapping_id)):
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.05)
        return True

    async def _handle_control(self, mapping_id: str, version: int, op: str) -> None:
        """Another process started/stopped a mapping (called under the lock)."""
        if version <= self._seen_ver.get(mapping_id, 0):
            return
        self._seen_ver[mapping_id] = version
        self._wanted.pop(mapping_id, None)
        await self._release(mapping_id)
        self._remote.pop(mapping_id, None)
        if op != "start":
            return
        try:
            spec = await self._load(mapping_id)
        except Exception as e:  # noqa: BLE001 - e.g. unreadable secrets: record, don't crash the loop
            self.mark_error(mapping_id, "", str(e).splitlines()[0] if str(e) else type(e).__name__)
            return
        if spec is not None:
            self._wanted[mapping_id] = spec
            await self._try_acquire(mapping_id)

    async def _listen_loop(self) -> None:
        backoff = 0.5
        while True:
            pubsub = self._r.pubsub()
            try:
                await pubsub.subscribe(self._channel)
                while True:
                    msg = await pubsub.get_message(timeout=1.0)
                    if msg is None:
                        continue
                    if msg.get("type") == "subscribe":
                        self._listening.set()
                        backoff = 0.5
                        continue
                    if msg.get("type") != "message":
                        continue
                    try:
                        data = json.loads(msg["data"])
                        mid, version, op = str(data["mapping_id"]), int(data["v"]), str(data["op"])
                    except (KeyError, TypeError, ValueError):
                        log.warning("ignoring malformed control message")
                        continue
                    async with self._lock:
                        await self._handle_control(mid, version, op)
            except asyncio.CancelledError:
                raise
            except (RedisError, OSError) as e:
                log.warning("control channel failed (%s); reconnecting in %.1fs", e, backoff)
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.aclose()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10.0)

    async def _watchdog_loop(self) -> None:
        """Stops local runners whose lease can no longer be trusted. Runs without
        the lock and without Redis, so a hung tick can't keep a runner alive."""
        while True:
            now = time.monotonic()
            for mid in [m for m in list(self._tasks) if self._running_here(m)]:
                if now >= self._valid_until.get(mid, 0.0) - self._margin_s:
                    log.warning("mapping %s: lease not renewed in time; stopping the local runner", mid)
                    self._backoff_until[mid] = now + self._ttl_s
                    await self._stop_local(mid)
            await asyncio.sleep(min(0.25, self._ttl_s / 10))

    async def _tick_loop(self) -> None:
        while True:
            try:
                async with self._lock:
                    await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - keep coordinating whatever happens
                log.warning("cluster tick failed: %s", e)
            await asyncio.sleep(self._tick_s)

    async def _tick(self) -> None:
        ttl_ms = int(self._ttl_s * 1000)
        # 1. Renew our leases; stop runners whose lease we lost. A renew that
        #    errors leaves the lease uncertain: the watchdog stops the runner
        #    before it could lapse (LIVEOPS-52).
        for mid in [m for m in list(self._tasks) if self._running_here(m)]:
            sent = time.monotonic()
            try:
                ok = await asyncio.wait_for(
                    self._renew(keys=[self._lease(mid)], args=[self.instance_id, ttl_ms]), self._call_timeout_s
                )
            except (RedisError, OSError, TimeoutError) as e:
                log.warning("mapping %s: lease renewal failed (%s); will stop if it can't renew in time", mid, e)
                continue
            if ok:
                self._valid_until[mid] = sent + self._ttl_s
            else:
                log.warning("mapping %s: lost its lease; stopping here, another process takes over", mid)
                await self._stop_local(mid)
        # 2. Catch up on control messages we may have missed.
        versions = await self._r.hgetall(self._ver_key)
        if versions:
            ops = await self._r.hgetall(self._op_key)
            for mid, v in versions.items():
                if int(v) > self._seen_ver.get(mid, 0):
                    await self._handle_control(mid, int(v), ops.get(mid, "start"))
        # 3. Take over mappings nobody runs.
        for mid in list(self._wanted):
            try:
                await self._try_acquire(mid)
            except (RedisError, OSError, TimeoutError) as e:
                log.warning("mapping %s: couldn't try to take the lease (%s)", mid, e)
        # 4. Share health.
        for mid in [m for m in list(self._tasks) if self._running_here(m)]:
            await self._publish_health(mid)
        now = time.time()
        remote: dict[str, dict[str, Any]] = {}
        for mid, raw in (await self._r.hgetall(self._health_key)).items():
            with contextlib.suppress(ValueError, TypeError):
                data = json.loads(raw)
                if data.get("owner") != self.instance_id and now - float(data.get("reported_ts", 0)) <= self._ttl_s:
                    remote[mid] = data
        self._remote = remote

    async def _publish_health(self, mapping_id: str) -> None:
        h = self._health.get(mapping_id)
        if h is None:
            return
        data = {**h.as_dict(), "owner": self.instance_id, "reported_ts": time.time()}
        await self._r.hset(self._health_key, mapping_id, json.dumps(data, default=str))
