from __future__ import annotations

from fastapi import Request

from app import secrets as secrets_mod
from app.core.mapping import MappingConfig
from app.core.runner import MappingSpec, RunnerManager
from app.core.state import StateStore
from app.db import Mapping, Source


def runner(request: Request) -> RunnerManager:
    return request.app.state.runner


def state_store(request: Request) -> StateStore:
    return request.app.state.store


def mapping_spec(m: Mapping, src: Source) -> MappingSpec:
    return MappingSpec(
        mapping_id=m.id,
        site_id=m.site_id,
        source_id=src.id,
        source_type=src.type,
        settings=src.settings or {},
        secrets=secrets_mod.decrypt(src.secrets_enc),
        dataset=m.dataset,
        config=MappingConfig.model_validate(m.config),
        options=m.options or {},
    )
