"""Importing this package registers every built-in connector."""

import app.connectors.mysql  # noqa: F401  (registers itself)
import app.connectors.postgres_cdc  # noqa: F401  (registers itself)
import app.connectors.oracle  # noqa: F401  (registers itself; driver loads lazily)
import app.connectors.sqlserver  # noqa: F401  (registers itself; driver loads lazily)
from app.connectors import postgres  # noqa: F401  (registers itself)
from app.connectors import (  # noqa: F401  (each module registers itself)
    files,
    postgres,
    rest,
    webhook,
)
from app.connectors.registry import build, get_class, specs

__all__ = ["build", "get_class", "specs"]
