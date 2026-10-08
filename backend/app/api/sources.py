from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import secrets as secrets_mod
from app.api.deps import mapping_spec, runner
from app.api.schemas import SourceIn, SourceOut, SourceUpdate
from app.connectors import build, get_class, specs
from app.connectors.base import Connector, ConnectorError, ConnectorSpec, Dataset, Record, TestReport, TestStep
from app.core.mapping import MappingConfig
from app.core.runner import RunnerManager
from app.core.suggest import ExistingMapping, Suggestion, preview_priority, suggest
from app.db import Mapping, Site, Source, get_session

router = APIRouter(prefix="/api", tags=["sources"])
log = logging.getLogger("liveops.api.sources")

# Suggestions read a small sample of each table, within a time budget, so a
# source with hundreds of tables or a slow one still answers quickly.
SUGGEST_DISCOVER_TIMEOUT_S = 15.0
SUGGEST_PREVIEW_ROWS = 200
SUGGEST_MAX_PREVIEWS = 25
SUGGEST_PREVIEW_TIMEOUT_S = 5.0
SUGGEST_BUDGET_S = 20.0


# Settings that identify *where* a source lives. Changing one requires the
# secrets to be entered again (LIVEOPS-24).
ENDPOINT_FIELDS = (
    "host",
    "port",
    "database",
    "service_name",
    "dsn",
    "base_url",
    "url",
    "path",
    "token_url",
    "endpoint_url",
    "bucket",
    "region",
    # Weakening transport security also counts as moving the endpoint (LIVEOPS-74).
    "encryption",
    "ssl_ca",
    "ca_file",
    "allow_private_network",
    "allow_http",
)


def _warnings(src_type: str, settings: dict[str, Any]) -> list[str]:
    w = []
    if settings.get("encryption") == "off":
        w.append("Encryption is off. Use this only for local testing; company databases should use Required.")
    if settings.get("encryption") == "required_legacy_auth":
        w.append(
            "Older password methods are allowed: someone impersonating the server could learn the password. "
            "Switch the database user to SCRAM and choose Required."
        )
    if settings.get("allow_http"):
        w.append("Plain HTTP is allowed, so data and keys travel unencrypted. Use this only for local testing.")
    if settings.get("allow_private_network") is True:
        w.append("Private network addresses are allowed. Only use this for APIs or storage you trust on your network.")
    return w


def _out(s: Source) -> SourceOut:
    warnings = _warnings(s.type, s.settings or {})
    try:
        secrets_set = secrets_mod.mask(secrets_mod.decrypt(s.secrets_enc))
        unreadable = False
    except secrets_mod.SecretsError:
        # Still list the source so the user can re-enter its password (LIVEOPS-91/41).
        secrets_set, unreadable = {}, True
        warnings.append(
            "The saved password or token can't be read because the server's secret key changed. "
            "Open the source and enter its password again."
        )
    return SourceOut(
        id=s.id,
        name=s.name,
        type=s.type,
        settings=s.settings or {},
        secrets_set=secrets_set,
        secrets_unreadable=unreadable,
        warnings=warnings,
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
    old = s.settings or {}
    moved = [k for k in ENDPOINT_FIELDS if (k in settings or k in old) and settings.get(k) != old.get(k)]
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


async def _samples(conn: Connector, datasets: list[Dataset]) -> dict[str, list[Record]]:
    out: dict[str, list[Record]] = {}
    deadline = time.monotonic() + SUGGEST_BUDGET_S
    for d in sorted(datasets, key=preview_priority)[:SUGGEST_MAX_PREVIEWS]:
        left = deadline - time.monotonic()
        if left <= 0.2:
            break
        try:
            out[d.name] = await asyncio.wait_for(
                conn.preview(d.name, SUGGEST_PREVIEW_ROWS), min(SUGGEST_PREVIEW_TIMEOUT_S, left)
            )
        except TimeoutError:
            log.info("suggestions: preview of %s timed out; suggesting from its columns only", d.name)
        except Exception as e:  # noqa: BLE001 - one unreadable table must not stop the others
            log.info("suggestions: preview of %s failed: %s", d.name, type(e).__name__)
    return out


@router.get("/sources/{source_id}/suggestions", response_model=list[Suggestion])
async def suggestions(
    source_id: str, site_id: str | None = None, session: Session = Depends(get_session)
) -> list[Suggestion]:
    """Suggested mappings from this source for a site (ADR 0006)."""
    s = _get(session, source_id)
    existing: list[ExistingMapping] = []
    if site_id:
        if session.get(Site, site_id) is None:
            raise HTTPException(404, detail={"message": "Site not found"})
        for m in session.scalars(select(Mapping).where(Mapping.site_id == site_id)):
            cfg = MappingConfig.model_validate(m.config)
            existing.append(
                ExistingMapping(
                    mapping_id=m.id,
                    source_id=m.source_id,
                    dataset=m.dataset,
                    key_field=cfg.key_field,
                    kind=cfg.kind,
                    attached=cfg.key_field != cfg.id_field,
                )
            )
    conn = build(s.type, s.settings or {}, secrets_mod.decrypt(s.secrets_enc), source_id=s.id)
    try:
        datasets = await asyncio.wait_for(conn.discover(), SUGGEST_DISCOVER_TIMEOUT_S)
        samples = await _samples(conn, datasets)
    except TimeoutError as e:
        raise HTTPException(
            504,
            detail={
                "message": "The source took too long to list its tables",
                "hint": "Run Test connection on the source, or narrow the schemas it lists.",
            },
        ) from e
    except ConnectorError as e:
        raise HTTPException(400, detail={"message": str(e), "hint": e.hint}) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, detail={"message": str(e).splitlines()[0][:300]}) from e
    finally:
        await conn.close()
    return suggest(datasets, samples, source_id=s.id, existing=existing)
