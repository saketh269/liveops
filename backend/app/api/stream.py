from __future__ import annotations

import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["stream"])


@router.websocket("/ws/sites/{site_id}")
async def site_stream(ws: WebSocket, site_id: str) -> None:
    """Snapshot of the site's assets, then live upserts/removes/feed events."""
    await ws.accept()
    store = ws.app.state.store
    gen = store.subscribe(site_id)
    try:
        async for msg in gen:
            await ws.send_text(msg.model_dump_json())
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(Exception):
            await gen.aclose()
