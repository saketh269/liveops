from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app import __version__
from app.api import mappings, sites, sources, stream, system
from app.api.deps import mapping_spec
from app.config import get_settings
from app.core.runner import RunnerManager
from app.core.state import InMemoryStateStore, StateStore
from app.db import Mapping, Source, new_session

log = logging.getLogger("liveops")


def make_store() -> StateStore:
    # agent-core: return the Redis store when settings.redis_url is set.
    return InMemoryStateStore()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app.state.store = make_store()
    app.state.runner = RunnerManager(app.state.store)
    if settings.start_runners:
        with new_session() as s:
            for m in s.scalars(select(Mapping).where(Mapping.active.is_(True))):
                src = s.get(Source, m.source_id)
                if src is not None:
                    await app.state.runner.start(mapping_spec(m, src))
    log.info("Live Ops %s started", __version__)
    yield
    await app.state.runner.stop_all()


def create_app() -> FastAPI:
    app = FastAPI(title="Live Ops", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for r in (system.router, sources.router, sites.router, mappings.router, stream.router):
        app.include_router(r)
    return app


app = create_app()
