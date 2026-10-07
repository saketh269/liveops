"""Two backend processes (two apps) on one Redis and one portal DB, as in a
scaled-out deployment (LIVEOPS-36): a mapping runs in exactly one of them, and
deleting it through the *other* one stops it for good."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.conftest import pg_params, requires_pg
from tests.integration.conftest import SourceDbFactory
from tests.unit.conftest import REDIS_URL, delete_prefix, requires_redis

pytestmark = [requires_pg, requires_redis, pytest.mark.integration]


def _wait(pred: Any, what: str, within: float = 15) -> float:
    started = time.time()
    while not pred():
        assert time.time() - started < within, f"timed out waiting for {what}"
        time.sleep(0.1)
    return time.time() - started


def test_mapping_runs_once_and_delete_reaches_the_owner(
    migrated_portal_db: str, source_db_factory: SourceDbFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings
    from app.main import create_app

    prefix = f"lotest-{uuid.uuid4().hex}"
    monkeypatch.setenv("LIVEOPS_REDIS_URL", REDIS_URL or "")
    monkeypatch.setenv("LIVEOPS_REDIS_KEY_PREFIX", prefix)
    get_settings.cache_clear()
    db, role = source_db_factory(
        [
            "CREATE TABLE beds (bed_id text PRIMARY KEY, status text)",
            "INSERT INTO beds VALUES ('B01','free'), ('B02','free')",
        ]
    )
    p = pg_params()
    try:
        with TestClient(create_app()) as a, TestClient(create_app()) as b:
            src = a.post(
                "/api/sources",
                json={
                    "name": "EHR",
                    "type": "postgres",
                    "settings": {
                        "host": p.get("host", "localhost"),
                        "port": int(p.get("port", 5432)),
                        "database": db,
                        "user": role,
                        "encryption": "off",
                    },
                    "secrets": {"password": "pw"},
                },
            ).json()
            site = a.post("/api/sites", json={"name": "Ward"}).json()
            m = a.post(
                "/api/mappings",
                json={
                    "site_id": site["id"],
                    "source_id": src["id"],
                    "dataset": "public.beds",
                    "config": {"id_field": "bed_id", "fields": {"state": "status"}},
                    "options": {"poll_interval_s": 0.5},
                },
            )
            assert m.status_code == 201, m.text
            mid = m.json()["id"]

            def assets(c: TestClient) -> dict[str, Any]:
                return {x["asset_id"]: x for x in c.get(f"/api/sites/{site['id']}/assets").json()}

            _wait(lambda: len(assets(b)) == 2, "assets visible from process B")
            runners = [c.app.state.runner for c in (a, b)]  # type: ignore[attr-defined]
            # The other process learns about the new mapping and only stands by.
            time.sleep(1.0)
            owners = [i for i, rm in enumerate(runners) if rm.owns(mid)]
            assert len(owners) == 1, owners
            other = (b, a)[owners[0]]

            # Delete through the process that does not run it.
            assert other.delete(f"/api/mappings/{mid}").status_code == 204
            assert not any(rm.owns(mid) for rm in runners)
            assert assets(a) == {} and assets(b) == {}
            with psycopg.connect(**{**p, "dbname": db}, autocommit=True) as c:
                c.execute("UPDATE beds SET status = 'in_use'")
            time.sleep(1.5)  # several poll intervals: nothing comes back
            assert assets(a) == {} and assets(b) == {}
    finally:
        get_settings.cache_clear()
        asyncio.run(delete_prefix(prefix))
