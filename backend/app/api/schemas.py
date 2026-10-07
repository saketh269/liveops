"""Request/response models for the HTTP API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.connectors.base import MIN_POLL_INTERVAL_S
from app.core.mapping import MappingConfig


def _check_options(v: dict[str, Any] | None) -> dict[str, Any] | None:
    if v and "poll_interval_s" in v:
        try:
            interval = float(v["poll_interval_s"])
        except (TypeError, ValueError):
            raise ValueError("poll_interval_s must be a number of seconds") from None
        if interval < MIN_POLL_INTERVAL_S:
            raise ValueError(f"poll_interval_s must be at least {MIN_POLL_INTERVAL_S} seconds")
    return v


class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str
    settings: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, Any] = Field(default_factory=dict)


class SourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    settings: dict[str, Any] | None = None
    # Only the secret fields present are replaced; omitted ones keep their value.
    secrets: dict[str, Any] | None = None


class SourceOut(BaseModel):
    id: str
    name: str
    type: str
    settings: dict[str, Any]
    secrets_set: dict[str, bool]
    secrets_unreadable: bool = False  # stored secrets can't be decrypted with the current key
    warnings: list[str] = Field(default_factory=list)
    created_ts: float
    updated_ts: float


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    template: str = "generic"
    layout: dict[str, Any] = Field(default_factory=dict)


class SiteUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    template: str | None = None
    layout: dict[str, Any] | None = None


class SiteOut(BaseModel):
    id: str
    name: str
    template: str
    layout: dict[str, Any]
    created_ts: float
    updated_ts: float


class MappingIn(BaseModel):
    site_id: str
    source_id: str
    dataset: str
    config: MappingConfig
    options: dict[str, Any] = Field(default_factory=lambda: {"poll_interval_s": 3})
    active: bool = True

    @field_validator("options")
    @classmethod
    def _valid_options(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return _check_options(v)


class MappingUpdate(BaseModel):
    dataset: str | None = None
    config: MappingConfig | None = None
    options: dict[str, Any] | None = None
    active: bool | None = None

    @field_validator("options")
    @classmethod
    def _valid_options(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return _check_options(v)


class MappingOut(BaseModel):
    id: str
    site_id: str
    source_id: str
    dataset: str
    config: MappingConfig
    options: dict[str, Any]
    active: bool
    running: bool
    created_ts: float
    updated_ts: float
