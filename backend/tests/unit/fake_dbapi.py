"""A tiny fake DB-API 2.0 connection for connector unit tests.

``FakeConnection(responder)``: every ``cursor.execute(sql, params, **kw)`` is
recorded in ``conn.executed`` and answered by ``responder(sql, params)``, which
returns ``(column_names, rows)`` or raises. ``rollback()`` and ``close()`` are
recorded too.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

Result = tuple[Sequence[str], Sequence[Sequence[Any]]]
Responder = Callable[[str, Any], Result]


class FakeCursor:
    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn
        self.description: list[tuple[Any, ...]] | None = None
        self._rows: list[tuple[Any, ...]] = []

    def execute(self, sql: str, params: Any = None, **kw: Any) -> None:
        self.conn.executed.append((sql, params, kw))
        cols, rows = self.conn.responder(sql, params)
        self.description = [(c, None, None, None, None, None, None) for c in cols] if cols else None
        self._rows = [tuple(r) for r in rows]

    def fetchall(self) -> list[tuple[Any, ...]]:
        rows, self._rows = self._rows, []
        return rows

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._rows.pop(0) if self._rows else None


class FakeConnection:
    def __init__(self, responder: Responder) -> None:
        self.responder = responder
        self.executed: list[tuple[str, Any, dict[str, Any]]] = []
        self.closed = 0
        self.call_timeout = 0  # set by the Oracle connector

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def rollback(self) -> None:
        self.executed.append(("ROLLBACK", None, {}))

    def close(self) -> None:
        self.closed += 1

    def sql(self) -> list[str]:
        return [s for s, _, _ in self.executed]
