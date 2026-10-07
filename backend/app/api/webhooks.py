"""Receives pushed events for ``webhook`` sources.

``POST /api/webhooks/{source_id}`` with a signed JSON body. How to sign:
see ``app/connectors/webhook.py``.

Responses: 202 accepted, 401 bad/missing/expired signature, 404 unknown
source, 413 body too large, 422 body isn't usable records.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app import secrets as secrets_mod
from app.connectors.base import ConnectorError
from app.connectors.webhook import SIGNATURE_HEADER, TIMESTAMP_HEADER, SignatureError, WebhookConnector
from app.db import Source, get_session

router = APIRouter(prefix="/api", tags=["webhooks"])


async def read_capped(request: Request, limit: int) -> bytes:
    """Read the raw body, refusing (413) as soon as it passes ``limit`` bytes."""
    too_big = HTTPException(
        413,
        detail={
            "message": f"Request body is larger than {limit // 1024} KB",
            "hint": "Send fewer records per request, or raise 'Max request size' on the source.",
        },
    )
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise too_big
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > limit:
            raise too_big
    return bytes(buf)


@router.post("/webhooks/{source_id}", status_code=202)
async def receive(source_id: str, request: Request, session: Session = Depends(get_session)) -> dict[str, int]:
    src = session.get(Source, source_id)
    if src is None or src.type != "webhook":
        raise HTTPException(
            404,
            detail={
                "message": "No webhook source with this id",
                "hint": "Copy the URL from the source's page in Live Ops.",
            },
        )
    conn = WebhookConnector(src.settings or {}, secrets_mod.decrypt(src.secrets_enc), source_id=src.id)
    body = await read_capped(request, conn.max_body_bytes)
    try:
        n = await conn.accept(body, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER))
    except SignatureError as e:
        raise HTTPException(401, detail={"message": str(e)}) from None
    except ConnectorError as e:  # the source itself is misconfigured (e.g. secret too short)
        raise HTTPException(401, detail={"message": str(e), "hint": e.hint}) from None
    except ValueError as e:
        raise HTTPException(422, detail={"message": str(e)}) from None
    return {"accepted": n}
