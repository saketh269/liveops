"""State store: current state of every asset, merged across sources.

``StateStore`` is the interface. ``InMemoryStateStore`` is the reference
implementation used in tests and single-process deployments;
``app.core.redis_state.RedisStateStore`` has the same semantics and shares
state and updates between backend processes.

Merge rule (v0.1): each field keeps the most recent value by received time,
with its source recorded. When a source removes an asset, only that source's
fields are dropped; the asset disappears once no source contributes fields.

Every visible change is also appended to the site's event log
(``app.core.eventlog``) and sent to subscribers as a ``type: "event"`` message
right after the ``upsert``/``remove`` message.
"""

from __future__ import annotations

import abc
import asyncio
import contextlib
import time
from collections import defaultdict
from collections.abc import AsyncGenerator, Callable
from typing import Any

from app.core.eventlog import EventEntry, InMemoryEventLog, feed_item
from app.core.events import (
    Asset,
    AssetEvent,
    AssetOp,
    AttachedRecord,
    FieldValue,
    StreamMessage,
    expand_attributes,
)

RESYNC = "resync"  # internal marker: subscriber fell behind, send a fresh snapshot


class Fanout:
    """Delivers messages to this process's subscribers, one queue each.

    Each queue may hold ``queue_size + 2 × (assets on the site)`` messages: a
    full poll diff (one upsert + one feed event per asset) always fits, so a
    client that keeps up is never resynced by a big batch (LIVEOPS-48).
    Slow-client protection: a client that falls further behind has its backlog
    dropped and gets a fresh snapshot instead, so it never blocks others and
    never ends up with a stale map.
    """

    def __init__(self, queue_size: int) -> None:
        self._queue_size = queue_size
        self._subs: dict[str, set[asyncio.Queue[StreamMessage]]] = defaultdict(set)
        self._known: dict[str, set[str]] = defaultdict(set)  # asset ids per site with subscribers
        self.resyncs = 0  # slow-client resyncs so far (for tests and diagnostics)

    def add(self, site_id: str) -> asyncio.Queue[StreamMessage]:
        q: asyncio.Queue[StreamMessage] = asyncio.Queue()  # bounded by limit() in publish()
        self._subs[site_id].add(q)
        return q

    def remove(self, site_id: str, q: asyncio.Queue[StreamMessage]) -> None:
        subs = self._subs.get(site_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                del self._subs[site_id]
                self._known.pop(site_id, None)

    def sites(self) -> set[str]:
        return set(self._subs)

    def count(self, site_id: str) -> int:
        return len(self._subs.get(site_id, ()))

    def seed(self, site_id: str, asset_ids: list[str]) -> None:
        """Tell the fan-out how big the site is (from a snapshot)."""
        if site_id in self._subs:
            self._known[site_id].update(asset_ids)

    def limit(self, site_id: str) -> int:
        return self._queue_size + 2 * len(self._known.get(site_id, ()))

    def publish(self, msg: StreamMessage) -> None:
        subs = self._subs.get(msg.site_id)
        if not subs:
            return
        if msg.type == "upsert":
            # Only grows while the site has viewers: a burst of removes must not
            # shrink the bound under a queue that is still full of them (LIVEOPS-55).
            self._known[msg.site_id].update(a["asset_id"] for a in msg.assets)
        limit = self.limit(msg.site_id)
        for q in list(subs):
            if q.qsize() >= limit:
                self._resync_queue(q, msg.site_id)
            else:
                q.put_nowait(msg)

    def resync(self, site_id: str) -> None:
        for q in list(self._subs.get(site_id, ())):
            self._resync_queue(q, site_id)

    def _resync_queue(self, q: asyncio.Queue[StreamMessage], site_id: str) -> None:
        self.resyncs += 1
        while not q.empty():
            q.get_nowait()
        q.put_nowait(StreamMessage(type=RESYNC, site_id=site_id))


REMOVE_YIELD_EVERY = 50


def _remove_event(site_id: str, asset_id: str, mapping_id: str) -> AssetEvent:
    return AssetEvent(
        site_id=site_id,
        asset_id=asset_id,
        op=AssetOp.REMOVE,
        source_id="",
        mapping_id=mapping_id,
        dataset="",
        received_ts=time.time(),
    )


def event_messages(site_id: str, entry: EventEntry | None) -> list[StreamMessage]:
    if entry is None:
        return []
    return [StreamMessage(type="event", site_id=site_id, event=feed_item(entry), ts=entry["ts"])]


# Called with every event-log entry this process writes and the asset's flat
# view after the change (None on a removal). Must not block: the durable
# history (app.core.history) only queues it.
HistorySink = Callable[[EventEntry, dict[str, Any] | None], None]


class StateStore(abc.ABC):
    def __init__(self, queue_size: int = 1000) -> None:
        self._fanout = Fanout(queue_size)
        self.history_sink: HistorySink | None = None

    def _record(self, entry: EventEntry | None, asset: dict[str, Any] | None) -> None:
        if entry is not None and self.history_sink is not None:
            self.history_sink(entry, asset)

    @abc.abstractmethod
    async def apply(self, event: AssetEvent) -> StreamMessage | None:
        """Apply one event. Returns the message to broadcast, or None if
        nothing visible changed."""

    @abc.abstractmethod
    async def site_assets(self, site_id: str) -> list[Asset]: ...

    @abc.abstractmethod
    async def clear_mapping(self, site_id: str, mapping_id: str) -> None:
        """Drop all fields a mapping contributed (mapping paused/deleted)."""

    async def reconcile(self, site_id: str, mapping_id: str, keep: set[str]) -> int:
        """After a mapping's full-state snapshot: drop that mapping's fields from
        every asset not in ``keep`` (e.g. rows deleted while the backend was down,
        or asset ids that changed after a mapping edit). Returns how many assets
        visibly changed. Stores may override with a faster version."""
        touched = 0
        for n, asset in enumerate(await self.site_assets(site_id)):
            if asset.asset_id in keep:
                continue
            # A store with hidden (overridden) values may hold this mapping's
            # contribution on any asset, so ask the store rather than the view.
            if await self.apply(_remove_event(site_id, asset.asset_id, mapping_id)) is not None:
                touched += 1
            if n % REMOVE_YIELD_EVERY == 0:
                await asyncio.sleep(0)
        return touched

    @abc.abstractmethod
    async def events(self, site_id: str, since: float | None = None, limit: int = 100) -> list[EventEntry]:
        """Event log entries after ``since`` (oldest first), or the latest
        ``limit`` entries when ``since`` is None. ``limit`` is capped at 1000."""

    async def close(self) -> None:  # noqa: B027 - optional hook
        """Release connections. Safe to call twice."""

    async def _listen(self, site_id: str) -> None:  # noqa: B027 - optional hook
        """Called before a subscriber's snapshot; returns once live updates
        for the site are guaranteed to reach this process."""

    async def _unlisten(self, site_id: str) -> None:  # noqa: B027 - optional hook
        """Called after the site's last local subscriber left."""

    async def subscribe(self, site_id: str) -> AsyncGenerator[StreamMessage, None]:
        """Snapshot first, then live messages for this site.

        Registers before taking the snapshot, so no change is lost in between
        (a change may show up in both, which is harmless: upserts are full
        asset states)."""
        q = self._fanout.add(site_id)
        try:
            await self._listen(site_id)
            yield await self._snapshot(site_id)
            while True:
                msg = await q.get()
                yield await self._snapshot(site_id) if msg.type == RESYNC else msg
        finally:
            self._fanout.remove(site_id, q)
            if self._fanout.count(site_id) == 0:
                with contextlib.suppress(Exception):
                    await self._unlisten(site_id)

    async def _snapshot(self, site_id: str) -> StreamMessage:
        assets = [a.flat() for a in await self.site_assets(site_id)]
        # The queue bound scales with the site the viewer was given (LIVEOPS-48/55).
        self._fanout.seed(site_id, [a["asset_id"] for a in assets])
        return StreamMessage(type="snapshot", site_id=site_id, assets=assets)


Contribution = tuple[FieldValue, int]  # (value from one mapping, apply sequence number)

_MISSING: Any = object()  # "no value" in change records, unlike a value of None


def _rank(mapping_id: str, attached: set[str]) -> int:
    """Own mappings (1) beat attached ones (0) on every field (LIVEOPS-116)."""
    return 0 if mapping_id in attached else 1


def _best(per_mapping: dict[str, Contribution], attached: set[str] | None = None) -> FieldValue | None:
    """The visible value of a field: an own mapping's over an attached one's,
    then the newest contribution (ties: applied last)."""
    if not per_mapping:
        return None
    att = attached or set()
    return max(per_mapping.items(), key=lambda mc: (_rank(mc[0], att), mc[1][0].updated_ts, mc[1][1]))[1][0]


def _own_view(fv: FieldValue | None, attached: set[str]) -> Any:
    """The value the asset's own mappings show for a field (attached values don't count)."""
    return fv.value if fv is not None and _rank(fv.mapping_id, attached) == 1 else _MISSING


def _change(old: Any, new: Any) -> list[Any] | None:
    if old is _MISSING and new is _MISSING:
        return None
    if old is not _MISSING and new is not _MISSING and old == new:
        return None
    return [None if old is _MISSING else old, None if new is _MISSING else new]


class InMemoryStateStore(StateStore):
    """Reference store. Every field keeps one contribution per mapping; the
    visible one is an own mapping's over an attached mapping's (LIVEOPS-116),
    then the newest. When a mapping leaves, the field falls back to the next
    best remaining contribution (LIVEOPS-92).

    Event-log ``changes``: for an own mapping, what the asset's own mappings
    show before/after (an attached value is never the "old" status: LIVEOPS-115);
    for an attached mapping, its own values before/after."""

    def __init__(self, queue_size: int = 1000, eventlog_maxlen: int | None = None) -> None:
        super().__init__(queue_size)
        self._assets: dict[str, dict[str, Asset]] = defaultdict(dict)
        # site -> asset -> field -> mapping -> contribution
        self._contrib: dict[str, dict[str, dict[str, dict[str, Contribution]]]] = defaultdict(dict)
        # site -> asset -> attached mappings contributing to it
        self._attached: dict[str, dict[str, set[str]]] = defaultdict(dict)
        self._seq = 0
        self._lock = asyncio.Lock()
        self._log = InMemoryEventLog() if eventlog_maxlen is None else InMemoryEventLog(eventlog_maxlen)

    async def apply(self, event: AssetEvent) -> StreamMessage | None:
        async with self._lock:
            msg, entry = self._apply_locked(event)
            if msg is None:
                return None
            if entry is not None:
                self._log.append(entry)
                self._record(entry, msg.assets[0] if msg.type == "upsert" else None)
            # Publish under the lock so every subscriber sees changes in apply order.
            self._fanout.publish(msg)
            for m in event_messages(event.site_id, entry):
                self._fanout.publish(m)
        return msg

    @staticmethod
    def _attached_view(contrib: dict[str, dict[str, Contribution]], attached: set[str]) -> dict[str, AttachedRecord]:
        out: dict[str, AttachedRecord] = {}
        newest: dict[str, int] = {}
        for name, per in contrib.items():
            for m, (fv, seq) in per.items():
                if m not in attached:
                    continue
                rec = out.setdefault(m, AttachedRecord(source_id=fv.source_id))
                rec.fields[name] = fv.value
                if seq > newest.get(m, -1):
                    newest[m] = seq
                    rec.source_id = fv.source_id  # source of the mapping's newest contribution
        return out

    def _apply_locked(self, event: AssetEvent) -> tuple[StreamMessage | None, EventEntry | None]:
        site = self._assets[event.site_id]
        contribs = self._contrib[event.site_id]
        attached_by_asset = self._attached[event.site_id]
        asset = site.get(event.asset_id)
        changes: dict[str, list[Any]] = {}
        removed = False
        visible_changed = False
        mapping = event.mapping_id
        if event.op == AssetOp.REMOVE:
            contrib = contribs.get(event.asset_id)
            if asset is None or contrib is None:
                return None, None
            affected = [f for f, per in contrib.items() if mapping in per]
            if not affected:
                return None, None  # this mapping contributed nothing to the asset
            attached = attached_by_asset.setdefault(event.asset_id, set())
            was_attached = mapping in attached
            for f in affected:
                gone = contrib[f].pop(mapping)[0]
                if not contrib[f]:
                    del contrib[f]
                cur, new = asset.fields.get(f), _best(contrib.get(f, {}), attached)
                if was_attached:
                    changes[f] = [gone.value, None]  # its own value left (LIVEOPS-116)
                    visible_changed = True
                else:
                    ch = _change(_own_view(cur, attached), _own_view(new, attached))
                    if ch is not None:
                        changes[f] = ch
                if new is None:
                    if cur is not None:
                        visible_changed = True
                        del asset.fields[f]
                    continue
                if cur is None or cur.value != new.value or cur.source_id != new.source_id:
                    visible_changed = True
                asset.fields[f] = new
            attached.discard(mapping)
            if not contrib:
                del site[event.asset_id]
                del contribs[event.asset_id]
                attached_by_asset.pop(event.asset_id, None)
                removed = True
                msg = StreamMessage(type="remove", site_id=event.site_id, assets=[{"asset_id": event.asset_id}])
            elif not visible_changed:
                return None, None  # only hidden (overridden) values left
            else:
                asset.attached = self._attached_view(contrib, attached)
                asset.updated_ts = event.received_ts
                msg = StreamMessage(type="upsert", site_id=event.site_id, assets=[asset.flat()])
        else:
            fields = expand_attributes(event.fields)
            if not fields:
                return None, None  # an empty upsert must not leave a ghost asset
            if asset is None:
                asset = Asset(site_id=event.site_id, asset_id=event.asset_id)
            contrib = contribs.get(event.asset_id, {})
            attached = attached_by_asset.get(event.asset_id, set())
            if (mapping in attached) != event.attached:
                visible_changed = True  # it moved in or out of _attached
                if event.attached:
                    attached.add(mapping)
                else:
                    attached.discard(mapping)
            self._seq += 1
            for k, v in fields.items():
                per = contrib.setdefault(k, {})
                own = per.get(mapping)
                if own is not None and own[0].updated_ts > event.received_ts:
                    continue  # this mapping already sent something newer
                per[mapping] = (
                    FieldValue(value=v, source_id=event.source_id, mapping_id=mapping, updated_ts=event.received_ts),
                    self._seq,
                )
                cur, new = asset.fields.get(k), _best(per, attached)
                assert new is not None
                if event.attached:
                    old = own[0].value if own is not None else _MISSING
                    ch = _change(old, v)
                    if ch is not None or own is None or own[0].source_id != event.source_id:
                        visible_changed = True  # its _attached values changed
                else:
                    ch = _change(_own_view(cur, attached), _own_view(new, attached))
                if ch is not None:
                    changes[k] = ch
                if cur is None or cur.value != new.value or cur.source_id != new.source_id:
                    visible_changed = True
                asset.fields[k] = new
            site[event.asset_id] = asset
            contribs[event.asset_id] = contrib
            if attached:
                attached_by_asset[event.asset_id] = attached
            else:
                attached_by_asset.pop(event.asset_id, None)
            if not visible_changed:
                return None, None
            asset.attached = self._attached_view(contrib, attached)
            asset.updated_ts = event.received_ts
            msg = StreamMessage(type="upsert", site_id=event.site_id, assets=[asset.flat()])
        entry: EventEntry | None = None
        if changes:
            entry = {
                "ts": 0.0,  # set by the log
                "site_id": event.site_id,
                "asset_id": event.asset_id,
                "op": event.op.value,
                "removed": removed,
                "source_id": event.source_id,
                "mapping_id": event.mapping_id,
                "changes": changes,
            }
        return msg, entry

    async def site_assets(self, site_id: str) -> list[Asset]:
        return [a.model_copy(deep=True) for a in self._assets.get(site_id, {}).values()]

    async def clear_mapping(self, site_id: str, mapping_id: str) -> None:
        await self.reconcile(site_id, mapping_id, set())

    async def reconcile(self, site_id: str, mapping_id: str, keep: set[str]) -> int:
        touched = 0
        for n, (asset_id, contrib) in enumerate(list(self._contrib.get(site_id, {}).items())):
            if asset_id in keep or not any(mapping_id in per for per in contrib.values()):
                continue
            if await self.apply(_remove_event(site_id, asset_id, mapping_id)) is not None:
                touched += 1
            if n % REMOVE_YIELD_EVERY == 0:
                await asyncio.sleep(0)  # let WebSocket senders drain a big burst (LIVEOPS-55)
        return touched

    async def events(self, site_id: str, since: float | None = None, limit: int = 100) -> list[EventEntry]:
        return self._log.query(site_id, since, limit)
