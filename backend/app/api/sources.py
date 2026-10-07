from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import secrets as secrets_mod
from app.api.deps import mapping_spec, runner
from app.api.schemas import SourceIn, SourceOut, SourceUpdate
from app.connectors import build, get_class, specs
from app.connectors.base import ConnectorError, ConnectorSpec, Dataset, Record, TestReport, TestStep
from app.core.runner import RunnerManager
from app.db import Mapping, Source, get_session

router = APIRouter(prefix="/api", tags=["sources"])


# Settings that identify *where* a source lives. Changing one requires the
# secrets to be entered again (LIVEOPS-24).
ENDPOINT_FIELDS = ("host", "port", "base_url", "url", "token_url", "endpoint_url", "bucket", "region")


def _warnings(src_type: str, settings: dict[str, Any]) -> list[str]:
    w = []
    if settings.get("encryption") == "off":
        w.append("Encryption is off. Use this only for local testing; company databases should use Required.")
    if settings.get("allow_http"):
        w.append("Plain HTTP is allowed, so data and keys travel unencrypted. Use this only for local testing.")
    if settings.get("allow_private_network") is True:
        w.append("Private network addresses are allowed. Only use this for APIs or storage you trust on your network.")
    return w


def _out(s: Source) -> SourceOut:
    return SourceOut(
        id=s.id,
        name=s.name,
        type=s.type,
        settings=s.settings or {},
        secrets_set=secrets_mod.mask(secrets_mod.decrypt(s.secrets_enc)),
        warnings=_warnings(s.type, s.settings or {}),
        created_ts=s.created_ts,
        updated_ts=s.updated_ts,
    )


def _validate(src_type: str, settings: dict[str, Any], secrets: dict[str, Any]) -> None:
    try:
        spec = get_class(src_type).spec
    except ConnectorError as e:
        raise HTTPException(422, detail={"message": str(e), "hint": e.hint}) from e
    missing = [f for f in spec.settings_schema.get("required", []) if settings.get(f) in (None, "")]
    missing += [f for f in spec.secrets_schema.get("required", []) if not secrets.get(f)]
    unknown_secret = set(secrets) - set(spec.secrets_schema.get("properties", {}))
    if missing:
        raise HTTPException(422, detail={"message": "Missing required fields", "fields": missing})
    if unknown_secret:
        raise HTTPException(422, detail={"message": "Unknown secret fields", "fields": sorted(unknown_secret)})


def _get(session: Session, source_id: str) -> Source:
    s = session.get(Source, source_id)
    if s is None:
        raise HTTPException(404, detail={"message": "Source not found"})
    return s


@router.get("/connectors", response_model=list[ConnectorSpec])
def list_connectors() -> list[ConnectorSpec]:
    return specs()


@router.get("/sources", response_model=list[SourceOut])
def list_sources(session: Session = Depends(get_session)) -> list[SourceOut]:
    return [_out(s) for s in session.scalars(select(Source).order_by(Source.created_ts))]


@router.post("/sources", response_model=SourceOut, status_code=201)
def create_source(body: SourceIn, session: Session = Depends(get_session)) -> SourceOut:
    _validate(body.type, body.settings, body.secrets)
    s = Source(name=body.name, type=body.type, settings=body.settings, secrets_enc=secrets_mod.encrypt(body.secrets))
    session.add(s)
    session.commit()
    return _out(s)


@router.get("/sources/{source_id}", response_model=SourceOut)
def get_source(source_id: str, session: Session = Depends(get_session)) -> SourceOut:
    return _out(_get(session, source_id))


@router.put("/sources/{source_id}", response_model=SourceOut)
async def update_source(
    source_id: str,
    body: SourceUpdate,
    session: Session = Depends(get_session),
    rm: RunnerManager = Depends(runner),
) -> SourceOut:
    s = _get(session, source_id)
    try:
        secrets = secrets_mod.decrypt(s.secrets_enc)
    except secrets_mod.SecretsError:
        # Saved secrets were encrypted with another key. Let the user re-enter
        # them here; refuse only if they didn't (LIVEOPS-41 follow-up).
        if not body.secrets or not any(v not in (None, "") for v in body.secrets.values()):
            raise
        secrets = {}
    settings = body.settings if body.settings is not None else (s.settings or {})
    new_secrets = body.secrets or {}
    # Saved credentials must not follow the source to a different server.
    moved = [k for k in ENDPOINT_FIELDS if k in settings and settings.get(k) != (s.settings or {}).get(k)]
    if moved and secrets and not any(v not in (None, "") for v in new_secrets.values()):
        raise HTTPException(
            422,
            detail={
                "message": f"Re-enter the password or token when changing {', '.join(moved)}",
                "hint": "Saved credentials are only sent to the server they were entered for.",
                "fields": sorted(secrets),
            },
        )
    for k, v in new_secrets.items():
        if v is None:
            secrets.pop(k, None)  # explicit null clears a secret
        elif v != "":
            secrets[k] = v  # "" or omitted keeps the saved value
    if moved:
        secrets = {k: v for k, v in secrets.items() if k in new_secrets}
    _validate(s.type, settings, secrets)
    if body.name is not None:
        s.name = body.name
    s.settings = settings
    s.secrets_enc = secrets_mod.encrypt(secrets)
    s.updated_ts = time.time()
    session.commit()
    # Restart running mappings so they pick up the new connection settings.
    for m in session.scalars(select(Mapping).where(Mapping.source_id == s.id, Mapping.active.is_(True))):
        await rm.start(mapping_spec(m, s))
    return _out(s)


@router.delete("/sources/{source_id}", status_code=204)
async def delete_source(
    source_id: str, session: Session = Depends(get_session), rm: RunnerManager = Depends(runner)
) -> None:
    s = _get(session, source_id)
    for m in session.scalars(select(Mapping).where(Mapping.source_id == s.id)):
        await rm.stop(m.id, site_id=m.site_id)
    session.delete(s)
    session.commit()


@router.post("/sources/{source_id}/test", response_model=TestReport)
async def test_source(source_id: str, session: Session = Depends(get_session)) -> TestReport:
    s = _get(session, source_id)
    started = time.monotonic()
    try:
        conn = build(s.type, s.settings or {}, secrets_mod.decrypt(s.secrets_enc), source_id=s.id)
    except ConnectorError as e:
        return TestReport.from_steps([TestStep(name="Set up", ok=False, detail=str(e), hint=e.hint)], started)
    try:
        return await conn.test()
    except Exception as e:  # noqa: BLE001 - test must always produce a report
        return TestReport.from_steps([TestStep(name="Run test", ok=False, detail=str(e)[:300])], started)
    finally:
        await conn.close()


@router.get("/sources/{source_id}/datasets", response_model=list[Dataset])
async def list_datasets(source_id: str, session: Session = Depends(get_session)) -> list[Dataset]:
    s = _get(session, source_id)
    conn = build(s.type, s.settings or {}, secrets_mod.decrypt(s.secrets_enc), source_id=s.id)
    try:
        return await conn.discover()
    except ConnectorError as e:
        raise HTTPException(400, detail={"message": str(e), "hint": e.hint}) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, detail={"message": str(e).splitlines()[0][:300]}) from e
    finally:
        await conn.close()


@router.get("/sources/{source_id}/preview", response_model=list[Record])
async def preview(
    source_id: str, dataset: str, limit: int = 20, session: Session = Depends(get_session)
) -> list[Record]:
    s = _get(session, source_id)
    conn = build(s.type, s.settings or {}, secrets_mod.decrypt(s.secrets_enc), source_id=s.id)
    try:
        return await conn.preview(dataset, max(1, min(limit, 200)))
    except ConnectorError as e:
        raise HTTPException(400, detail={"message": str(e), "hint": e.hint}) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, detail={"message": str(e).splitlines()[0][:300]}) from e
    finally:
        await conn.close()
