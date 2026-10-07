from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__
from app.api.deps import runner, state_store
from app.core.runner import RunnerManager
from app.core.state import StateStore
from app.db import get_session

router = APIRouter(tags=["system"])


@router.get("/api/health")
def health(session: Session = Depends(get_session)) -> dict[str, Any]:
    db_ok = True
    try:
        session.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False
    return {"ok": db_ok, "version": __version__, "portal_db": "ok" if db_ok else "unreachable"}


@router.get("/api/health/mappings")
def mapping_health(rm: RunnerManager = Depends(runner)) -> list[dict[str, Any]]:
    return [h.as_dict() for h in rm.health.values()]


@router.get("/api/sites/{site_id}/assets")
async def site_assets(site_id: str, store: StateStore = Depends(state_store)) -> list[dict[str, Any]]:
    return [a.flat() for a in await store.site_assets(site_id)]
