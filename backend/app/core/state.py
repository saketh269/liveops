"""State store: current state of every asset, merged across sources.

``StateStore`` is the interface. ``InMemoryStateStore`` is the reference
implementation used in tests and single-process deployments. agent-core adds
the Redis implementation behind the same interface.

Merge rule (v0.1): each field keeps the most recent value by received time,
with its source recorded. When a source removes an asset, only that source's
fields are dropped; the asset disappears once no source contributes fields.
"""

from __future__ import annotations

import abc
import asyncio
import time
from collections import defaultdict
from collections.abc import AsyncIterator

from app.core.events import Asset, AssetEvent, AssetOp, FieldValue, StreamMessage


class StateStore(abc.ABC):
    @abc.abstractmethod
    async def apply(self, event: AssetEvent) -> StreamMessage | None:
        """Apply one event. Returns the message to broadcast, or None if
        nothing visible changed."""

    @abc.abstractmethod
    async def site_assets(self, site_id: str) -> list[Asset]: ...

    @abc.abstractmethod
    def subscribe(self, site_id: str) -> AsyncIterator[StreamMessage]:
        """Snapshot first, then live messages for this site."""

    @abc.abstractmethod
    async def clear_mapping(self, site_id: str, mapping_id: str) -> None:
        """Drop all fields a mapping contributed (mapping paused/deleted)."""


class InMemoryStateStore(StateStore):
    def __init__(self, queue_size: int = 1000) -> None:
        self._assets: dict[str, dict[str, Asset]] = defaultdict(dict)
        self._subs: dict[str, set[asyncio.Queue[StreamMessage]]] = defaultdict(set)
        self._lock = asyncio.Lock()
        self._queue_size = queue_size

    async def apply(self, event: AssetEvent) -> StreamMessage | None:
        async with self._lock:
            site = self._assets[event.site_id]
            asset = site.get(event.asset_id)
            if event.op == AssetOp.REMOVE:
                if asset is None:
                    return None
                asset.fields = {k: v for k, v in asset.fields.items() if v.mapping_id != event.mapping_id}
                if not asset.fields:
                    del site[event.asset_id]
                    msg = StreamMessage(type="remove", site_id=event.site_id, assets=[{"asset_id": event.asset_id}])
                else:
                    asset.updated_ts = event.received_ts
                    msg = StreamMessage(type="upsert", site_id=event.site_id, assets=[asset.flat()])
            else:
                if asset is None:
                    asset = Asset(site_id=event.site_id, asset_id=event.asset_id)
                    site[event.asset_id] = asset
                changed = False
                for k, v in event.fields.items():
                    cur = asset.fields.get(k)
                    if cur is not None and cur.updated_ts > event.received_ts:
                        continue  # a newer value already won
                    if cur is None or cur.value != v or cur.source_id != event.source_id:
                        changed = True
                    asset.fields[k] = FieldValue(
                        value=v, source_id=event.source_id, mapping_id=event.mapping_id, updated_ts=event.received_ts
                    )
                if not changed:
                    return None
                asset.updated_ts = event.received_ts
                msg = StreamMessage(type="upsert", site_id=event.site_id, assets=[asset.flat()])
        self._publish(msg)
        return msg

    async def site_assets(self, site_id: str) -> list[Asset]:
        return list(self._assets.get(site_id, {}).values())

    async def clear_mapping(self, site_id: str, mapping_id: str) -> None:
        for asset in list(self._assets.get(site_id, {}).values()):
            if any(v.mapping_id == mapping_id for v in asset.fields.values()):
                await self.apply(
                    AssetEvent(
                        site_id=site_id,
                        asset_id=asset.asset_id,
                        op=AssetOp.REMOVE,
                        source_id="",
                        mapping_id=mapping_id,
                        dataset="",
                        received_ts=time.time(),
                    )
                )

    async def subscribe(self, site_id: str) -> AsyncIterator[StreamMessage]:
        q: asyncio.Queue[StreamMessage] = asyncio.Queue(self._queue_size)
        self._subs[site_id].add(q)
        try:
            snap = [a.flat() for a in await self.site_assets(site_id)]
            yield StreamMessage(type="snapshot", site_id=site_id, assets=snap)
            while True:
                yield await q.get()
        finally:
            self._subs[site_id].discard(q)

    def publish_event(self, site_id: str, event: dict[str, object]) -> None:
        """Send a human-readable feed entry (e.g. 'Bed 06 now in_use')."""
        self._publish(StreamMessage(type="event", site_id=site_id, event=event))

    def _publish(self, msg: StreamMessage) -> None:
        for q in list(self._subs.get(msg.site_id, ())):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # Slow client: drop its oldest message instead of blocking everyone.
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
