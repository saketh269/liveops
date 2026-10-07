"""Shared fixtures.

Integration and contract tests need a real Postgres. Point
``LIVEOPS_TEST_PG_DSN`` at a superuser connection, e.g.
``postgresql://postgres:postgres@localhost:5432/postgres``. Without it, those
tests are skipped (CI always sets it).
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Iterator

import psycopg
import pytest
from cryptography.fernet import Fernet

os.environ.setdefault("LIVEOPS_SECRET_KEY", Fernet.generate_key().decode())

PG_DSN = os.environ.get("LIVEOPS_TEST_PG_DSN")
requires_pg = pytest.mark.skipif(not PG_DSN, reason="LIVEOPS_TEST_PG_DSN not set")


def pg_params() -> dict[str, str]:
    assert PG_DSN
    info = psycopg.conninfo.conninfo_to_dict(PG_DSN)
    return {k: str(v) for k, v in info.items() if v is not None}


@pytest.fixture
def temp_database() -> Iterator[str]:
    """A fresh empty database; yields its name and drops it afterwards."""
    if not PG_DSN:
        pytest.skip("LIVEOPS_TEST_PG_DSN not set")
    name = f"lo_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(PG_DSN, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    try:
        yield name
    finally:
        with psycopg.connect(PG_DSN, autocommit=True) as c:
            c.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                (name,),
            )
            c.execute(f'DROP DATABASE IF EXISTS "{name}"')


@pytest.fixture
async def anyio_backend() -> AsyncIterator[str]:
    yield "asyncio"
