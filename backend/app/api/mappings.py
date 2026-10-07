from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import secrets as secrets_mod
from app.api.deps import mapping_spec, runner
from app.api.schemas import MappingIn, MappingOut, MappingUpdate
from app.connectors import build
from app.connectors.base import ConnectorError
from app.core.mapping import MappingConfig, validate_against_columns
from app.core.runner import RunnerManager
from app.db import Mapping, Site, Source, get_session

router = APIRouter(prefix="/api/mappings", tags=["mappings"])


def _out(m: Mapping, rm: RunnerManager) -> MappingOut:
    return MappingOut(
        id=m.id,
        site_id=m.site_id,
        source_id=m.source_id,
        dataset=m.dataset,
        config=MappingConfig.model_validate(m.config),
        options=m.options or {},
        active=m.active,
        running=rm.is_running(m.id),
        created_ts=m.created_ts,
        updated_ts=m.updated_ts,
    )


async def _check_columns(src: Source, dataset: str, config: MappingConfig) -> None:
    conn = build(src.type, src.settings or {}, secrets_mod.decrypt(src.secrets_enc), source_id=src.id)
    try:
        datasets = {d.name: d for d in await conn.discover()}
    except ConnectorError as e:
        raise HTTPException(400, detail={"message": str(e), "hint": e.hint}) from e
    except Exception as e:  # noqa: BLE001 - the source is unreachable or misconfigured
        raise HTTPException(
            502,
            detail={
                "message": f"Couldn't read the source: {str(e).splitlines()[0][:200] if str(e) else type(e).__name__}",
                "hint": "Run Test connection on the source to see which step fails.",
            },
        ) from e
    finally:
        await conn.close()
    if dataset not in datasets:
        raise HTTPException(422, detail={"message": f"{dataset!r} isn't available from this source"})
    problems = validate_against_columns(config, {c.name for c in datasets[dataset].columns})
    if problems:
        raise HTTPException(422, detail={"message": "Mapping doesn't match the table", "problems": problems})


@router.get("", response_model=list[MappingOut])
def list_mappings(
    site_id: str | None = None, session: Session = Depends(get_session), rm: RunnerManager = Depends(runner)
) -> list[MappingOut]:
    q = select(Mapping).order_by(Mapping.created_ts)
    if site_id:
        q = q.where(Mapping.site_id == site_id)
    return [_out(m, rm) for m in session.scalars(q)]


@router.post("", response_model=MappingOut, status_code=201)
async def create_mapping(
    body: MappingIn, session: Session = Depends(get_session), rm: RunnerManager = Depends(runner)
) -> MappingOut:
    src = session.get(Source, body.source_id)
    if src is None or session.get(Site, body.site_id) is None:
        raise HTTPException(404, detail={"message": "Site or source not found"})
    await _check_columns(src, body.dataset, body.config)
    m = Mapping(
        site_id=body.site_id,
        source_id=body.source_id,
        dataset=body.dataset,
        config=body.config.model_dump(),
        options=body.options,
        active=body.active,
    )
    session.add(m)
    session.commit()
    if m.active:
        await rm.start(mapping_spec(m, src))
    return _out(m, rm)


@router.put("/{mapping_id}", response_model=MappingOut)
async def update_mapping(
    mapping_id: str, body: MappingUpdate, session: Session = Depends(get_session), rm: RunnerManager = Depends(runner)
) -> MappingOut:
    m = session.get(Mapping, mapping_id)
    if m is None:
        raise HTTPException(404, detail={"message": "Mapping not found"})
    src = session.get(Source, m.source_id)
    assert src is not None
    dataset = body.dataset or m.dataset
    config = body.config or MappingConfig.model_validate(m.config)
    if body.dataset or body.config:
        await _check_columns(src, dataset, config)
    shape_changed = dataset != m.dataset or config.model_dump() != m.config
    m.dataset, m.config = dataset, config.model_dump()
    if body.options is not None:
        m.options = body.options
    if body.active is not None:
        m.active = body.active
    m.updated_ts = time.time()
    session.commit()
    if shape_changed or not m.active:
        # Drop what the old mapping put on the map; the restarted stream rebuilds it.
        await rm.stop(m.id, site_id=m.site_id)
    if m.active:
        await rm.start(mapping_spec(m, src))
    return _out(m, rm)


@router.delete("/{mapping_id}", status_code=204)
async def delete_mapping(
    mapping_id: str, session: Session = Depends(get_session), rm: RunnerManager = Depends(runner)
) -> None:
    m = session.get(Mapping, mapping_id)
    if m is None:
        raise HTTPException(404, detail={"message": "Mapping not found"})
    await rm.stop(m.id, site_id=m.site_id)
    session.delete(m)
    session.commit()
