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
import re
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


# Plain-language feed lines (mirrors frontend/src/map/labels.ts). Codes such as
# "waiting_for_provider" read as words; real names ("ED-02") are kept as they are.
_ACRONYMS = {
    "ed",
    "er",
    "icu",
    "nicu",
    "picu",
    "pacu",
    "cvu",
    "mri",
    "ct",
    "esi",
    "eta",
    "evs",
    "ems",
    "iv",
    "id",
    "mph",
}
_TOKEN = re.compile(r"^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$")
_OWN_FIELDS = ("zone", "state", "label", "kind", "anchor", "floor", "role", "x", "y")
_CHURN = re.compile(r"(^|_)(latitude|longitude|lat|lng|lon|speed|heading|x|y)$|(_at|_seen|_time|_since|updated)$")
# Read as "is …": "transporting to hospital", "boarding", "at hospital · offloading" ("waiting room" is a place).
_PROGRESSIVE = re.compile(r"^(\S+ing(\s+(to|for|at|on|in|from|with)\b.*)?|(at|on|en route)\b.*|in (?!use\b).*)$", re.I)
_FIELD_WORDS = {
    "esi_acuity": "acuity (ESI)",
    "encounter_class": "visit type",
    "eta_minutes": "ETA (min)",
    "speed_mph": "speed (mph)",
    "badge_last_seen": "badge last seen",
    "clean_type": "cleaning type",
}


def words(value: Any) -> str:
    """A code in words for use in a sentence: 'waiting_for_provider' -> 'waiting for provider',
    'AT_HOSPITAL_OFFLOADING' -> 'at hospital · offloading'. Names are returned unchanged."""
    text = _show(value) if not isinstance(value, str) else value.strip()
    if not _TOKEN.match(text):
        return text
    parts = [w.upper() if w in _ACRONYMS else w for w in text.lower().split("_") if w]
    if len(parts) >= 3 and parts[0] in ("at", "on", "in") and parts[-1].endswith("ing"):
        return " ".join(parts[:-1]) + " · " + parts[-1]
    return " ".join(parts)


def _field(name: str) -> str:
    key = name.removeprefix("attributes.").lower()
    return _FIELD_WORDS.get(key) or words(re.sub(r"_(id|at)$", "", key) or key)


def _status_phrase(new: Any, old: Any) -> str:
    to = words(new)
    if _PROGRESSIVE.match(to):
        return f"is {to}"  # "is transporting to hospital", "is at hospital · offloading"
    return f"is {to} (was {words(old)})" if old is not None else f"is now {to}"


def describe(entry: EventEntry) -> str:
    """One short line for people, without field names or arrows:
    'P7 moved from ED Waiting Room to ED-02 · now waiting for provider', 'ED-11 is dirty (was occupied)',
    'M1 is transporting to hospital', 'P7 left the map (discharged)'."""
    asset = str(entry.get("asset_id", "?"))
    changes: dict[str, Any] = entry.get("changes", {}) or {}
    if entry.get("removed"):
        label = (changes.get("label") or [None])[0]
        name = label if isinstance(label, str) and label else asset
        statuses = [
            v for k in ("attributes.status", "state", "zone") for v in (changes.get(k) or []) if isinstance(v, str)
        ]
        discharged = any("discharg" in v.lower() for v in statuses)
        return f"{name} left the map (discharged)" if discharged else f"{name} left the map"
    if changes and all(new is None for _, new in changes.values()):
        # One source stopped reporting the asset; another source still does.
        return f"{asset} is no longer in this source (still reported by another)"
    if not changes:
        return f"{asset} updated"

    def new_of(k: str) -> Any:
        return changes[k][1] if k in changes else None

    s_key = next((k for k in ("attributes.status", "state") if new_of(k) is not None), None)
    s_old, s_new = (changes[s_key][0], changes[s_key][1]) if s_key else (None, None)
    zone = changes.get("zone")
    if zone and s_key and zone[1] == s_new:
        zone = None  # fleet bays are named by status: the zone change is the status change
    move = None
    if zone and zone[1] is not None:
        move = (
            f"moved from {words(zone[0])} to {words(zone[1])}"
            if zone[0] is not None
            else f"arrived in {words(zone[1])}"
        )
    elif zone and zone[0] is not None:
        move = f"left {words(zone[0])}"
    if move and s_key and zone and zone[1] is not None and words(s_new).lower() in words(zone[1]).lower():
        text = f"{asset} {move}"  # "arrived in ED Waiting Room · now waiting room" says it twice
    elif move and s_key:
        text = f"{asset} {move} · now {words(s_new)}"
    elif move:
        text = f"{asset} {move}"
    elif s_key:
        text = f"{asset} {_status_phrase(s_new, s_old)}"
    elif new_of("anchor") is not None:
        text = f"{asset} is now in bed {words(new_of('anchor'))}"
    elif new_of("label") is not None:
        text = f"{asset} is now called {_show(new_of('label'))}"
    else:
        rest = sorted(k for k in changes if k not in _OWN_FIELDS)
        values = [k for k in rest if not _CHURN.search(k.removeprefix("attributes.")) and changes[k][1] is not None]
        if values:
            text = f"{asset} " + ", ".join(f"{_field(k)} is now {words(changes[k][1])}" for k in values[:3])
        else:
            text = f"{asset} updated: " + ", ".join(_field(k) for k in rest[:3])
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
