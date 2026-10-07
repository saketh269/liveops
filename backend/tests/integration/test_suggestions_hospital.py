"""Suggested mappings and row filters end to end on the hospital test database
(``tools/hospital-sim/init.sql``), read-only, through the HTTP API.

Needs a Postgres with the ``hospital`` database and its ``liveops_reader``
role. ``LIVEOPS_TEST_HOSPITAL_DSN`` overrides the default
``postgresql://liveops_reader:reader_pw@localhost:5432/hospital``.
"""

from __future__ import annotations

import os
import time
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tests.conftest import requires_pg

pytestmark = [requires_pg, pytest.mark.integration]

HOSPITAL_DSN = os.environ.get(
    "LIVEOPS_TEST_HOSPITAL_DSN", "postgresql://liveops_reader:reader_pw@localhost:5432/hospital"
)


@pytest.fixture
def hospital() -> dict[str, Any]:
    try:
        with psycopg.connect(HOSPITAL_DSN, connect_timeout=3) as c:
            c.execute("SELECT 1 FROM epic.adt_beds LIMIT 1")
    except psycopg.Error as e:
        pytest.skip(f"hospital database not available: {str(e).splitlines()[0]}")
    info = psycopg.conninfo.conninfo_to_dict(HOSPITAL_DSN)
    return {
        "host": info.get("host", "localhost"),
        "port": int(str(info.get("port") or 5432)),
        "database": info["dbname"],
        "user": info["user"],
        "password": info.get("password", ""),
    }


def _query(sql: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(HOSPITAL_DSN, connect_timeout=3) as c:
        return list(c.execute(sql).fetchall())


def test_hospital_suggestions_and_filters(portal_db: str, hospital: dict[str, Any]) -> None:
    from app.main import create_app

    password = hospital.pop("password")
    with TestClient(create_app()) as client:
        src = client.post(
            "/api/sources",
            json={
                "name": "Hospital",
                "type": "postgres",
                "settings": {**hospital, "encryption": "off", "schemas": ["epic", "evs", "gps", "kronos"]},
                "secrets": {"password": password},
            },
        )
        assert src.status_code == 201, src.text
        sid = src.json()["id"]
        site = client.post("/api/sites", json={"name": "Ward 2", "template": "hospital"}).json()

        assert client.get(f"/api/sources/{sid}/suggestions", params={"site_id": "nope"}).status_code == 404
        started = time.monotonic()
        r = client.get(f"/api/sources/{sid}/suggestions", params={"site_id": site["id"]})
        assert r.status_code == 200, r.text
        assert time.monotonic() - started < 25  # within the sampling budget
        got = {s["dataset"]: s for s in r.json()}

        # Things on the map.
        beds, staff, amb = got["epic.adt_beds"], got["kronos.roster"], got["gps.ambulances"]
        assert beds["config"]["kind"] == "bed" and beds["config"]["id_field"] == "bed_id"
        assert beds["config"]["fields"]["zone"] == "unit" and beds["config"]["fields"]["state"] == "status"
        assert beds["config"]["state_map"].get("occupied") == "in_use"
        assert staff["config"]["kind"] == "staff" and staff["config"]["fields"]["label"] == "name"
        assert staff["config"]["fields"]["role"] == "role"
        assert staff["filter"] == [{"column": "on_shift", "op": "eq", "value": True}]
        assert amb["config"]["kind"] == "ambulance" and amb["config"]["fields"]["zone"] == "dest_unit"
        for s in (beds, staff, amb):
            assert s["attach_to"] is None and s["confidence"] >= 0.7

        # Details attached to the beds through bed_id, with current-row filters.
        for name in ("evs.tasks", "kronos.rounds", "epic.encounters"):
            s = got[name]
            assert s["attach_to"] == {"dataset": "epic.adt_beds", "mapping_id": None, "match_key": "bed_id"}, name
            assert s["config"]["match_key"] == "bed_id"
        assert got["evs.tasks"]["filter"] == [{"column": "done_at", "op": "is_null", "value": None}]
        assert got["epic.encounters"]["filter"] == [{"column": "discharged_at", "op": "is_null", "value": None}]

        # Counts, not things.
        assert got["epic.triage_queue"]["config"] is None and "counts" in got["epic.triage_queue"]["reason"]
        assert got["epic.unit_census"]["config"] is None

        # Create every suggestion, as the UI does, and check what reaches the map.
        created: dict[str, str] = {}
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
                    "options": {"poll_interval_s": 1},
                },
            )
            assert m.status_code == 201, (s["dataset"], m.text)
            created[s["dataset"]] = m.json()["id"]

        open_visits = dict(_query("SELECT bed_id, patient_ref FROM epic.encounters WHERE discharged_at IS NULL"))
        open_tasks = {b for (b,) in _query("SELECT bed_id FROM evs.tasks WHERE done_at IS NULL")}
        all_beds = {b for (b,) in _query("SELECT bed_id FROM epic.adt_beds")}
        on_shift = {s for (s,) in _query("SELECT staff_id FROM kronos.roster WHERE on_shift")}
        off_shift = {s for (s,) in _query("SELECT staff_id FROM kronos.roster WHERE NOT on_shift")}

        def assets() -> dict[str, dict[str, Any]]:
            return {a["asset_id"]: a for a in client.get(f"/api/sites/{site['id']}/assets").json()}

        deadline = time.time() + 15
        seen: dict[str, dict[str, Any]] = {}
        while time.time() < deadline:
            seen = assets()
            bed_ok = all_beds <= {k for k, a in seen.items() if a.get("kind") == "bed"}
            staff_ok = on_shift <= set(seen)
            visits_ok = all(
                seen.get(b, {}).get("attributes", {}).get("patient_ref") == p for b, p in open_visits.items()
            )
            if bed_ok and staff_ok and visits_ok:
                break
            time.sleep(0.3)
        for b in all_beds:
            attrs = seen[b].get("attributes") or {}
            # The filter keeps discharged visits and finished tasks off the beds.
            assert attrs.get("patient_ref") == open_visits.get(b), b
            assert ("status" in attrs) == (b in open_tasks), b
        assert not off_shift & set(seen)

        # Now mapped: suggested again as "already mapped", and new details attach to the existing mapping.
        again = {
            s["dataset"]: s
            for s in client.get(f"/api/sources/{sid}/suggestions", params={"site_id": site["id"]}).json()
        }
        assert again["epic.adt_beds"]["config"] is None and "Already mapped" in again["epic.adt_beds"]["reason"]

        # Filters are validated against the table.
        bad = client.post(
            "/api/mappings",
            json={
                "site_id": site["id"],
                "source_id": sid,
                "dataset": "evs.tasks",
                "config": {"id_field": "task_id", "filter": [{"column": "finished", "op": "is_null"}]},
                "active": False,
            },
        )
        assert bad.status_code == 422 and "Filter column 'finished'" in bad.text
        bad_type = client.post(
            "/api/mappings",
            json={
                "site_id": site["id"],
                "source_id": sid,
                "dataset": "evs.tasks",
                "config": {"id_field": "task_id", "filter": [{"column": "done_at", "op": "gt", "value": "soon"}]},
                "active": False,
            },
        )
        assert bad_type.status_code == 422 and "isn't a date" in bad_type.text
        bad_op = client.post(
            "/api/mappings",
            json={
                "site_id": site["id"],
                "source_id": sid,
                "dataset": "evs.tasks",
                "config": {"id_field": "task_id", "filter": [{"column": "status", "op": "in", "value": []}]},
                "active": False,
            },
        )
        assert bad_op.status_code == 422 and "needs a list" in bad_op.text

        for mid in created.values():
            assert client.delete(f"/api/mappings/{mid}").status_code == 204
