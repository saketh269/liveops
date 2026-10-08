"""LIVEOPS-116 through the HTTP API: a transport request attached to a patient
(match_key patient_id) never replaces the patient's own status, live or after
a reload (snapshot endpoint and a fresh WebSocket snapshot), and the
transport's own status stays readable under ``_attached``. Runs with the
in-memory store and with the Redis store."""

from __future__ import annotations

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.conftest import pg_params, requires_pg
from tests.integration.conftest import SourceDbFactory
from tests.integration.test_multi_source import Stream, _source_body
from tests.unit.conftest import REDIS_URL, delete_prefix, requires_redis

pytestmark = [requires_pg, pytest.mark.integration]


@pytest.mark.parametrize("store_kind", ["memory", pytest.param("redis", marks=requires_redis)])
async def test_transport_never_replaces_patient_status_after_reload(
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
            "CREATE TABLE patients (patient_id text PRIMARY KEY, current_location text, status text)",
            "INSERT INTO patients VALUES ('P1','ED-02','waiting_for_provider')",
        ]
    )
    tr_db, tr_role = source_db_factory(
        [
            "CREATE TABLE transports (request_id text PRIMARY KEY, patient_id text, status text, dest text)",
        ]
    )
    p = pg_params()
    try:
        with TestClient(create_app()) as client:
            ehr = client.post("/api/sources", json=_source_body("EHR", ehr_db, ehr_role)).json()["id"]
            tr = client.post("/api/sources", json=_source_body("Transport requests", tr_db, tr_role)).json()["id"]
            site = client.post("/api/sites", json={"name": "ED", "template": "hospital"}).json()["id"]
            for body in (
                {
                    "source_id": ehr,
                    "dataset": "public.patients",
                    "config": {
                        "id_field": "patient_id",
                        "fields": {"zone": "current_location", "state": "status"},
                        "state_map": {"waiting_for_provider": "alert", "in_treatment": "in_use"},
                        "attributes": ["status"],
                        "kind": "patient",
                    },
                },
                {
                    "source_id": tr,
                    "dataset": "public.transports",
                    "config": {"id_field": "request_id", "match_key": "patient_id", "attributes": ["status", "dest"]},
                },
            ):
                r = client.post("/api/mappings", json={**body, "site_id": site, "options": {"poll_interval_s": 0.5}})
                assert r.status_code == 201, r.text

            with client.websocket_connect(f"/ws/sites/{site}") as ws:
                s = Stream(ws)
                s.wait_for(lambda s: "state" in s.assets.get("P1", {}), "patient P1")
                # The transport arrives after the patient: newer, but only details.
                with psycopg.connect(**{**p, "dbname": tr_db}, autocommit=True) as c:
                    c.execute("INSERT INTO transports VALUES ('T1','P1','in_progress','Radiology – MRI')")
                s.wait_for(lambda s: "dest" in s.assets.get("P1", {}).get("attributes", {}), "transport on P1")
                live = s.assets["P1"]
                assert live["attributes"]["status"] == "waiting_for_provider" and live["state"] == "alert"
                assert live["_sources"]["attributes.status"] == ehr
                [group] = live["_attached"].values()
                assert group == {"source_id": tr, "attributes": {"status": "in_progress", "dest": "Radiology – MRI"}}

            # Reload: the snapshot endpoint and a new WebSocket snapshot say the same.
            reloaded = {a["asset_id"]: a for a in client.get(f"/api/sites/{site}/assets").json()}["P1"]
            with client.websocket_connect(f"/ws/sites/{site}") as ws:
                s2 = Stream(ws)
                s2.wait_for(lambda s: "P1" in s.assets, "snapshot after reload")
                snap = s2.assets["P1"]
            for view in (reloaded, snap):
                assert view["attributes"]["status"] == "waiting_for_provider", view
                assert view["state"] == "alert" and view["_attached"] == live["_attached"]
                assert {k: v for k, v in view.items() if k != "updated_ts"} == {
                    k: v for k, v in live.items() if k != "updated_ts"
                }
    finally:
        get_settings.cache_clear()
        if store_kind == "redis":
            await delete_prefix(prefix)
