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
    source_ts: float | None = None
    received_ts: float = Field(default_factory=time.time)


class FieldValue(BaseModel):
    value: Any
    source_id: str
    mapping_id: str
    updated_ts: float


class Asset(BaseModel):
    """Current merged state of one asset on one site."""

    site_id: str
    asset_id: str
    fields: dict[str, FieldValue] = Field(default_factory=dict)
    updated_ts: float = 0.0

    def flat(self) -> dict[str, Any]:
        """Plain view sent to the browser: values plus where each came from."""
        return {
            "site_id": self.site_id,
            "asset_id": self.asset_id,
            "updated_ts": self.updated_ts,
            **{k: v.value for k, v in self.fields.items()},
            "_sources": {k: v.source_id for k, v in self.fields.items()},
        }


class StreamMessage(BaseModel):
    """What the WebSocket sends. ``snapshot`` first, then ``upsert``/``remove``."""

    type: str  # "snapshot" | "upsert" | "remove" | "event"
    site_id: str
    assets: list[dict[str, Any]] = Field(default_factory=list)
    event: dict[str, Any] | None = None  # human-readable feed entry
    ts: float = Field(default_factory=time.time)
