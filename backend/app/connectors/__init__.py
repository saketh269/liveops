"""Importing this package registers every built-in connector."""

import app.connectors.postgres_cdc  # noqa: F401  (registers itself)
from app.connectors import postgres  # noqa: F401  (registers itself)
from app.connectors.registry import build, get_class, specs

__all__ = ["build", "get_class", "specs"]
