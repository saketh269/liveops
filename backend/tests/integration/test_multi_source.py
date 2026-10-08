"""Two source databases, two mappings on one site sharing a match key, through
the HTTP API: the EHR table gives ``state``, the housekeeping table gives
``cleaning``; the WebSocket shows one merged asset with both fields and
correct ``_sources``, then a change in each source arrives with its feed
event. Runs with the in-memory store and with the Redis store."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.conftest import pg_params, requires_pg
from tests.integration.conftest import SourceDbFactory
from tests.unit.conftest import REDIS_URL, delete_prefix, requires_redis

pytestmark = [requires_pg, pytest.mark.integration]


def _source_body(name: str, db: str, role: str) -> dict[str, Any]:
    p = pg_params()
    return {
        "name": name,
        "type": "postgres",
        "settings": {
            "host": p.get("host", "localhost"),
            "port": int(p.get("port", 5432)),
            "database": db,
            "user": role,
            "encryption": "off",
        },
        "secrets": {"password": "pw"},
    }


class Stream:
    """Reads the WebSocket and keeps the merged picture plus feed texts."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.assets: dict[str, dict[str, Any]] = {}
        self.feed: list[dict[str, Any]] = []

    def wait_for(self, pred: Any, what: str, timeout: float = 15) -> float:
        started = time.time()
        while not pred(self):
            assert time.time() - started < timeout, f"timed out waiting for {what}; have {self.assets} {self.feed}"
            msg = json.loads(self.ws.receive_text())
            if msg["type"] in ("snapshot", "upsert"):
                if msg["type"] == "snapshot":
                    self.assets.clear()
                for a in msg["assets"]:
                    self.assets[a["asset_id"]] = a
            elif msg["type"] == "remove":
                for a in msg["assets"]:
                    self.assets.pop(a["asset_id"], None)
            elif msg["type"] == "event":
                self.feed.append(msg["event"])
        return time.time() - started


@pytest.mark.parametrize("store_kind", ["memory", pytest.param("redis", marks=requires_redis)])
async def test_two_sources_merge_into_one_asset(
    store_kind: str,
    migrated_portal_db: str,
    source_db_factory: SourceDbFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import get_settings
    from app.main import create_app

    prefix = f"lotest-{uuid.uuid4().hex}"
    if store_kind == "redis":
        monkeypatch.setenv("LIVEOPS_REDIS_URL", REDIS_URL or "")
        monkeypatch.setenv("LIVEOPS_REDIS_KEY_PREFIX", prefix)
    else:
        monkeypatch.delenv("LIVEOPS_REDIS_URL", raising=False)
    get_settings.cache_clear()

    ehr_db, ehr_role = source_db_factory(
        [
            "CREATE TABLE beds (bed_id text PRIMARY KEY, unit text, status text, patient_count int)",
            "INSERT INTO beds VALUES ('B01','ICU','free',0), ('B02','ER','occupied',1)",
        ]
    )
    hk_db, hk_role = source_db_factory(
        [
            "CREATE TABLE cleaning (bed_id text PRIMARY KEY, cleaning_status text, cleaner text)",
            "INSERT INTO cleaning VALUES ('B01','due','C0')",
        ]
    )
    p = pg_params()
    try:
        with TestClient(create_app()) as client:
            from app.core.redis_state import RedisStateStore
            from app.core.state import InMemoryStateStore

            expected = RedisStateStore if store_kind == "redis" else InMemoryStateStore
            assert isinstance(client.app.state.store, expected)  # type: ignore[attr-defined]

            ehr = client.post("/api/sources", json=_source_body("EHR", ehr_db, ehr_role))
            hk = client.post("/api/sources", json=_source_body("Housekeeping", hk_db, hk_role))
            assert ehr.status_code == 201 and hk.status_code == 201, (ehr.text, hk.text)
            ehr_id, hk_id = ehr.json()["id"], hk.json()["id"]
            site = client.post("/api/sites", json={"name": "Ward 3", "template": "hospital"}).json()

            with client.websocket_connect(f"/ws/sites/{site['id']}") as ws:
                s = Stream(ws)
                s.wait_for(lambda s: True, "snapshot")
                for body in (
                    {
                        "source_id": ehr_id,
                        "dataset": "public.beds",
                        "config": {
                            "id_field": "bed_id",
                            "match_key": "bed_id",
                            "fields": {"zone": "unit", "state": "status"},
                            "attributes": ["patient_count"],
                            "state_map": {"occupied": "in_use"},
                            "kind": "bed",
                        },
                    },
                    {
                        "source_id": hk_id,
                        "dataset": "public.cleaning",
                        "config": {
                            "id_field": "bed_id",
                            "match_key": "bed_id",
                            "fields": {"cleaning": "cleaning_status"},
                            "attributes": ["cleaner"],
                        },
                    },
                ):
                    r = client.post(
                        "/api/mappings", json={**body, "site_id": site["id"], "options": {"poll_interval_s": 0.5}}
                    )
                    assert r.status_code == 201, r.text

                s.wait_for(
                    lambda s: "cleaning" in s.assets.get("B01", {}) and "state" in s.assets.get("B01", {}),
                    "merged B01",
                )
                b01 = s.assets["B01"]
                assert b01["state"] == "free" and b01["zone"] == "ICU" and b01["cleaning"] == "due"
                assert b01["_sources"] == {
                    "state": ehr_id,
                    "zone": ehr_id,
                    "kind": ehr_id,
                    "cleaning": hk_id,
                    "attributes.patient_count": ehr_id,
                    "attributes.cleaner": hk_id,
                }
                # LIVEOPS-44: both sources' attributes survive, whichever polled last.
                assert b01["attributes"] == {"patient_count": 0, "cleaner": "C0"}
                s.wait_for(lambda s: "B02" in s.assets, "B02")
                assert "cleaning" not in s.assets["B02"] and s.assets["B02"]["state"] == "in_use"

                with psycopg.connect(**{**p, "dbname": ehr_db}, autocommit=True) as c:
                    c.execute("UPDATE beds SET status = 'occupied' WHERE bed_id = 'B01'")
                lat_ehr = s.wait_for(
                    lambda s: any(e["text"] == "B01 is in use (was free)" for e in s.feed), "EHR change + feed event"
                )
                assert s.assets["B01"]["state"] == "in_use" and s.assets["B01"]["cleaning"] == "due"
                assert next(e for e in s.feed if e["text"] == "B01 is in use (was free)")["source_id"] == ehr_id

                with psycopg.connect(**{**p, "dbname": hk_db}, autocommit=True) as c:
                    c.execute("UPDATE cleaning SET cleaning_status = 'done' WHERE bed_id = 'B01'")
                lat_hk = s.wait_for(
                    lambda s: any(e["text"] == "B01 cleaning is now done" for e in s.feed), "housekeeping change"
                )
                assert s.assets["B01"]["cleaning"] == "done" and s.assets["B01"]["state"] == "in_use"
                assert s.assets["B01"]["_sources"]["cleaning"] == hk_id
                print(f"[{store_kind}] source change -> WebSocket: EHR {lat_ehr:.2f}s, housekeeping {lat_hk:.2f}s")
                assert lat_ehr < 10 and lat_hk < 10

            events = client.get(f"/api/sites/{site['id']}/events", params={"limit": 1000}).json()
            texts = [e["text"] for e in events]
            assert "B01 is in use (was free)" in texts and "B01 cleaning is now done" in texts
            assets = {a["asset_id"]: a for a in client.get(f"/api/sites/{site['id']}/assets").json()}
            assert assets["B01"]["cleaning"] == "done" and assets["B01"]["state"] == "in_use"

            # Pausing housekeeping drops only its fields.
            hk_mapping = next(
                m for m in client.get("/api/mappings", params={"site_id": site["id"]}).json() if m["source_id"] == hk_id
            )
            assert client.put(f"/api/mappings/{hk_mapping['id']}", json={"active": False}).status_code == 200
            assets = {a["asset_id"]: a for a in client.get(f"/api/sites/{site['id']}/assets").json()}
            assert "cleaning" not in assets["B01"] and assets["B01"]["state"] == "in_use"
    finally:
        get_settings.cache_clear()
        if store_kind == "redis":
            await delete_prefix(prefix)
