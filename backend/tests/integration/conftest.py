"""Fixtures for multi-source integration tests: a migrated portal DB and a
factory for source databases, each with its own unique read-only role."""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator

import psycopg
import pytest

from tests.conftest import pg_params

SourceDbFactory = Callable[[list[str]], tuple[str, str]]


@pytest.fixture
def migrated_portal_db(temp_database: str) -> Iterator[str]:
    from alembic import command
    from alembic.config import Config

    from app.config import get_settings
    from app.db import reset_engine

    p = pg_params()
    host, port = p.get("host", "localhost"), p.get("port", 5432)
    url = f"postgresql+psycopg://{p['user']}:{p.get('password', '')}@{host}:{port}/{temp_database}"
    old = os.environ.get("LIVEOPS_DATABASE_URL")
    os.environ["LIVEOPS_DATABASE_URL"] = url
    get_settings.cache_clear()
    reset_engine()
    here = os.path.dirname(__file__)
    cfg = Config(os.path.join(here, "..", "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(here, "..", "..", "migrations"))
    command.upgrade(cfg, "head")
    yield url
    reset_engine()
    if old is None:
        os.environ.pop("LIVEOPS_DATABASE_URL", None)
    else:
        os.environ["LIVEOPS_DATABASE_URL"] = old
    get_settings.cache_clear()


@pytest.fixture
def source_db_factory() -> Iterator[SourceDbFactory]:
    """``make(sql_statements) -> (db_name, role)``: a temp DB with the given
    tables, readable by a unique LOGIN role with password 'pw' (SELECT only)."""
    if not os.environ.get("LIVEOPS_TEST_PG_DSN"):
        pytest.skip("LIVEOPS_TEST_PG_DSN not set")
    admin = os.environ["LIVEOPS_TEST_PG_DSN"]
    p = pg_params()
    made: list[tuple[str, str]] = []

    def make(statements: list[str]) -> tuple[str, str]:
        name = f"lo_src_{uuid.uuid4().hex[:10]}"
        role = f"lo_core_{uuid.uuid4().hex[:10]}"  # roles are cluster-wide: keep unique
        with psycopg.connect(admin, autocommit=True) as c:
            c.execute(f'CREATE DATABASE "{name}"')
        made.append((name, role))
        with psycopg.connect(**{**p, "dbname": name}, autocommit=True) as c:
            for stmt in statements:
                c.execute(stmt)
            c.execute(f"CREATE ROLE {role} LOGIN PASSWORD 'pw'")
            c.execute(f'GRANT CONNECT ON DATABASE "{name}" TO {role}')
            c.execute(f"GRANT USAGE ON SCHEMA public TO {role}")
            c.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA public TO {role}")
        return name, role

    yield make
    with psycopg.connect(admin, autocommit=True) as c:
        for name, role in made:
            c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", (name,))
            c.execute(f'DROP DATABASE IF EXISTS "{name}"')
            c.execute(f"DROP ROLE IF EXISTS {role}")
