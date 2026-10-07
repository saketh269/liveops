"""Live stream per site, plus the site's event log.

WebSocket ``/ws/sites/{site_id}`` sends a ``snapshot`` first, then
``upsert``/``remove`` messages, each visible change followed by a ``type:
"event"`` feed message. Every ``PING_INTERVAL_S`` it also sends ``{"type":
"ping"}`` so proxies keep the connection open and clients can detect a dead
link; clients ignore message types they don't know.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any
from urllib.parse import urlsplit

import anyio
from fastapi import APIRouter, Depends, Query, WebSocket

from app.api.deps import state_store
from app.config import get_settings
from app.core.eventlog import MAX_LIMIT, describe
from app.core.events import StreamMessage
from app.core.state import StateStore

router = APIRouter(tags=["stream"])


def _allowed_origin_hosts() -> set[str]:
    return {h.strip("[]") for h in get_settings().allowed_hosts}


log = logging.getLogger("liveops.stream")

PING_INTERVAL_S = 20.0
# A client that can't take one message within this time is cut off; it can
# reconnect and gets a fresh snapshot. Its queue in the store is bounded too.
SEND_TIMEOUT_S = 10.0


@router.get("/api/sites/{site_id}/events")
async def site_events(
    site_id: str,
    since: float | None = Query(default=None, description="Only entries with ts greater than this (seconds)"),
    limit: int = Query(default=100, ge=1, description=f"Most entries to return (capped at {MAX_LIMIT})"),
    store: StateStore = Depends(state_store),
) -> list[dict[str, Any]]:
    """Recent changes on the site, oldest first. Page with ``since=<last ts>``."""
    entries = await store.events(site_id, since=since, limit=min(limit, MAX_LIMIT))
    return [{**e, "text": describe(e)} for e in entries]


@router.websocket("/ws/sites/{site_id}")
async def site_stream(ws: WebSocket, site_id: str) -> None:
    """Snapshot of the site's assets, then live upserts/removes/feed events."""
    origin = ws.headers.get("origin")
    if origin and (urlsplit(origin).hostname or "") not in _allowed_origin_hosts():
        # Browsers send Origin on WebSockets; refuse pages from other sites (LIVEOPS-15).
        await ws.close(code=1008, reason="Origin not allowed")
        return
    await ws.accept()
    store: StateStore = ws.app.state.store
    gen = store.subscribe(site_id)
    next_msg: asyncio.Task[StreamMessage] = asyncio.ensure_future(anext(gen))
    received: asyncio.Task[Any] = asyncio.ensure_future(ws.receive())
    next_ping = time.monotonic() + PING_INTERVAL_S
    try:
        while True:
            timeout = max(0.0, next_ping - time.monotonic())
            done, _ = await asyncio.wait({next_msg, received}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if received in done:
                if received.result().get("type") == "websocket.disconnect":
                    break
                received = asyncio.ensure_future(ws.receive())  # client messages are ignored
            if next_msg in done:
                msg = next_msg.result()  # raises if the store failed; the finally block cleans up
                await asyncio.wait_for(ws.send_text(msg.model_dump_json()), SEND_TIMEOUT_S)
                next_msg = asyncio.ensure_future(anext(gen))
            if time.monotonic() >= next_ping:
                ping = StreamMessage(type="ping", site_id=site_id)
                await asyncio.wait_for(ws.send_text(ping.model_dump_json()), SEND_TIMEOUT_S)
                next_ping = time.monotonic() + PING_INTERVAL_S
    except TimeoutError:
        log.info("closing slow WebSocket client on site %s", site_id)
        with contextlib.suppress(Exception):
            await ws.close(code=1013, reason="Client too slow; reconnect to get a fresh snapshot")
    except Exception as e:  # noqa: BLE001 - a broken client or store must not crash the server
        log.info("WebSocket on site %s ended: %s", site_id, e)
    finally:
        # Shielded: when the server cancels this handler, the unsubscribe must still run.
        with anyio.move_on_after(5, shield=True):
            for task in (next_msg, received):
                task.cancel()
            await asyncio.gather(next_msg, received, return_exceptions=True)
            with contextlib.suppress(Exception):
                await gen.aclose()
