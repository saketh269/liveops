"""Where webhook events live between the HTTP route and the mapping stream.

Two backends, picked from the server settings:

- ``RedisWebhookStore`` (``LIVEOPS_REDIS_URL`` set): per source a hash with the
  latest record per key, a stream of events, and the replay cache. Any process
  can accept a webhook; the process that owns the mapping reads the stream
  (LIVEOPS-72). State survives restarts (LIVEOPS-89).
- ``MemoryWebhookStore`` (single process): the in-process buffer, written
  through to an append-only journal under ``LIVEOPS_DATA_DIR/webhooks/`` so
  the last known state comes back after a restart (LIVEOPS-89).

Both give a stream the current state and a position atomically, so no event
is lost or applied twice between "read the state" and "follow new events".
"""

from __future__ import annotations

import abc
import asyncio
import json
import logging
import os
import re
import threading
import time
import weakref
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.connectors.base import ConnectorError, Record

log = logging.getLogger("liveops.webhook")

DELETED_FIELD = "_deleted"
REPLAY_TTL_S = 600  # twice the 5-minute window
SUBSCRIBER_QUEUE = 10_000
STREAM_MAXLEN = 100_000
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass
class WebhookEvent:
    record: Record
    deleted: bool
    ts: float


@dataclass
class WebhookStats:
    received: int  # records accepted since this process started (memory) or in total (Redis)
    last_ts: float | None
    restored: int = 0  # records loaded from before a restart (memory store)


class Subscription(abc.ABC):
    @abc.abstractmethod
    async def get(self) -> WebhookEvent | None:
        """Next event; ``None`` means the reader fell behind and must restart from state."""

    @abc.abstractmethod
    async def close(self) -> None: ...


class WebhookStore(abc.ABC):
    @abc.abstractmethod
    async def seen_before(self, source_id: str, token: str) -> bool:
        """Record ``token``; True if it was already recorded in the replay window."""

    @abc.abstractmethod
    async def publish(
        self, source_id: str, key_field: str, records: list[Record], ts: float, max_keys: int
    ) -> None: ...

    @abc.abstractmethod
    async def open(self, source_id: str) -> tuple[list[Record], Subscription]:
        """Current state and a subscription positioned right after it."""

    @abc.abstractmethod
    async def current(self, source_id: str) -> list[Record]: ...

    @abc.abstractmethod
    async def stats(self, source_id: str) -> WebhookStats: ...


def split(raw: Record) -> tuple[Record, bool]:
    return {k: v for k, v in raw.items() if k != DELETED_FIELD}, raw.get(DELETED_FIELD) is True


# --------------------------------------------------------------------------
# In-process store with a journal on disk
# --------------------------------------------------------------------------


@dataclass
class _Subscriber:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[WebhookEvent | None]
    overflowed: bool = False


@dataclass
class _Channel:
    max_keys: int
    state: OrderedDict[str, Record] = field(default_factory=OrderedDict)
    subscribers: list[_Subscriber] = field(default_factory=list)
    received: int = 0
    last_ts: float | None = None
    restored: int = 0
    journal_lines: int = 0
    seen: OrderedDict[str, float] = field(default_factory=OrderedDict)


class _MemorySubscription(Subscription):
    def __init__(self, store: MemoryWebhookStore, source_id: str, sub: _Subscriber) -> None:
        self.store, self.source_id, self.sub = store, source_id, sub

    async def get(self) -> WebhookEvent | None:
        return await self.sub.queue.get()

    async def close(self) -> None:
        self.store._unsubscribe(self.source_id, self.sub)


class MemoryWebhookStore(WebhookStore):
    """Thread-safe (the API and the runner may use different loops/threads)."""

    def __init__(self, journal_dir: Path | None, default_max_keys: int = 10_000) -> None:
        self._lock = threading.Lock()
        self._channels: dict[str, _Channel] = {}
        self._dir = journal_dir
        self._default_max_keys = default_max_keys

    # -- journal -----------------------------------------------------------

    def _journal(self, source_id: str) -> Path | None:
        if self._dir is None or not SAFE_ID.match(source_id):
            return None
        return self._dir / f"{source_id}.jsonl"

    def _load(self, source_id: str, ch: _Channel) -> None:
        path = self._journal(source_id)
        if path is None or not path.is_file():
            return
        try:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    ch.journal_lines += 1
                    try:
                        entry = json.loads(line)
                        key = str(entry["k"])
                    except (ValueError, KeyError, TypeError):
                        continue  # a torn last line after a crash
                    if entry.get("d"):
                        ch.state.pop(key, None)
                    elif isinstance(entry.get("r"), dict):
                        ch.state[key] = entry["r"]
                        ch.state.move_to_end(key)
                    if "t" in entry:
                        ch.last_ts = float(entry["t"])
            while len(ch.state) > ch.max_keys:
                ch.state.popitem(last=False)
            ch.restored = len(ch.state)
        except OSError as e:
            log.warning("webhook journal for %s unreadable: %s", source_id, e)

    def _append(self, source_id: str, ch: _Channel, lines: list[str]) -> None:
        path = self._journal(source_id)
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write("".join(lines))
            ch.journal_lines += len(lines)
            if ch.journal_lines > max(1_000, 4 * len(ch.state)):
                self._compact(path, ch)
        except OSError as e:
            log.warning("webhook journal for %s not written: %s", source_id, e)

    def _compact(self, path: Path, ch: _Channel) -> None:
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for k, r in ch.state.items():
                fh.write(json.dumps({"k": k, "r": r, "t": ch.last_ts}) + "\n")
        os.replace(tmp, path)
        ch.journal_lines = len(ch.state)

    # -- store -------------------------------------------------------------

    def _chan(self, source_id: str, max_keys: int | None = None) -> _Channel:
        ch = self._channels.get(source_id)
        if ch is None:
            ch = self._channels[source_id] = _Channel(max_keys=max_keys or self._default_max_keys)
            self._load(source_id, ch)
        if max_keys:
            ch.max_keys = max_keys
        return ch

    async def seen_before(self, source_id: str, token: str) -> bool:
        now = time.time()
        with self._lock:
            ch = self._chan(source_id)
            while ch.seen and next(iter(ch.seen.values())) < now - REPLAY_TTL_S:
                ch.seen.popitem(last=False)
            if token in ch.seen:
                return True
            ch.seen[token] = now
            while len(ch.seen) > 100_000:
                ch.seen.popitem(last=False)
            return False

    async def publish(self, source_id: str, key_field: str, records: list[Record], ts: float, max_keys: int) -> None:
        await asyncio.to_thread(self._publish_sync, source_id, key_field, records, ts, max_keys)

    def _publish_sync(self, source_id: str, key_field: str, records: list[Record], ts: float, max_keys: int) -> None:
        with self._lock:
            ch = self._chan(source_id, max_keys)
            events, lines = [], []
            for raw in records:
                rec, deleted = split(raw)
                key = str(rec[key_field])
                if deleted:
                    ch.state.pop(key, None)
                    lines.append(json.dumps({"k": key, "d": True, "t": ts}) + "\n")
                else:
                    ch.state[key] = rec
                    ch.state.move_to_end(key)
                    while len(ch.state) > ch.max_keys:
                        ch.state.popitem(last=False)
                    lines.append(json.dumps({"k": key, "r": rec, "t": ts}) + "\n")
                events.append(WebhookEvent(rec, deleted, ts))
            ch.received += len(records)
            ch.last_ts = ts
            self._append(source_id, ch, lines)
            for sub in ch.subscribers:
                for ev in events:
                    sub.loop.call_soon_threadsafe(_offer, sub, ev)

    async def open(self, source_id: str) -> tuple[list[Record], Subscription]:
        sub = _Subscriber(asyncio.get_running_loop(), asyncio.Queue(maxsize=SUBSCRIBER_QUEUE))

        def _open() -> list[Record]:
            with self._lock:
                ch = self._chan(source_id)
                ch.subscribers.append(sub)
                return list(ch.state.values())

        state = await asyncio.to_thread(_open)
        return state, _MemorySubscription(self, source_id, sub)

    def _unsubscribe(self, source_id: str, sub: _Subscriber) -> None:
        with self._lock:
            ch = self._channels.get(source_id)
            if ch is not None and sub in ch.subscribers:
                ch.subscribers.remove(sub)

    async def current(self, source_id: str) -> list[Record]:
        def _cur() -> list[Record]:
            with self._lock:
                return list(self._chan(source_id).state.values())

        return await asyncio.to_thread(_cur)

    async def stats(self, source_id: str) -> WebhookStats:
        def _stats() -> WebhookStats:
            with self._lock:
                ch = self._chan(source_id)
                return WebhookStats(ch.received, ch.last_ts, ch.restored)

        return await asyncio.to_thread(_stats)


def _offer(sub: _Subscriber, ev: WebhookEvent) -> None:
    if sub.overflowed:
        return
    try:
        sub.queue.put_nowait(ev)
    except asyncio.QueueFull:
        # The consumer fell behind: stop feeding it and let it restart from state.
        sub.overflowed = True
        while not sub.queue.empty():
            sub.queue.get_nowait()
        sub.queue.put_nowait(None)


# --------------------------------------------------------------------------
# Redis store (several processes)
# --------------------------------------------------------------------------

# KEYS: state, order, log, meta, seq.  ARGV: max_keys, ts, n, then n x (key, deleted, record_json).
_PUBLISH = r"""
local state, order, logk, meta, seqk = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local max_keys, ts, n = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3])
for i = 0, n - 1 do
  local key, deleted, rec = ARGV[4 + i * 3], ARGV[5 + i * 3], ARGV[6 + i * 3]
  local seq = redis.call('INCR', seqk)
  if deleted == '1' then
    redis.call('HDEL', state, key)
    redis.call('ZREM', order, key)
  else
    redis.call('HSET', state, key, rec)
    redis.call('ZADD', order, seq, key)
  end
  redis.call('XADD', logk, 'MAXLEN', '~', ARGV[#ARGV], '*', 's', seq, 'd', deleted, 'r', rec, 't', ts)
end
local extra = redis.call('ZCARD', order) - max_keys
if extra > 0 then
  local old = redis.call('ZPOPMIN', order, extra)
  for i = 1, #old, 2 do redis.call('HDEL', state, old[i]) end
end
redis.call('HINCRBY', meta, 'received', n)
redis.call('HSET', meta, 'last_ts', ts)
return n
"""

# KEYS: state, log, seq. Returns {seq, last_stream_id, state...}.
_SNAPSHOT = r"""
local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
local id = '0-0'
if #last > 0 then id = last[1][1] end
local seq = redis.call('GET', KEYS[3]) or '0'
local out = {seq, id}
local all = redis.call('HVALS', KEYS[1])
for i = 1, #all do out[#out + 1] = all[i] end
return out
"""


class _RedisSubscription(Subscription):
    def __init__(self, store: RedisWebhookStore, source_id: str, last_id: str, seq: int) -> None:
        self.store, self.source_id, self.last_id, self.seq = store, source_id, last_id, seq
        self._pending: list[WebhookEvent | None] = []

    async def get(self) -> WebhookEvent | None:
        r = self.store._client()
        logk = self.store._key(self.source_id, "log")
        while not self._pending:
            resp = await r.xread({logk: self.last_id}, count=500, block=2_000)
            for _stream, entries in resp or []:
                for entry_id, fields in entries:
                    self.last_id = _s(entry_id)
                    seq = int(_s(fields[b"s"]))
                    if seq != self.seq + 1:
                        # Events were trimmed before we read them: restart from state.
                        self._pending.append(None)
                        break
                    self.seq = seq
                    deleted = _s(fields[b"d"]) == "1"
                    rec = json.loads(_s(fields[b"r"]))
                    self._pending.append(WebhookEvent(rec, deleted, float(_s(fields[b"t"]))))
        return self._pending.pop(0)

    async def close(self) -> None:
        self._pending.clear()


def _s(v: Any) -> str:
    return v.decode() if isinstance(v, bytes) else str(v)


class RedisWebhookStore(WebhookStore):
    def __init__(self, url: str, prefix: str) -> None:
        self.url, self.prefix = url, prefix
        # redis.asyncio clients belong to one event loop; keep one per loop.
        self._clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, Any] = weakref.WeakKeyDictionary()

    def _client(self) -> Any:
        import redis.asyncio as aioredis

        loop = asyncio.get_running_loop()
        c = self._clients.get(loop)
        if c is None:
            c = aioredis.Redis.from_url(self.url, socket_connect_timeout=5, health_check_interval=30)
            self._clients[loop] = c
        return c

    def _key(self, source_id: str, part: str) -> str:
        return f"{self.prefix}:wh:{{{source_id}}}:{part}"  # {source_id}: one cluster slot per source

    async def _call(self, coro: Any) -> Any:
        from redis.exceptions import RedisError

        try:
            return await coro
        except RedisError as e:
            raise ConnectorError(
                f"Redis isn't reachable for webhook data: {type(e).__name__}",
                hint="Check LIVEOPS_REDIS_URL and that Redis is running.",
            ) from None

    async def seen_before(self, source_id: str, token: str) -> bool:
        ok = await self._call(self._client().set(self._key(source_id, f"seen:{token}"), b"1", nx=True, ex=REPLAY_TTL_S))
        return not ok

    async def publish(self, source_id: str, key_field: str, records: list[Record], ts: float, max_keys: int) -> None:
        argv: list[Any] = [max_keys, repr(ts), len(records)]
        for raw in records:
            rec, deleted = split(raw)
            argv += [str(rec[key_field]), "1" if deleted else "0", json.dumps(rec)]
        argv.append(STREAM_MAXLEN)
        keys = [self._key(source_id, p) for p in ("state", "order", "log", "meta", "seq")]
        await self._call(self._client().eval(_PUBLISH, len(keys), *keys, *argv))

    async def open(self, source_id: str) -> tuple[list[Record], Subscription]:
        keys = [self._key(source_id, p) for p in ("state", "log", "seq")]
        out = await self._call(self._client().eval(_SNAPSHOT, len(keys), *keys))
        seq, last_id = int(_s(out[0])), _s(out[1])
        state = [json.loads(_s(v)) for v in out[2:]]
        return state, _RedisSubscription(self, source_id, last_id, seq)

    async def current(self, source_id: str) -> list[Record]:
        r = self._client()
        keys = await self._call(r.zrange(self._key(source_id, "order"), 0, -1))
        if not keys:
            return []
        vals = await self._call(r.hmget(self._key(source_id, "state"), keys))
        return [json.loads(_s(v)) for v in vals if v is not None]

    async def stats(self, source_id: str) -> WebhookStats:
        meta = await self._call(self._client().hgetall(self._key(source_id, "meta")))
        received = int(_s(meta.get(b"received", b"0")))
        last = meta.get(b"last_ts")
        return WebhookStats(received, float(_s(last)) if last else None)


# --------------------------------------------------------------------------
# Selection
# --------------------------------------------------------------------------

_stores: dict[tuple[str, ...], WebhookStore] = {}
_stores_lock = threading.Lock()


def get_store() -> WebhookStore:
    """The store for the current server settings (one instance per configuration)."""
    from app.config import get_settings

    s = get_settings()
    if s.redis_url:
        key: tuple[str, ...] = ("redis", s.redis_url, s.redis_key_prefix)
    else:
        key = ("memory", str(Path(s.data_dir).resolve()))
    with _stores_lock:
        store = _stores.get(key)
        if store is None:
            if s.redis_url:
                store = RedisWebhookStore(s.redis_url, s.redis_key_prefix)
            else:
                store = MemoryWebhookStore(Path(s.data_dir).resolve() / "webhooks")
            _stores[key] = store
        return store


def reset_stores() -> None:
    """Tests: forget cached stores (e.g. to simulate a process restart)."""
    with _stores_lock:
        _stores.clear()


__all__ = [
    "MemoryWebhookStore",
    "RedisWebhookStore",
    "Subscription",
    "WebhookEvent",
    "WebhookStats",
    "WebhookStore",
    "get_store",
    "reset_stores",
]
