"""Importing this package registers every built-in connector."""

from app.connectors import (  # noqa: F401  (each module registers itself; drivers load lazily where noted)
    files,
    mysql,
    oracle,
    postgres,
    postgres_cdc,
    rest,
    sqlserver,
    webhook,
)
from app.connectors.registry import build, get_class, specs

__all__ = ["build", "get_class", "specs"]
