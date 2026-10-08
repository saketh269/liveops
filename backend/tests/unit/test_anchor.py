"""`anchor` as a first-class mapping field (ADR 0006/0007, LIVEOPS-102)."""

from __future__ import annotations

import pytest

from app.connectors.base import Change, ChangeOp, Column, Dataset, Record
from app.core.events import AssetOp
from app.core.mapping import RESERVED_FIELDS, MappingConfig, anchor_value, apply_mapping, validate_against_columns
from app.core.suggest import suggest

PATIENTS = MappingConfig(
    id_field="patient_id",
    fields={"zone": "current_location", "state": "status", "anchor": "bed_id"},
    kind="patient",
)


def _upsert(rec: dict[str, object]) -> Change:
    return Change(op=ChangeOp.UPSERT, dataset="patients", key=str(rec["patient_id"]), record=rec)


def test_anchor_is_a_reserved_field() -> None:
    assert "anchor" in RESERVED_FIELDS


def test_anchor_maps_to_the_asset_field() -> None:
    ev = apply_mapping(
        _upsert({"patient_id": "P1", "current_location": "3W-301A", "status": "admitted", "bed_id": "3W-301A"}),
        PATIENTS,
        site_id="s",
        source_id="src",
        mapping_id="m",
    )
    assert ev.op == AssetOp.UPSERT
    assert ev.fields["anchor"] == "3W-301A"


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("3W-301A", "3W-301A"),
        ("  B2 ", "B2"),
        (12, "12"),
        (12.0, "12"),  # a numeric bed id read as a float still names asset "12"
        (12.5, "12.5"),
        ("", None),
        ("   ", None),
        (None, None),
        (True, None),
        ("P1", None),  # pointing at itself is no anchor
    ],
)
def test_anchor_value_normalised(raw: object, want: str | None) -> None:
    assert anchor_value(raw, "P1") == want


def test_cleared_anchor_is_sent_as_null() -> None:
    # A discharged patient's bed_id becomes empty: the asset must lose its anchor, not keep the old one.
    ev = apply_mapping(
        _upsert({"patient_id": "P1", "current_location": "Lobby", "status": "x", "bed_id": None}),
        PATIENTS,
        site_id="s",
        source_id="src",
        mapping_id="m",
    )
    assert "anchor" in ev.fields and ev.fields["anchor"] is None


def test_anchor_column_is_validated_like_other_fields() -> None:
    assert validate_against_columns(PATIENTS, {"patient_id", "current_location", "status", "bed_id"}) == []
    problems = validate_against_columns(PATIENTS, {"patient_id", "current_location", "status"})
    assert problems == ["Column 'bed_id' isn't in this table"]


def test_anchor_on_the_id_column_is_rejected() -> None:
    cfg = MappingConfig(id_field="bed_id", fields={"anchor": "bed_id"})
    problems = validate_against_columns(cfg, {"bed_id"})
    assert len(problems) == 1 and "ID column" in problems[0]


def test_suggestions_anchor_people_by_assigned_bed() -> None:
    beds = [f"B{i}" for i in range(1, 7)]
    datasets = [
        Dataset(
            name="beds",
            columns=[Column(name=c, type="text") for c in ("bed_id", "unit", "status")],
            primary_key=["bed_id"],
        ),
        Dataset(
            name="patients",
            columns=[Column(name=c, type="text") for c in ("patient_id", "unit", "status", "assigned_bed")],
            primary_key=["patient_id"],
        ),
    ]
    samples: dict[str, list[Record]] = {
        "beds": [{"bed_id": b, "unit": "4E", "status": "occupied"} for b in beds],
        "patients": [
            {"patient_id": f"P{i}", "unit": "4E", "status": "admitted", "assigned_bed": b} for i, b in enumerate(beds)
        ],
    }
    got = {s.dataset: s for s in suggest(datasets, samples, source_id="src")}
    patients = got["patients"]
    assert patients.config is not None and patients.attach_to is None
    assert patients.config.fields.get("anchor") == "assigned_bed"
    beds_s = got["beds"]
    assert beds_s.config is not None and "anchor" not in beds_s.config.fields
