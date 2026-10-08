"""The common event format. Every source, whatever its type, ends up here."""

from __future__ import annotations

import time
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class AssetOp(StrEnum):
    UPSERT = "upsert"
    REMOVE = "remove"


class AssetEvent(BaseModel):
    """One asset changed, produced by applying a Mapping to a Change.

    ``fields`` holds the mapped values this source contributes. The state
    store merges events from several sources that share ``site_id`` and
    ``asset_id`` into one ``Asset``.
    """

    site_id: str
    asset_id: str
    op: AssetOp = AssetOp.UPSERT
    source_id: str
    mapping_id: str
    dataset: str
    fields: dict[str, Any] = Field(default_factory=dict)  # zone, state, label, kind, attributes...
    # True when the mapping adds details to another mapping's asset (its match_key
    # differs from its id_field: a transport on a patient, a cleaning task on a bed).
    # The asset's own mapping then wins every field both send (LIVEOPS-116).
    attached: bool = False
    source_ts: float | None = None
    received_ts: float = Field(default_factory=time.time)


class FieldValue(BaseModel):
    value: Any
    source_id: str
    mapping_id: str
    updated_ts: float


class AttachedRecord(BaseModel):
    """Everything one attached mapping says about an asset, kept apart from the
    merged fields (LIVEOPS-116): a transport's own ``attributes.status`` stays
    readable here even where the patient's own status wins the merged field."""

    source_id: str
    fields: dict[str, Any] = Field(default_factory=dict)  # field name as the store keeps it -> value


class Asset(BaseModel):
    """Current merged state of one asset on one site."""

    site_id: str
    asset_id: str
    fields: dict[str, FieldValue] = Field(default_factory=dict)
    updated_ts: float = 0.0
    attached: dict[str, AttachedRecord] = Field(default_factory=dict)  # attached mapping id -> its values

    def flat(self) -> dict[str, Any]:
        """Plain view sent to the browser: values plus where each came from, and
        (only when there are any) ``_attached``: each attached mapping's own values."""
        flat: dict[str, Any] = {
            "site_id": self.site_id,
            "asset_id": self.asset_id,
            "updated_ts": self.updated_ts,
            **{k: v.value for k, v in self.fields.items()},
            "_sources": {k: v.source_id for k, v in self.fields.items()},
        }
        if self.attached:
            flat[ATTACHED] = {m: (r.source_id, r.fields) for m, r in self.attached.items()}
        return fold_view(flat)


# ``attributes`` merge per key across sources (LIVEOPS-44): the store keeps
# each key as its own field ``attributes.<key>`` with its own source, and the
# browser view folds them back into one ``attributes`` object.
ATTRIBUTES = "attributes"
ATTR_PREFIX = "attributes."


def expand_attributes(fields: dict[str, Any]) -> dict[str, Any]:
    """Event fields as the store merges them: a dict ``attributes`` becomes one
    field per key. Anything else is kept as is."""
    if not isinstance(fields.get(ATTRIBUTES), dict):
        return fields
    out = {k: v for k, v in fields.items() if k != ATTRIBUTES}
    for k, v in fields[ATTRIBUTES].items():
        out[ATTR_PREFIX + str(k)] = v
    return out


# Browser view of the attached mappings' own values:
#   "_attached": {"<mapping id>": {"source_id": "<source id>", "attributes": {"status": "in_progress", ...}}}
ATTACHED = "_attached"


def fold_attached(source_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    """One attached mapping's values as the browser sees them (``attributes.<key>`` folded)."""
    out: dict[str, Any] = {k: v for k, v in fields.items() if not k.startswith(ATTR_PREFIX)}
    attrs = {k[len(ATTR_PREFIX) :]: v for k, v in fields.items() if k.startswith(ATTR_PREFIX)}
    if attrs:
        out[ATTRIBUTES] = attrs
    out["source_id"] = source_id
    return out


def fold_view(flat: dict[str, Any]) -> dict[str, Any]:
    """``fold_attributes`` plus ``_attached`` given as ``{mapping: (source_id, fields)}``."""
    groups = flat.get(ATTACHED)
    if isinstance(groups, dict):
        flat[ATTACHED] = {m: fold_attached(str(src), dict(fields)) for m, (src, fields) in groups.items()}
    return fold_attributes(flat)


def fold_attributes(flat: dict[str, Any]) -> dict[str, Any]:
    """Fold ``attributes.<key>`` entries of a flat asset into ``attributes``.

    ``_sources`` keeps ``attributes.<key>`` per key, plus ``attributes`` when
    every key comes from the same source."""
    keys = [k for k in flat if k.startswith(ATTR_PREFIX)]
    if not keys:
        return flat
    base = flat.get(ATTRIBUTES)
    attrs: dict[str, Any] = dict(base) if isinstance(base, dict) else {}
    for k in keys:
        attrs[k[len(ATTR_PREFIX) :]] = flat.pop(k)
    flat[ATTRIBUTES] = attrs
    sources = flat.setdefault("_sources", {})
    key_sources = {sources[k] for k in keys if k in sources}
    if ATTRIBUTES not in sources and len(key_sources) == 1:
        sources[ATTRIBUTES] = key_sources.pop()
    return flat


class StreamMessage(BaseModel):
    """What the WebSocket sends. ``snapshot`` first, then ``upsert``/``remove``."""

    type: str  # "snapshot" | "upsert" | "remove" | "event"
    site_id: str
    assets: list[dict[str, Any]] = Field(default_factory=list)
    event: dict[str, Any] | None = None  # human-readable feed entry
    ts: float = Field(default_factory=time.time)
