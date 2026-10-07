"""Suggested mappings from discovered columns, keys and small samples (ADR 0006)."""

from __future__ import annotations

from collections.abc import Callable

from app.connectors.base import Column, Dataset, Record
from app.core.suggest import ExistingMapping, Suggestion, guess_kind, preview_priority, propose_state_map, suggest


def ds(name: str, cols: dict[str, str], pk: list[str] | None = None, nullable: set[str] | None = None) -> Dataset:
    return Dataset(
        name=name,
        columns=[Column(name=c, type=t, nullable=c in (nullable or set())) for c, t in cols.items()],
        primary_key=pk or [],
    )


def by_name(items: list[Suggestion]) -> dict[str, Suggestion]:
    return {s.dataset: s for s in items}


# A warehouse that looks nothing like a hospital: the heuristics are generic.
WAREHOUSE = [
    ds("ops.trucks", {"truck_id": "integer", "dock": "text", "state": "text", "driver_name": "text"}, ["truck_id"]),
    ds(
        "ops.forklift_jobs",
        {"job_id": "integer", "truck_id": "integer", "status": "text", "closed_at": "timestamp"},
        ["job_id"],
        nullable={"closed_at"},
    ),
    ds("ops.dock_summary", {"dock": "text", "trucks_waiting": "integer"}, ["dock"]),
    ds("ops.gate_events", {"event_id": "bigint", "plate": "text", "seen_at": "timestamp"}, ["event_id"]),
    ds("ops.pallets", {"pallet_code": "text", "aisle": "text", "weight_kg": "numeric"}),  # a view: no key
    ds("ops.parts", {"sku": "text", "aisle": "text", "qty": "int"}, ["sku", "aisle"]),  # composite key
]
SAMPLES: dict[str, list[Record]] = {
    "ops.trucks": [
        {"truck_id": 1, "dock": "D1", "state": "Docked", "driver_name": "Ana"},
        {"truck_id": 2, "dock": "D2", "state": "en route", "driver_name": "Bo"},
        {"truck_id": 3, "dock": None, "state": "Available", "driver_name": "Cy"},
    ],
    "ops.forklift_jobs": [
        {"job_id": 1, "truck_id": 1, "status": "open", "closed_at": None},
        {"job_id": 2, "truck_id": 2, "status": "done", "closed_at": "2026-10-07T10:00:00Z"},
    ],
    "ops.pallets": [{"pallet_code": "P1", "aisle": "A1"}, {"pallet_code": "P2", "aisle": "A2"}],
}


def test_things_attachments_and_skips_for_any_source() -> None:
    got = by_name(suggest(WAREHOUSE, SAMPLES, source_id="src"))

    trucks = got["ops.trucks"]
    assert trucks.config is not None and trucks.attach_to is None
    assert trucks.config.id_field == "truck_id"
    assert trucks.config.fields == {"zone": "dock", "state": "state", "label": "driver_name"}
    assert trucks.config.kind == "vehicle"
    # Recognised sample values get a color; unknown ones are reported in the reason.
    assert trucks.config.state_map == {"en route": "in_use", "Available": "free"}
    assert "Status value without a color yet: Docked" in trucks.reason
    assert 0 < trucks.confidence <= 0.95

    jobs = got["ops.forklift_jobs"]
    assert jobs.config is not None and jobs.attach_to is not None
    assert jobs.attach_to.dataset == "ops.trucks" and jobs.attach_to.match_key == "truck_id"
    assert jobs.attach_to.mapping_id is None
    assert jobs.config.id_field == "job_id" and jobs.config.match_key == "truck_id"
    assert [f.model_dump() for f in jobs.config.filter] == [{"column": "closed_at", "op": "is_null", "value": None}]
    assert jobs.filter == jobs.config.filter
    assert "Only rows where closed_at is empty" in jobs.reason
    assert "kind" not in jobs.config.fields and jobs.config.kind is None  # never overrides the truck

    pallets = got["ops.pallets"]  # no primary key: a unique *_code column from the sample
    assert pallets.config is not None and pallets.config.id_field == "pallet_code"

    for name in ("ops.dock_summary", "ops.gate_events", "ops.parts"):
        assert got[name].config is None and got[name].confidence == 0
    assert "counts" in got["ops.dock_summary"].reason
    assert "counts" in got["ops.gate_events"].reason
    assert "identifies each record" in got["ops.parts"].reason


def test_order_things_then_attachments_then_skipped() -> None:
    items = suggest(WAREHOUSE, SAMPLES, source_id="src")
    kinds = ["thing" if s.config and not s.attach_to else "attach" if s.config else "skip" for s in items]
    assert kinds == sorted(kinds, key=["thing", "attach", "skip"].index)


def test_existing_mappings_on_the_site() -> None:
    existing = [
        ExistingMapping(mapping_id="m-trucks", source_id="src", dataset="ops.trucks", key_field="truck_id"),
        # Attached mappings are never attach targets themselves.
        ExistingMapping(mapping_id="m-x", source_id="other", dataset="x.notes", key_field="truck_id", attached=True),
    ]
    got = by_name(suggest(WAREHOUSE, SAMPLES, source_id="src", existing=existing))
    assert got["ops.trucks"].config is None and "Already mapped" in got["ops.trucks"].reason
    jobs = got["ops.forklift_jobs"]
    assert jobs.attach_to is not None and jobs.attach_to.mapping_id == "m-trucks"


def test_attach_to_a_mapping_from_another_source() -> None:
    existing = [
        ExistingMapping(mapping_id="m-beds", source_id="ehr", dataset="ehr.beds", key_field="bed_id", kind="bed")
    ]
    housekeeping = [ds("tasks.csv", {"task_id": "integer", "bed_id": "string", "state": "string"}, ["task_id"])]
    samples: dict[str, list[Record]] = {
        "tasks.csv": [{"task_id": 1, "bed_id": "B1", "state": "open"}, {"task_id": 2, "bed_id": "B2", "state": "done"}]
    }
    (s,) = suggest(housekeeping, samples, source_id="files", existing=existing)
    assert s.attach_to is not None and s.attach_to.mapping_id == "m-beds"
    assert s.config is not None
    # A finished status is history: keep only the rows that aren't done.
    assert [f.model_dump() for f in s.config.filter] == [{"column": "state", "op": "ne", "value": "done"}]
    assert "beds" in s.reason


def test_without_samples_still_suggests_from_columns() -> None:
    got = by_name(suggest(WAREHOUSE, {}, source_id="src"))
    trucks = got["ops.trucks"]
    assert trucks.config is not None and trucks.config.state_map == {}
    assert got["ops.pallets"].config is not None  # no sample to check uniqueness: still offered


def test_empty_and_odd_inputs() -> None:
    assert suggest([], {}) == []
    weird = [ds("público.camas", {"id": "integer", "sala": "text"}, ["id"]), ds("t", {}, [])]
    items = suggest(weird, {"t": []})
    assert all(s.config is None for s in items)  # nothing that says where things are


def test_state_map_vocabulary() -> None:
    m, unknown = propose_state_map(["free", "Occupied", "IN-USE", "dirty", "out of service", "idle", "weird", None, ""])
    assert m == {
        "Occupied": "in_use",
        "IN-USE": "in_use",
        "dirty": "cleaning",
        "out of service": "alert",
        "idle": "free",
    }
    assert unknown == ["weird"]


def test_guess_kind() -> None:
    assert guess_kind("epic.adt_beds") == "bed"
    assert guess_kind("kronos.roster") == "staff"
    assert guess_kind("gps.ambulances") == "ambulance"
    assert guess_kind("fleet/vehicles.csv") == "vehicle"
    assert guess_kind("biomed.infusion_pumps") == "equipment"
    assert guess_kind("adt.encounters") == "patient"
    assert guess_kind("misc.things") is None
    assert guess_kind("misc.things", ["nurse_id"]) == "staff"


def test_preview_priority_prefers_likely_tables() -> None:
    order = sorted(WAREHOUSE, key=preview_priority)
    assert order[0].name == "ops.trucks"


def test_clear_state_meanings_only() -> None:
    m, unknown = propose_state_map(
        ["in_bed", "seeing_patient", "rounds", "station", "available", "busy", "waiting", "charting", "arrived"]
    )
    assert m == {
        "in_bed": "in_use",
        "seeing_patient": "in_use",
        "rounds": "in_use",
        "station": "free",
        "available": "free",
        "busy": "in_use",
    }
    assert unknown == ["waiting", "charting", "arrived"]  # unclear: left to the user


# -- The richer hospital shape: people with live locations ------------------------------------------


def _rows(n: int, make: Callable[[int], Record]) -> list[Record]:
    return [make(i) for i in range(n)]


BEDS = [f"B{i:02d}" for i in range(1, 21)]
STAFF = [f"S{i:02d}" for i in range(1, 11)]
PATIENTS = [f"P-{1000 + i}" for i in range(15)]

SIM = [
    ds("epic.adt_beds", {"bed_id": "text", "unit": "text", "status": "text", "room": "text", "in_service": "boolean"},
       ["bed_id"]),
    ds("rtls.locations", {"tag_id": "text", "person_id": "text", "person_type": "text", "role": "text", "name": "text",
                          "unit": "text", "room": "text", "bed_id": "text", "status": "text",
                          "updated_at": "timestamp with time zone"}, ["tag_id"]),
    ds("kronos.roster", {"staff_id": "text", "name": "text", "role": "text", "unit": "text", "on_shift": "boolean"},
       ["staff_id"]),
    ds("epic.encounters", {"encounter_id": "integer", "patient_ref": "text", "bed_id": "text",
                           "discharged_at": "timestamp with time zone", "current_unit": "text", "status": "text"},
       ["encounter_id"], nullable={"discharged_at"}),
    ds("evs.tasks", {"task_id": "integer", "bed_id": "text", "status": "text", "done_at": "timestamp with time zone",
                     "unit": "text", "assigned_to": "text"}, ["task_id"], nullable={"done_at"}),
    ds("kronos.rounds", {"id": "integer", "staff_id": "text", "bed_id": "text", "unit": "text",
                         "ended_at": "timestamp with time zone"}, ["id"], nullable={"ended_at"}),
    ds("epic.triage_queue", {"id": "integer", "status": "text", "patient_ref": "text", "acuity": "smallint"}, ["id"]),
    ds("epic.unit_census", {"unit": "text", "capacity": "integer"}, ["unit"]),
    ds("gps.ambulances", {"unit_id": "text", "status": "text", "dest_unit": "text", "patient_ref": "text"},
       ["unit_id"]),
]  # fmt: skip
DONE = "2026-10-07T10:00:00+00:00"
SIM_SAMPLES: dict[str, list[Record]] = {
    "epic.adt_beds": _rows(20, lambda i: {"bed_id": BEDS[i], "unit": "ER", "status": ["free", "occupied"][i % 2],
                                          "room": f"Room {i}", "in_service": True}),
    "rtls.locations": _rows(10, lambda i: {"tag_id": f"TAG-{STAFF[i]}", "person_id": STAFF[i], "person_type": "staff",
                                           "role": "nurse", "name": f"Nurse {i}", "unit": "ER",
                                           "bed_id": BEDS[i] if i < 3 else None,
                                           "status": ["rounds", "station", "charting"][i % 3]})
    + _rows(15, lambda i: {"tag_id": f"TAG-{PATIENTS[i]}", "person_id": PATIENTS[i], "person_type": "patient",
                           "role": "patient", "name": PATIENTS[i], "unit": "ER",
                           "bed_id": BEDS[i] if i < 10 else None, "status": "in_bed" if i < 10 else "waiting"}),
    "kronos.roster": _rows(14, lambda i: {"staff_id": f"S{i + 1:02d}", "name": f"N{i}", "role": "nurse",
                                          "unit": "ER", "on_shift": i < 10}),
    # Open and closed visits; the closed ones are for patients no longer in the building.
    "epic.encounters": _rows(10, lambda i: {"encounter_id": i, "patient_ref": PATIENTS[i], "bed_id": BEDS[i],
                                            "discharged_at": None, "current_unit": "ER", "status": "in_bed"})
    + _rows(10, lambda i: {"encounter_id": 100 + i, "patient_ref": f"P-9{i:02d}", "bed_id": BEDS[i],
                           "discharged_at": DONE, "current_unit": "ER", "status": "discharged"}),
    "evs.tasks": _rows(6, lambda i: {"task_id": i, "bed_id": BEDS[i], "status": "done", "done_at": DONE, "unit": "ER",
                                     "assigned_to": STAFF[i % 2]}),
    "kronos.rounds": _rows(8, lambda i: {"id": i + 1, "staff_id": STAFF[i % 4], "bed_id": BEDS[i], "unit": "ER",
                                         "ended_at": None if i < 4 else DONE}),
    # ``id`` values 1..8 equal kronos.rounds ids: a generic id must never count as a reference.
    "epic.triage_queue": _rows(8, lambda i: {"id": i + 1, "status": "waiting", "patient_ref": PATIENTS[10 + i % 5],
                                             "acuity": 3}),
    "epic.unit_census": [{"unit": "ER", "capacity": 10}],
    "gps.ambulances": [{"unit_id": "A-1", "status": "inbound", "dest_unit": "ER", "patient_ref": PATIENTS[14]},
                       {"unit_id": "A-2", "status": "idle", "dest_unit": "ER", "patient_ref": None}],
}  # fmt: skip


def test_people_with_live_locations_take_details_from_the_tables_about_them() -> None:
    got = by_name(suggest(SIM, SIM_SAMPLES, source_id="src"))
    people = got["rtls.locations"]
    assert people.config is not None and people.attach_to is None
    # Joined on person_id, which other tables refer to; kind and role come from columns.
    assert people.config.id_field == "person_id"
    assert people.config.kind is None
    assert people.config.fields == {
        "zone": "unit", "kind": "person_type", "state": "status", "label": "name", "role": "role", "anchor": "bed_id",
    }  # fmt: skip
    assert people.config.state_map == {"rounds": "in_use", "station": "free", "in_bed": "in_use"}
    assert "charting, waiting" in people.reason

    beds = got["epic.adt_beds"]
    assert beds.config is not None and beds.config.kind == "bed" and beds.attach_to is None
    amb = got["gps.ambulances"]
    assert amb.config is not None and amb.config.kind == "ambulance" and amb.attach_to is None
    assert "anchor" not in amb.config.fields  # an ambulance is not drawn at a patient

    def attached(name: str) -> tuple[str, str]:
        s = got[name]
        assert s.config is not None and s.attach_to is not None, name
        return s.attach_to.dataset, s.attach_to.match_key

    # The same people as rtls (staff on shift), and visits by patient: details, not second figures.
    assert attached("kronos.roster") == ("rtls.locations", "staff_id")
    assert "drawing them twice" in got["kronos.roster"].reason
    assert attached("epic.encounters") == ("rtls.locations", "patient_ref")
    assert attached("kronos.rounds") == ("rtls.locations", "staff_id")
    # Tasks about beds stay with the beds even though they name a cleaner and have a unit.
    assert attached("evs.tasks") == ("epic.adt_beds", "bed_id")
    filters = {n: [f.model_dump(exclude_none=True) for f in (got[n].filter or [])] for n in got}
    assert filters["kronos.roster"] == [{"column": "on_shift", "op": "eq", "value": True}]
    assert filters["epic.encounters"] == [{"column": "discharged_at", "op": "is_null"}]
    assert filters["evs.tasks"] == [{"column": "done_at", "op": "is_null"}]
    assert filters["kronos.rounds"] == [{"column": "ended_at", "op": "is_null"}]

    for name in ("epic.triage_queue", "epic.unit_census"):
        assert got[name].config is None and "counts" in got[name].reason


def test_without_people_table_visits_and_tasks_attach_to_beds() -> None:
    no_rtls = [d for d in SIM if d.name != "rtls.locations"]
    got = by_name(suggest(no_rtls, SIM_SAMPLES, source_id="src"))
    assert got["epic.encounters"].attach_to is not None
    assert got["epic.encounters"].attach_to.dataset == "epic.adt_beds"
    roster = got["kronos.roster"]
    assert roster.config is not None and roster.attach_to is None and roster.config.kind == "staff"
    assert got["epic.triage_queue"].config is None


def test_a_generic_id_or_unconfirmed_name_is_not_a_reference() -> None:
    things = [
        ds("a.rooms", {"id": "integer", "zone": "text"}, ["id"]),
        ds("a.notes", {"id": "integer", "room_id": "integer", "text": "text"}, ["id"]),
    ]
    samples: dict[str, list[Record]] = {
        "a.rooms": [{"id": i, "zone": "Z"} for i in range(1, 5)],
        # Same ids as the rooms, and room_id values that are not room ids.
        "a.notes": [{"id": i, "room_id": 90 + i, "text": "x"} for i in range(1, 5)],
    }
    got = by_name(suggest(things, samples))
    assert got["a.notes"].config is None
    # With matching values the reference is confirmed.
    samples["a.notes"] = [{"id": i, "room_id": i, "text": "x"} for i in range(1, 5)]
    got = by_name(suggest(things, samples))
    assert got["a.notes"].attach_to is not None and got["a.notes"].attach_to.match_key == "room_id"


def test_kind_from_a_column_of_kinds() -> None:
    fleet = [ds("ops.units", {"unit_id": "text", "unit_type": "text", "depot": "text"}, ["unit_id"])]
    rows: list[Record] = [
        {"unit_id": f"U{i}", "unit_type": ["truck", "van", "forklift"][i % 3], "depot": "D1"} for i in range(6)
    ]
    (s,) = suggest(fleet, {"ops.units": rows})
    assert s.config is not None and s.config.fields["kind"] == "unit_type" and s.config.kind is None
    assert "anchor" not in s.config.fields and "role" not in s.config.fields
