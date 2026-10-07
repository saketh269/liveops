"""Helpers for tests that go through the real FastAPI app and portal DB."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import FastAPI

from tests.conftest import pg_params


@contextmanager
def portal_app(temp_database: str) -> Iterator[FastAPI]:
    """Migrate ``temp_database`` as the portal DB and build the app on it."""
    from alembic import command
    from alembic.config import Config

    from app.config import get_settings
    from app.db import reset_engine
    from app.main import create_app

    p = pg_params()
    host, port = p.get("host", "localhost"), p.get("port", 5432)
    os.environ["LIVEOPS_DATABASE_URL"] = (
        f"postgresql+psycopg://{p['user']}:{p.get('password', '')}@{host}:{port}/{temp_database}"
    )
    get_settings.cache_clear()
    reset_engine()
    here = os.path.dirname(__file__)
    cfg = Config(os.path.join(here, "..", "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(here, "..", "..", "migrations"))
    command.upgrade(cfg, "head")
    try:
        yield create_app()
    finally:
        reset_engine()
