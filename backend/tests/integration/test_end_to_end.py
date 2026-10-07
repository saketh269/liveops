"""Full flow through the HTTP API, a real portal DB and a real source DB:
add source -> test -> list tables -> create site -> map -> row change reaches
the WebSocket. This is the user's real journey in the UI."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.conftest import pg_params, requires_pg

pytestmark = [requires_pg, pytest.mark.integration]


@pytest.fixture
def portal_db(temp_database: str) -> Iterator[str]:
    from alembic import command
    from alembic.config import Config

    p = pg_params()
    host, port = p.get("host", "localhost"), p.get("port", 5432)
    url = f"postgresql+psycopg://{p['user']}:{p.get('password', '')}@{host}:{port}/{temp_database}"
    os.environ["LIVEOPS_DATABASE_URL"] = url
    from app.config import get_settings
    from app.db import reset_engine

    get_settings.cache_clear()
    reset_engine()
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "..", "migrations"))
    command.upgrade(cfg, "head")
    yield url
    reset_engine()


@pytest.fixture
def source_db() -> Iterator[tuple[str, str]]:
    if not os.environ.get("LIVEOPS_TEST_PG_DSN"):
        pytest.skip("no pg")
    import uuid

    p = pg_params()
    name = f"lo_src_{uuid.uuid4().hex[:8]}"
    role = f"lo_e2e_{uuid.uuid4().hex[:8]}"  # roles are cluster-wide: keep unique
    admin = os.environ["LIVEOPS_TEST_PG_DSN"]
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    with psycopg.connect(**{**p, "dbname": name}, autocommit=True) as c:
        c.execute(
            "CREATE TABLE beds (bed_id text PRIMARY KEY, unit text, status text, updated_at timestamptz DEFAULT now())"
        )
        c.execute("INSERT INTO beds (bed_id, unit, status) VALUES ('B01','ICU','free'), ('B02','ER','occupied')")
        c.execute(f"CREATE ROLE {role} LOGIN PASSWORD 'pw'")
        c.execute(f'GRANT CONNECT ON DATABASE "{name}" TO {role}')
        c.execute(f"GRANT USAGE ON SCHEMA public TO {role}")
        c.execute(f"GRANT SELECT ON beds TO {role}")
    yield name, role
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", (name,))
        c.execute(f'DROP DATABASE IF EXISTS "{name}"')
        c.execute(f"DROP ROLE IF EXISTS {role}")


def test_user_journey(portal_db: str, source_db: tuple[str, str]) -> None:
    source_db_name, role = source_db
    from app.main import create_app

    p = pg_params()
    with TestClient(create_app()) as client:
        assert client.get("/api/health").json()["ok"] is True
        types = {c["type"] for c in client.get("/api/connectors").json()}
        assert "postgres" in types

        src = client.post(
            "/api/sources",
            json={
                "name": "Hospital DB",
                "type": "postgres",
                "settings": {
                    "host": p.get("host", "localhost"),
                    "port": int(p.get("port", 5432)),
                    "database": source_db_name,
                    "user": role,
                    "encryption": "off",
                },
                "secrets": {"password": "pw"},
            },
        )
        assert src.status_code == 201, src.text
        body = src.json()
        assert "pw" not in src.text and body["secrets_set"] == {"password": True}
        assert body["warnings"], "encryption off must warn"
        sid = body["id"]

        report = client.post(f"/api/sources/{sid}/test").json()
        assert report["ok"], report

        datasets = client.get(f"/api/sources/{sid}/datasets").json()
        assert "public.beds" in {d["name"] for d in datasets}
        preview = client.get(f"/api/sources/{sid}/preview", params={"dataset": "public.beds"}).json()
        assert isinstance(preview[0]["updated_at"], str)

        # Edit the source (was missing in the old build); password kept when omitted.
        upd = client.put(f"/api/sources/{sid}", json={"name": "Hospital DB (local)"})
        assert upd.status_code == 200 and upd.json()["secrets_set"]["password"] is True

        site = client.post("/api/sites", json={"name": "Ward 2", "template": "hospital"}).json()

        bad = client.post(
            "/api/mappings",
            json={
                "site_id": site["id"],
                "source_id": sid,
                "dataset": "public.beds",
                "config": {"id_field": "nope", "fields": {"state": "status"}},
            },
        )
        assert bad.status_code == 422

        m = client.post(
            "/api/mappings",
            json={
                "site_id": site["id"],
                "source_id": sid,
                "dataset": "public.beds",
                "config": {"id_field": "bed_id", "fields": {"zone": "unit", "state": "status"}, "kind": "bed"},
                "options": {"poll_interval_s": 0.5},
            },
        )
        assert m.status_code == 201, m.text

        with client.websocket_connect(f"/ws/sites/{site['id']}") as ws:
            # Wait until both beds are on the map
            deadline = time.time() + 10
            assets: dict[str, dict] = {}
            while time.time() < deadline and len(assets) < 2:
                msg = json.loads(ws.receive_text())
                for a in msg.get("assets", []):
                    assets[a["asset_id"]] = a
            assert set(assets) == {"B01", "B02"}
            assert assets["B01"]["state"] == "free" and assets["B01"]["zone"] == "ICU"

            changed_at = time.time()
            with psycopg.connect(**{**p, "dbname": source_db_name}, autocommit=True) as c:
                c.execute("UPDATE beds SET status = 'occupied', updated_at = now() WHERE bed_id = 'B01'")
            while True:
                msg = json.loads(ws.receive_text())
                hit = [a for a in msg.get("assets", []) if a["asset_id"] == "B01" and a.get("state") == "occupied"]
                if hit:
                    break
                assert time.time() - changed_at < 10, "change did not reach the map within 10 s"
            latency = time.time() - changed_at
            print(f"row change -> WebSocket: {latency:.2f}s")
            assert latency < 10

        health = client.get("/api/health/mappings").json()
        assert health and health[0]["status"] == "running" and health[0]["events_total"] >= 3
