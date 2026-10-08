"""Durable asset history: who or what was where, in which status, and when.

The state store hands every event-log entry it writes to ``HistoryRecorder.record``
(see ``StateStore.history_sink``) together with the asset's flat view after the
change. ``record`` only keeps the fields that tell a story (place, status, bed,
floor, label, and an attached record's status) plus a small context snapshot,
and queues the row; a background task writes queued rows to the portal DB in
batches, so the live stream never waits on the database.

Works the same in one process and in a cluster: each process records the
changes it applied itself (in Redis mode the owner of a mapping applies it), so
every change is written once.

Live Ops only knows history from the moment it started watching a source. Rows
older than ``LIVEOPS_HISTORY_DAYS`` (default 30) are deleted by ``cleanup``,
which runs hourly.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable
from typing import Any

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from app.core.eventlog import EventEntry
from app.db import AssetHistory, new_session

log = logging.getLogger("liveops.history")

# Asset fields whose changes are history (field names as the store keeps them).
TRACKED_FIELDS = frozenset({"zone", "state", "floor", "anchor", "label", "kind", "role"})
# Attribute keys whose changes are history: the record's own status and what an
# attached record (cleaning task, transport) says about it.
TRACKED_ATTRIBUTES = frozenset({"status", "assigned_to", "from", "to", "destination"})
# Attributes kept in the context snapshot as source timestamps ("milestones").
MILESTONE_ATTRIBUTES = frozenset(
    {
        "admit_time",
        "arrival_time",
        "arrived_at",
        "triage_time",
        "status_since",
        "state_since",
        "created_at",
        "started_at",
        "completed_at",
        "assigned_at",
        "discharge_time",
        "discharged_at",
        "expected_discharge",
        "badge_last_seen",
    }
)
_MILESTONE_SUFFIXES = ("_time", "_at", "_since")
_CTX_FIELDS = ("zone", "state", "floor", "anchor", "label", "kind", "role")
_MAX_TEXT = 200

DEFAULT_FLUSH_S = 1.0
DEFAULT_BATCH = 1000
DEFAULT_MAX_PENDING = 50_000
CLEANUP_EVERY_S = 3600.0
CLEANUP_FIRST_AFTER_S = 60.0
CLEANUP_CHUNK = 10_000


def tracked(name: str) -> bool:
    if name.startswith("attributes."):
        return name[len("attributes.") :] in TRACKED_ATTRIBUTES
    return name in TRACKED_FIELDS


def _short(v: Any) -> Any:
    """Scalars as they are; long text and nested values cut down (history is not a data copy)."""
    if v is None or isinstance(v, bool | int | float):
        return v
    text = v if isinstance(v, str) else str(v)
    return text if len(text) <= _MAX_TEXT else text[: _MAX_TEXT - 1] + "…"


def is_milestone(key: str) -> bool:
    return key in MILESTONE_ATTRIBUTES or key.endswith(_MILESTONE_SUFFIXES)


def context_of(asset: dict[str, Any]) -> dict[str, Any]:
    """Where/what the asset is after a change, from its flat (folded) view."""
    ctx: dict[str, Any] = {k: _short(asset[k]) for k in _CTX_FIELDS if asset.get(k) is not None}
    attrs = asset.get("attributes")
    if isinstance(attrs, dict):
        if attrs.get("status") is not None:
            ctx["status"] = _short(attrs["status"])
        times = {
            k: _short(v)
            for k, v in attrs.items()
            if is_milestone(str(k)) and isinstance(v, str | int | float) and v != ""
        }
        if times:
            ctx["times"] = times
    return ctx


def history_row(entry: EventEntry, asset: dict[str, Any] | None) -> dict[str, Any] | None:
    """The row to store for one event-log entry, or None when nothing in it is history."""
    changes = {k: [_short(a), _short(b)] for k, (a, b) in (entry.get("changes") or {}).items() if tracked(k)}
    removed = bool(entry.get("removed"))
    if not changes and not removed:
        return None
    return {
        "site_id": str(entry.get("site_id", ""))[:32],
        "asset_id": str(entry.get("asset_id", ""))[:300],
        "ts": float(entry.get("ts") or time.time()),
        "op": str(entry.get("op", "upsert"))[:10],
        "removed": removed,
        "source_id": str(entry.get("source_id") or "")[:32],
        "mapping_id": str(entry.get("mapping_id") or "")[:32],
        "changes": changes,
        "ctx": context_of(asset) if asset is not None else None,
    }


SessionFactory = Callable[[], Session]


class HistoryRecorder:
    """Queues history rows and writes them in batches off the live path."""

    def __init__(
        self,
        *,
        retention_days: float = 30.0,
        flush_interval_s: float = DEFAULT_FLUSH_S,
        batch_size: int = DEFAULT_BATCH,
        max_pending: int = DEFAULT_MAX_PENDING,
        cleanup_interval_s: float = CLEANUP_EVERY_S,
        session_factory: SessionFactory = new_session,
    ) -> None:
        self.retention_days = retention_days
        self._flush_s = flush_interval_s
        self._batch = batch_size
        self._max_pending = max_pending
        self._cleanup_s = cleanup_interval_s
        self._session = session_factory
        self._pending: deque[dict[str, Any]] = deque()
        self._wake = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []
        self._write_lock = asyncio.Lock()
        self.recorded = 0  # rows written
        self.dropped = 0  # rows lost because the DB was unreachable for too long
        self.write_errors = 0
        self._last_warn = 0.0

    @property
    def enabled(self) -> bool:
        return self.retention_days > 0

    @property
    def pending(self) -> int:
        return len(self._pending)

    # The sink: called by the state store for every entry it writes. Never blocks.
    def record(self, entry: EventEntry, asset: dict[str, Any] | None) -> None:
        if not self.enabled:
            return
        try:
            row = history_row(entry, asset)
        except Exception as e:  # noqa: BLE001 - history must never break the live path
            log.debug("history: skipped an entry it could not read: %s", e)
            return
        if row is None:
            return
        self._pending.append(row)
        while len(self._pending) > self._max_pending:
            self._pending.popleft()
            self.dropped += 1
        if len(self._pending) >= self._batch:
            self._wake.set()

    async def start(self) -> None:
        if self._tasks or not self.enabled:
            return
        self._tasks = [
            asyncio.create_task(self._flush_loop(), name="history-flush"),
            asyncio.create_task(self._cleanup_loop(), name="history-cleanup"),
        ]

    async def close(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._tasks = []
        with contextlib.suppress(Exception):
            await self.flush()

    async def flush(self) -> int:
        """Write everything queued so far. Returns the rows written."""
        written = 0
        async with self._write_lock:
            while self._pending:
                batch = [self._pending.popleft() for _ in range(min(self._batch, len(self._pending)))]
                try:
                    await asyncio.to_thread(self._insert, batch)
                except Exception as e:  # noqa: BLE001 - DB down: keep rows (bounded) and retry later
                    self.write_errors += 1
                    self._pending.extendleft(reversed(batch))
                    while len(self._pending) > self._max_pending:
                        self._pending.popleft()
                        self.dropped += 1
                    self._warn(f"could not write asset history ({e}); will retry")
                    break
                written += len(batch)
                self.recorded += len(batch)
        return written

    def _insert(self, rows: list[dict[str, Any]]) -> None:
        with self._session() as s:
            s.execute(insert(AssetHistory), rows)
            s.commit()

    async def cleanup(self, now: float | None = None) -> int:
        """Delete rows older than the retention period. Returns how many."""
        if not self.enabled:
            return 0
        cutoff = (time.time() if now is None else now) - self.retention_days * 86400
        return await asyncio.to_thread(self._delete_before, cutoff)

    def _delete_before(self, cutoff: float) -> int:
        total = 0
        with self._session() as s:
            while True:
                ids = select(AssetHistory.id).where(AssetHistory.ts < cutoff).limit(CLEANUP_CHUNK).scalar_subquery()
                res = s.execute(delete(AssetHistory).where(AssetHistory.id.in_(ids)))
                n = int(getattr(res, "rowcount", 0) or 0)
                s.commit()
                total += n
                if n < CLEANUP_CHUNK:
                    return total

    def _warn(self, msg: str) -> None:
        if time.monotonic() - self._last_warn > 60:
            self._last_warn = time.monotonic()
            log.warning("history: %s (queued %d, dropped %d so far)", msg, len(self._pending), self.dropped)

    async def _flush_loop(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self._flush_s)
            self._wake.clear()
            await self.flush()

    async def _cleanup_loop(self) -> None:
        await asyncio.sleep(min(CLEANUP_FIRST_AFTER_S, self._cleanup_s))
        while True:
            try:
                n = await self.cleanup()
                if n:
                    log.info("history: deleted %d rows older than %g days", n, self.retention_days)
            except Exception as e:  # noqa: BLE001
                self._warn(f"cleanup failed ({e})")
            await asyncio.sleep(self._cleanup_s)


def delete_site_history(session: Session, site_id: str) -> None:
    """Rows of a deleted site go with it."""
    session.execute(delete(AssetHistory).where(AssetHistory.site_id == site_id))
