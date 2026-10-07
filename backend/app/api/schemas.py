"""Request/response models for the HTTP API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.core.mapping import MappingConfig


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


class MappingUpdate(BaseModel):
    dataset: str | None = None
    config: MappingConfig | None = None
    options: dict[str, Any] | None = None
    active: bool | None = None


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
