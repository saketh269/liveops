"""Connector registry. Add a connector by decorating its class with ``@register``
and importing its module in ``app/connectors/__init__.py``."""

from __future__ import annotations

from typing import Any

from app.connectors.base import Connector, ConnectorError, ConnectorSpec

_REGISTRY: dict[str, type[Connector]] = {}


def register(cls: type[Connector]) -> type[Connector]:
    t = cls.spec.type
    if t in _REGISTRY and _REGISTRY[t] is not cls:
        raise RuntimeError(f"connector type {t!r} registered twice")
    _REGISTRY[t] = cls
    return cls


def specs() -> list[ConnectorSpec]:
    return [c.spec for c in sorted(_REGISTRY.values(), key=lambda c: c.spec.display_name)]


def get_class(connector_type: str) -> type[Connector]:
    try:
        return _REGISTRY[connector_type]
    except KeyError:
        raise ConnectorError(
            f"Unknown source type {connector_type!r}",
            hint="Pick one of the types listed under Sources → Connect a source.",
        ) from None


def build(connector_type: str, settings: dict[str, Any], secrets: dict[str, Any]) -> Connector:
    return get_class(connector_type)(settings, secrets)
