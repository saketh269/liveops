"""Runs one streaming task per active mapping:
connector.stream() -> apply_mapping() -> state.apply() -> WebSocket subscribers.

Failures never crash the app: a task records its error, waits with
exponential backoff (max 60 s), and reconnects.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from app.connectors import build
from app.connectors.base import Connector, ConnectorError
from app.core.mapping import MappingConfig, MappingProblem, apply_mapping
from app.core.state import StateStore

log = logging.getLogger("liveops.runner")


@dataclass
class MappingHealth:
    mapping_id: str
    source_id: str
    status: str = "starting"  # starting | running | error | paused
    last_event_ts: float | None = None
    last_error: str | None = None
    last_error_hint: str | None = None
    last_error_ts: float | None = None
    events_total: int = 0
    skipped_records: int = 0
    lag_ms_recent: deque[float] = field(default_factory=lambda: deque(maxlen=200))
    _event_times: deque[float] = field(default_factory=lambda: deque(maxlen=2000))

    def record_event(self, source_ts: float | None, received_ts: float) -> None:
        now = time.time()
        self.events_total += 1
        self.last_event_ts = now
        self._event_times.append(now)
        lag_from = source_ts or received_ts
        self.lag_ms_recent.append(max(0.0, (now - lag_from) * 1000))

    def as_dict(self) -> dict[str, Any]:
        now = time.time()
        recent = [t for t in self._event_times if now - t <= 60]
        lags = sorted(self.lag_ms_recent)
        p95 = lags[int(len(lags) * 0.95) - 1] if lags else None
        return {
            "mapping_id": self.mapping_id,
            "source_id": self.source_id,
            "status": self.status,
            "last_event_ts": self.last_event_ts,
            "events_total": self.events_total,
            "events_per_min": len(recent),
            "lag_ms_p95": round(p95, 1) if p95 is not None else None,
            "skipped_records": self.skipped_records,
            "last_error": self.last_error,
            "last_error_hint": self.last_error_hint,
            "last_error_ts": self.last_error_ts,
        }


@dataclass
class MappingSpec:
    mapping_id: str
    site_id: str
    source_id: str
    source_type: str
    settings: dict[str, Any]
    secrets: dict[str, Any]
    dataset: str
    config: MappingConfig
    options: dict[str, Any]


class RunnerManager:
    def __init__(self, state: StateStore) -> None:
        self.state = state
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self.health: dict[str, MappingHealth] = {}

    def is_running(self, mapping_id: str) -> bool:
        t = self._tasks.get(mapping_id)
        return t is not None and not t.done()

    async def start(self, spec: MappingSpec) -> None:
        await self.stop(spec.mapping_id, clear=False)
        self.health[spec.mapping_id] = MappingHealth(spec.mapping_id, spec.source_id)
        self._tasks[spec.mapping_id] = asyncio.create_task(self._run(spec), name=f"mapping:{spec.mapping_id}")

    async def stop(self, mapping_id: str, *, clear: bool = True, site_id: str | None = None) -> None:
        task = self._tasks.pop(mapping_id, None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if mapping_id in self.health:
            self.health[mapping_id].status = "paused"
        if clear and site_id:
            await self.state.clear_mapping(site_id, mapping_id)

    async def stop_all(self) -> None:
        for mid in list(self._tasks):
            await self.stop(mid, clear=False)

    async def _run(self, spec: MappingSpec) -> None:
        h = self.health[spec.mapping_id]
        backoff = 1.0
        while True:
            connector: Connector | None = None
            try:
                connector = build(spec.source_type, spec.settings, spec.secrets)
                h.status = "running"
                async for change in connector.stream(spec.dataset, [spec.config.key_field], spec.options):
                    try:
                        event = apply_mapping(
                            change,
                            spec.config,
                            site_id=spec.site_id,
                            source_id=spec.source_id,
                            mapping_id=spec.mapping_id,
                        )
                    except MappingProblem as e:
                        h.skipped_records += 1
                        h.last_error, h.last_error_ts = str(e), time.time()
                        continue
                    await self.state.apply(event)
                    h.record_event(change.source_ts, change.received_ts)
                    backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - a source failure must not kill the app
                h.status = "error"
                h.last_error = str(e).splitlines()[0] if str(e) else type(e).__name__
                h.last_error_hint = getattr(e, "hint", None) if isinstance(e, ConnectorError) else None
                h.last_error_ts = time.time()
                log.warning("mapping %s failed: %s; retrying in %.0fs", spec.mapping_id, h.last_error, backoff)
            finally:
                if connector is not None:
                    try:
                        await connector.close()
                    except Exception as e:  # noqa: BLE001
                        log.debug("close failed for %s: %s", spec.mapping_id, e)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)
