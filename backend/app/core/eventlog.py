"""Append-only, bounded per-site event log and the human-readable feed.

Every visible change to an asset appends one entry::

    {"ts": 1791350000.123456,          # when the change was recorded (seconds)
     "site_id": "a1b2", "asset_id": "B01",
     "op": "upsert" | "remove",
     "removed": false,                  # true when the whole asset left the map
     "source_id": "<source id>", "mapping_id": "<mapping id>",
     "changes": {"state": ["free", "in_use"]}}   # field -> [old, new]

``ts`` is strictly increasing within one site's log, so a client can page with
``since=<last ts>``. ``InMemoryEventLog`` keeps a deque per site; the Redis
store writes entries to a Redis Stream (approximate MAXLEN) from its Lua merge
script and reads them back with ``RedisEventLog``.
"""

from __future__ import annotations

import bisect
import json
import time
from collections import defaultdict, deque
from typing import Any

import redis.asyncio as aioredis

DEFAULT_MAXLEN = 10_000  # entries kept per site
MAX_LIMIT = 1000  # most entries one query returns

EventEntry = dict[str, Any]


def clamp_limit(limit: int) -> int:
    return max(1, min(int(limit), MAX_LIMIT))


def _show(value: Any) -> str:
    if value is None:
        return "—"
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    return text if len(text) <= 40 else text[:39] + "…"


def describe(entry: EventEntry) -> str:
    """One line for people: 'B01 state free → in_use, cleaning — → due'."""
    asset = str(entry.get("asset_id", "?"))
    if entry.get("removed"):
        return f"{asset} removed"
    changes = entry.get("changes", {})
    if changes and all(new is None for _, new in changes.values()):
        # One source stopped reporting the asset; another source still does.
        return f"{asset} no longer in this source (still reported by another)"
    parts = [f"{n.removeprefix('attributes.')} {_show(a)} → {_show(b)}" for n, (a, b) in sorted(changes.items())]
    text = f"{asset} " + ", ".join(parts) if parts else f"{asset} updated"
    return text if len(text) <= 300 else text[:299] + "…"


def feed_item(entry: EventEntry) -> dict[str, Any]:
    """The ``event`` payload of a ``type: "event"`` WebSocket message."""
    return {
        "asset_id": entry.get("asset_id"),
        "text": describe(entry),
        "source_id": entry.get("source_id"),
        "ts": entry.get("ts"),
        "changes": entry.get("changes", {}),
        "removed": bool(entry.get("removed")),
    }


class InMemoryEventLog:
    """Per-site deque; oldest entries fall off once ``maxlen`` is reached."""

    def __init__(self, maxlen: int = DEFAULT_MAXLEN) -> None:
        self._maxlen = maxlen
        self._logs: dict[str, deque[EventEntry]] = defaultdict(lambda: deque(maxlen=self._maxlen))

    def append(self, entry: EventEntry) -> EventEntry:
        log = self._logs[entry["site_id"]]
        ts = time.time()
        if log and ts <= log[-1]["ts"]:
            ts = log[-1]["ts"] + 1e-6  # keep ts strictly increasing for since= paging
        entry["ts"] = ts
        log.append(entry)
        return entry

    def query(self, site_id: str, since: float | None = None, limit: int = 100) -> list[EventEntry]:
        limit = clamp_limit(limit)
        entries = list(self._logs.get(site_id, ()))
        if since is None:
            return entries[-limit:]
        start = bisect.bisect_right([e["ts"] for e in entries], since)
        return entries[start : start + limit]


class RedisEventLog:
    """Reads a site's Redis Stream. Entries are written by the store's Lua script."""

    def __init__(self, redis: aioredis.Redis, key_for_site: Any) -> None:
        self._redis: Any = redis  # redis-py's stubs type stream replies as Optional
        self._key = key_for_site

    async def query(self, site_id: str, since: float | None = None, limit: int = 100) -> list[EventEntry]:
        limit = clamp_limit(limit)
        key = self._key(site_id)
        if since is None:
            rows = await self._redis.xrevrange(key, count=limit)
            return [json.loads(r[1]["e"]) for r in reversed(rows)]
        # Stream ids are milliseconds of the same Redis clock that stamped ts.
        start = f"{int(since * 1000)}-0"
        out: list[EventEntry] = []
        while len(out) < limit:
            rows = await self._redis.xrange(key, min=start, count=limit + 1)
            if not rows:
                break
            for _id, data in rows:
                entry = json.loads(data["e"])
                if entry["ts"] > since:
                    out.append(entry)
            if len(rows) <= limit:
                break
            start = f"({rows[-1][0]}"
        return out[:limit]
