"""Suggestions on the simulator's live database (``tools/hospital-sim``), read-only.

The simulator keeps writing while this runs, so the test checks the shape of the
suggestions, not exact rows. Needs the ``hospital_sim`` database;
``LIVEOPS_TEST_HOSPITAL_SIM_DSN`` overrides the default
``postgresql://liveops_reader:reader_pw@localhost:5432/hospital_sim``.
"""

from __future__ import annotations

import os
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.conftest import requires_pg

pytestmark = [requires_pg, pytest.mark.integration]

SIM_DSN = os.environ.get(
    "LIVEOPS_TEST_HOSPITAL_SIM_DSN", "postgresql://liveops_reader:reader_pw@localhost:5432/hospital_sim"
)


@pytest.fixture
def sim() -> dict[str, Any]:
    try:
        with psycopg.connect(SIM_DSN, connect_timeout=3) as c:
            c.execute("SELECT 1 FROM rtls.locations LIMIT 1")
    except psycopg.Error as e:
        pytest.skip(f"hospital_sim database not available: {str(e).splitlines()[0]}")
    info = psycopg.conninfo.conninfo_to_dict(SIM_DSN)
    return {
        "host": info.get("host", "localhost"),
        "port": int(str(info.get("port") or 5432)),
        "database": info["dbname"],
        "user": info["user"],
        "password": info.get("password", ""),
    }


@pytest.mark.parametrize("source_type", ["postgres", "postgres_cdc"])
def test_hospital_sim_suggestions(portal_db: str, sim: dict[str, Any], source_type: str) -> None:
    from app.main import create_app

    password = sim.pop("password")
    settings = {**sim, "encryption": "off", "schemas": ["epic", "evs", "gps", "kronos", "rtls"]}
    if source_type == "postgres_cdc":
        settings["publication"] = "liveops"
    with TestClient(create_app()) as client:
        src = client.post(
            "/api/sources",
            json={"name": "Sim", "type": source_type, "settings": settings, "secrets": {"password": password}},
        )
        assert src.status_code == 201, src.text
        sid = src.json()["id"]
        site = client.post("/api/sites", json={"name": "Sim", "template": "hospital"}).json()
        r = client.get(f"/api/sources/{sid}/suggestions", params={"site_id": site["id"]})
        assert r.status_code == 200, r.text
        got = {s["dataset"]: s for s in r.json()}

        def thing(name: str) -> dict[str, Any]:
            s = got[name]
            assert s["config"] is not None and s["attach_to"] is None, (name, s["reason"])
            return dict(s["config"])

        def attached(name: str) -> str:
            s = got[name]
            assert s["config"] is not None and s["attach_to"] is not None, (name, s["reason"])
            return str(s["attach_to"]["dataset"])

        beds, people, amb = thing("epic.adt_beds"), thing("rtls.locations"), thing("gps.ambulances")
        assert beds["kind"] == "bed" and amb["kind"] == "ambulance"
        assert people["kind"] is None and people["fields"]["kind"] == "person_type"
        assert people["fields"]["zone"] == "unit" and people["fields"]["label"] == "name"
        assert people["fields"]["role"] == "role" and people["fields"]["state"] == "status"
        assert people["fields"].get("anchor") == "bed_id"
        assert people["id_field"] in ("person_id", "tag_id")
        for raw in ("waiting", "charting"):
            assert raw not in people["state_map"]

        assert attached("kronos.roster") == "rtls.locations"
        assert attached("epic.encounters") == "rtls.locations"
        assert attached("evs.tasks") == "epic.adt_beds"
        assert attached("kronos.rounds") in ("rtls.locations", "epic.adt_beds")
        assert got["kronos.roster"]["filter"] == [{"column": "on_shift", "op": "eq", "value": True}]
        assert got["epic.encounters"]["filter"] == [{"column": "discharged_at", "op": "is_null", "value": None}]
        assert got["evs.tasks"]["filter"] == [{"column": "done_at", "op": "is_null", "value": None}]
        for name in ("epic.triage_queue", "epic.unit_census"):
            assert got[name]["config"] is None, got[name]

        # Every suggestion is a valid mapping for its table (created paused: nothing streams).
        for s in r.json():
            if s["config"] is None:
                continue
            m = client.post(
                "/api/mappings",
                json={
                    "site_id": site["id"],
                    "source_id": sid,
                    "dataset": s["dataset"],
                    "config": s["config"],
                    "active": False,
                },
            )
            assert m.status_code == 201, (s["dataset"], m.text)
