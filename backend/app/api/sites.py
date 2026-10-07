from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import runner
from app.api.schemas import SiteIn, SiteOut, SiteUpdate
from app.core.runner import RunnerManager
from app.db import Mapping, Site, get_session

router = APIRouter(prefix="/api/sites", tags=["sites"])


def _out(s: Site) -> SiteOut:
    return SiteOut(
        id=s.id,
        name=s.name,
        template=s.template,
        layout=s.layout or {},
        created_ts=s.created_ts,
        updated_ts=s.updated_ts,
    )


def _get(session: Session, site_id: str) -> Site:
    s = session.get(Site, site_id)
    if s is None:
        raise HTTPException(404, detail={"message": "Site not found"})
    return s


@router.get("", response_model=list[SiteOut])
def list_sites(session: Session = Depends(get_session)) -> list[SiteOut]:
    return [_out(s) for s in session.scalars(select(Site).order_by(Site.created_ts))]


@router.post("", response_model=SiteOut, status_code=201)
def create_site(body: SiteIn, session: Session = Depends(get_session)) -> SiteOut:
    s = Site(name=body.name, template=body.template, layout=body.layout or {"zones": []})
    session.add(s)
    session.commit()
    return _out(s)


@router.get("/{site_id}", response_model=SiteOut)
def get_site(site_id: str, session: Session = Depends(get_session)) -> SiteOut:
    return _out(_get(session, site_id))


@router.put("/{site_id}", response_model=SiteOut)
def update_site(site_id: str, body: SiteUpdate, session: Session = Depends(get_session)) -> SiteOut:
    s = _get(session, site_id)
    if body.name is not None:
        s.name = body.name
    if body.template is not None:
        s.template = body.template
    if body.layout is not None:
        s.layout = body.layout
    s.updated_ts = time.time()
    session.commit()
    return _out(s)


@router.delete("/{site_id}", status_code=204)
async def delete_site(
    site_id: str, session: Session = Depends(get_session), rm: RunnerManager = Depends(runner)
) -> None:
    s = _get(session, site_id)
    for m in session.scalars(select(Mapping).where(Mapping.site_id == s.id)):
        await rm.stop(m.id, site_id=s.id)
    session.delete(s)
    session.commit()
