"""Mapping: turns a source record into asset fields.

A mapping config (stored as JSON on the Mapping row) looks like::

    {
      "id_field": "bed_id",            # required: identifies the asset
      "match_key": "bed_id",           # optional: shared key for multi-source merge
                                       #   (defaults to id_field)
      "fields": {                       # asset field -> source column
        "zone": "unit",
        "state": "status",
        "label": "bed_label"
      },
      "state_map": {"occupied": "in_use"},   # optional value translation
      "attributes": ["patient_count"],       # extra columns passed through
      "kind": "bed",                          # optional constant asset kind
      "filter": [{"column": "discharged_at", "op": "is_null"}]
                                              # optional: only rows matching every
                                              #   condition are shown (ADR 0006)
    }

A record that doesn't match the filter is not on the map for this mapping; a
record that stops matching is removed, exactly like a delete.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.connectors.base import Change, ChangeOp
from app.core.events import AssetEvent, AssetOp
from app.core.rowfilter import RowFilter, filter_problems, matches

RESERVED_FIELDS = {"zone", "state", "label", "kind", "x", "y"}


class MappingConfig(BaseModel):
    id_field: str
    match_key: str | None = None
    fields: dict[str, str] = Field(default_factory=dict)
    state_map: dict[str, str] = Field(default_factory=dict)
    attributes: list[str] = Field(default_factory=list)
    kind: str | None = None
    filter: list[RowFilter] = Field(default_factory=list)

    @field_validator("fields")
    @classmethod
    def _no_blank(cls, v: dict[str, str]) -> dict[str, str]:
        return {k: c for k, c in v.items() if c}

    @property
    def key_field(self) -> str:
        return self.match_key or self.id_field

    def required_columns(self) -> set[str]:
        return {self.id_field, self.key_field, *self.fields.values(), *self.attributes}

    def accepts(self, record: dict[str, Any]) -> bool:
        """True when the record passes the row filter (always, without one)."""
        return matches(record, self.filter)


class MappingProblem(ValueError):
    pass


def apply_mapping(
    change: Change,
    config: MappingConfig,
    *,
    site_id: str,
    source_id: str,
    mapping_id: str,
) -> AssetEvent:
    """Map one Change to one AssetEvent. Raises MappingProblem on bad records."""
    if change.op == ChangeOp.DELETE:
        # The key of a change is built from the key field by the runner, so it
        # is the asset id.
        return AssetEvent(
            site_id=site_id,
            asset_id=change.key,
            op=AssetOp.REMOVE,
            source_id=source_id,
            mapping_id=mapping_id,
            dataset=change.dataset,
            source_ts=change.source_ts,
        )
    rec = change.record
    key = rec.get(config.key_field)
    if key is None or key == "":
        raise MappingProblem(f"record has no value in ID column {config.key_field!r}")
    if not config.accepts(rec):
        # Filtered out: this mapping no longer shows the record (ADR 0006).
        return AssetEvent(
            site_id=site_id,
            asset_id=str(key),
            op=AssetOp.REMOVE,
            source_id=source_id,
            mapping_id=mapping_id,
            dataset=change.dataset,
            source_ts=change.source_ts,
        )
    out: dict[str, Any] = {}
    for asset_field, column in config.fields.items():
        if column in rec:
            out[asset_field] = rec[column]
    if "state" in out and out["state"] is not None:
        raw = str(out["state"])
        out["state"] = config.state_map.get(raw, raw)
    if config.kind:
        out["kind"] = config.kind
    if config.attributes:
        out["attributes"] = {a: rec.get(a) for a in config.attributes}
    return AssetEvent(
        site_id=site_id,
        asset_id=str(key),
        op=AssetOp.UPSERT,
        source_id=source_id,
        mapping_id=mapping_id,
        dataset=change.dataset,
        fields=out,
        source_ts=change.source_ts,
    )


def validate_against_columns(config: MappingConfig, columns: set[str] | dict[str, str]) -> list[str]:
    """Return human-readable problems (empty list = fine).

    ``columns`` is the dataset's column names, or ``{name: source type}`` to
    also check that filter values fit the column types."""
    missing = sorted(c for c in config.required_columns() if c not in columns)
    problems = [f"Column {c!r} isn't in this table" for c in missing]
    types = columns if isinstance(columns, dict) else dict.fromkeys(columns, "")
    return problems + filter_problems(config.filter, types)
