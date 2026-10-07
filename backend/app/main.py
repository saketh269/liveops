from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import __version__
from app.api import mappings, plans, sites, sources, stream, system, uploads, webhooks
from app.api.deps import mapping_spec
from app.config import get_settings
from app.core.runner import MappingSpec, RunnerManager
from app.core.state import InMemoryStateStore, StateStore
from app.db import Mapping, Source, new_session
from app.secrets import SecretsError

log = logging.getLogger("liveops")


def make_store() -> StateStore:
    """Redis when ``LIVEOPS_REDIS_URL`` is set (several processes share state), else in-memory."""
    settings = get_settings()
    if settings.redis_url:
        from app.core.redis_state import RedisStateStore

        return RedisStateStore.from_url(
            settings.redis_url, prefix=settings.redis_key_prefix, max_connections=settings.redis_max_connections
        )
    return InMemoryStateStore()


async def load_mapping_spec(mapping_id: str) -> MappingSpec | None:
    """Current spec of an active mapping from the portal DB (None if gone or paused)."""

    def _load() -> MappingSpec | None:
        with new_session() as s:
            m = s.get(Mapping, mapping_id)
            src = s.get(Source, m.source_id) if m is not None else None
            if m is None or src is None or not m.active:
                return None
            return mapping_spec(m, src)

    return await asyncio.to_thread(_load)


def make_runner(store: StateStore) -> RunnerManager:
    """With Redis, processes share mappings through leases (one owner each, LIVEOPS-36)."""
    from app.core.redis_state import RedisStateStore

    if isinstance(store, RedisStateStore):
        from app.core.cluster import ClusterRunnerManager

        return ClusterRunnerManager.for_store(store, spec_loader=load_mapping_spec)
    return RunnerManager(store)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app.state.store = make_store()
    app.state.runner = make_runner(app.state.store)
    if settings.start_runners:
        # Join the cluster first (Redis): even with no active mappings, this
        # process must pick up mappings started elsewhere and take over (LIVEOPS-79).
        await app.state.runner.join()
        with new_session() as s:
            for m in s.scalars(select(Mapping).where(Mapping.active.is_(True))):
                src = s.get(Source, m.source_id)
                if src is None:
                    continue
                try:
                    await app.state.runner.adopt(mapping_spec(m, src))
                except SecretsError as e:
                    # One unreadable source must not stop the app (LIVEOPS-41).
                    app.state.runner.mark_error(m.id, src.id, str(e), SECRETS_HINT)
                    log.error("mapping %s not started: %s", m.id, e)
    log.info("Live Ops %s started", __version__)
    yield
    await app.state.runner.stop_all()
    await app.state.store.close()


SECRETS_HINT = "Open the source, enter its password or token again, and save. Then resume the mapping."


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Live Ops", version=__version__, lifespan=lifespan)

    @app.exception_handler(SecretsError)
    async def _secrets_error(_: Request, exc: SecretsError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": {"message": str(exc), "hint": SECRETS_HINT}})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI echoes the submitted value by default; never send passwords back (LIVEOPS-33).
        errors = [{k: v for k, v in e.items() if k not in ("input", "ctx", "url")} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})

    # The portal has no sign-in yet (v0.1, see ADR 0005): only answer for the
    # host names it is meant to be reached by, which also blocks DNS rebinding.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for r in (system.router, sources.router, sites.router, mappings.router, stream.router):
        app.include_router(r)
    for r in (webhooks.router, uploads.router, plans.router):
        app.include_router(r)
    return app


app = create_app()
