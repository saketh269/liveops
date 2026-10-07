"""Suggested mappings from discovered columns, keys and small samples (ADR 0006)."""

from __future__ import annotations

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
    assert "1 status value needs a color" in trucks.reason
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
    assert unknown == 1


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
