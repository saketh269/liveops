"""Portal database: sources, sites, mappings. Not the customer's data."""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from typing import Any

from sqlalchemy import JSON, Boolean, Engine, Float, ForeignKey, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.config import get_settings


def _id() -> str:
    return uuid.uuid4().hex[:12]


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON}


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(50))
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    secrets_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_ts: Mapped[float] = mapped_column(Float, default=time.time)
    updated_ts: Mapped[float] = mapped_column(Float, default=time.time, onupdate=time.time)


class Site(Base):
    __tablename__ = "sites"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(200))
    template: Mapped[str] = mapped_column(String(50), default="generic")  # hospital, warehouse...
    # {"zones": [{"id","name","polygon":[[x,y],...],"color"}], "width": 100, "depth": 60}
    layout: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_ts: Mapped[float] = mapped_column(Float, default=time.time)
    updated_ts: Mapped[float] = mapped_column(Float, default=time.time, onupdate=time.time)


class Mapping(Base):
    __tablename__ = "mappings"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"))
    dataset: Mapped[str] = mapped_column(String(300))
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # MappingConfig
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # poll_interval_s, ...
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_ts: Mapped[float] = mapped_column(Float, default=time.time)
    updated_ts: Mapped[float] = mapped_column(Float, default=time.time, onupdate=time.time)


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def engine() -> Engine:
    global _engine, _SessionLocal
    if _engine is None:
        _engine = create_engine(get_settings().database_url, pool_pre_ping=True)
        _SessionLocal = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def reset_engine() -> None:
    """Tests call this after changing LIVEOPS_DATABASE_URL."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None


def get_session() -> Iterator[Session]:
    engine()
    assert _SessionLocal is not None
    with _SessionLocal() as s:
        yield s


def new_session() -> Session:
    engine()
    assert _SessionLocal is not None
    return _SessionLocal()
