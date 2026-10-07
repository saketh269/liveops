"""Connector SDK: the contract every data source implements.

A connector turns one external system (a database, an API, a file store, a
stream) into a stream of ``Change`` objects for one ``Dataset`` at a time.
Everything downstream (mapping, state store, live map) only ever sees
``Change`` and never knows which system it came from.

Read ``docs/design.md`` before writing a connector. Every connector must pass
the shared contract kit in ``tests/contract/kit.py``.
"""

from __future__ import annotations

import abc
import asyncio
import base64
import datetime as dt
import decimal
import time
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from enum import StrEnum
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

JSONValue = str | int | float | bool | None | list[Any] | dict[str, Any]
Record = dict[str, JSONValue]


# --------------------------------------------------------------------------
# Spec: what a connector is and which settings it takes
# --------------------------------------------------------------------------


class Category(StrEnum):
    DATABASE = "database"
    WAREHOUSE = "warehouse"
    STREAM = "stream"
    API = "api"
    FILE = "file"
    FEDERATION = "federation"


class Mode(StrEnum):
    POLL = "poll"  # we query on an interval and diff snapshots
    CDC = "cdc"  # we read the source's change log
    PUSH = "push"  # the source sends us events (webhook, stream)


class ConnectorSpec(BaseModel):
    """Static description of a connector type, served to the UI.

    ``settings_schema`` is JSON Schema for the non-secret settings; the UI
    renders the form from it. ``secrets_schema`` lists the secret fields
    (passwords, tokens). Secrets are encrypted at rest and never returned by
    the API.
    """

    type: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str
    category: Category
    modes: list[Mode]
    description: str = ""
    settings_schema: dict[str, Any]
    secrets_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    # Mark the beta/untested-against-real-system state honestly in the UI.
    maturity: Literal["stable", "beta", "needs_real_test"] = "beta"


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------


class TestStep(BaseModel):
    name: str
    ok: bool
    detail: str = ""
    hint: str = ""  # how to fix it, in plain words, when ok is False


class TestReport(BaseModel):
    ok: bool
    steps: list[TestStep]
    duration_ms: int = 0

    @classmethod
    def from_steps(cls, steps: list[TestStep], started: float) -> TestReport:
        return cls(
            ok=all(s.ok for s in steps) and bool(steps),
            steps=steps,
            duration_ms=int((time.monotonic() - started) * 1000),
        )


class Column(BaseModel):
    name: str
    type: str  # source type name, informational
    nullable: bool = True


class Dataset(BaseModel):
    """Something a connector can read: a table, a view, an endpoint, a file."""

    name: str  # stable identifier, e.g. "public.beds" or "orders.json"
    columns: list[Column]
    primary_key: list[str] = Field(default_factory=list)
    supports_cdc: bool = False


class ChangeOp(StrEnum):
    UPSERT = "upsert"
    DELETE = "delete"
    # Marker, exactly once per stream() call: "everything before me was the
    # full current state". The runner then removes assets this mapping set
    # earlier that were not in that state (e.g. deleted while we were down).
    # ``key`` is "" and ``record`` is {}. See ADR 0004.
    SNAPSHOT_END = "snapshot_end"


class Change(BaseModel):
    """One row/record changing in one dataset."""

    op: ChangeOp
    dataset: str
    key: str  # stable record key within the dataset
    record: Record  # full record after the change ({} allowed for DELETE)
    source_ts: float | None = None  # when the source says it changed (epoch s)
    received_ts: float = Field(default_factory=time.time)


class Health(BaseModel):
    ok: bool
    detail: str = ""
    latency_ms: int | None = None


# --------------------------------------------------------------------------
# Value normalisation: every record must be JSON-serialisable
# --------------------------------------------------------------------------


def normalize_value(value: Any) -> JSONValue:
    """Convert driver values into JSON-safe values.

    This is where the old build's ``datetime is not JSON serializable`` bug is
    fixed once, for every connector.
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    if isinstance(value, decimal.Decimal):
        if not value.is_finite():
            return None
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, Mapping):
        return {str(k): normalize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [normalize_value(v) for v in value]
    return str(value)


def normalize_record(row: Mapping[str, Any]) -> Record:
    return {str(k): normalize_value(v) for k, v in row.items()}


def record_key(record: Record, key_fields: list[str]) -> str:
    """Build a stable key string from one or more key fields."""
    if not key_fields:
        raise ValueError("dataset has no key fields; choose an ID column in the mapping")
    parts = []
    for f in key_fields:
        if f not in record or record[f] is None:
            raise KeyError(f"record is missing key field {f!r}")
        parts.append(str(record[f]))
    return "|".join(parts)


# --------------------------------------------------------------------------
# The connector contract
# --------------------------------------------------------------------------


class ConnectorError(Exception):
    """A failure the user can act on. ``hint`` explains the fix."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


class Connector(abc.ABC):
    """Base class for every connector.

    Lifecycle: constructed with validated settings and decrypted secrets, used
    for test/discover/preview/stream, then ``close()``-d. Implementations must
    be read-only against the source and must never log secret values.
    """

    spec: ClassVar[ConnectorSpec]

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any], *, source_id: str | None = None) -> None:
        self.settings = settings
        self.secrets = secrets
        # The portal's id for this source (None in tests / before saving). Lets
        # push connectors (webhook) and file connectors find their own data.
        self.source_id = source_id
        # Records dropped because they had no value in the key column(s). The
        # runner shows this count on the Health page instead of failing.
        self.skipped_records = 0
        # The mapping's row filter (ADR 0006), set by the runner. Connectors that
        # key rows themselves (PollingConnector) drop non-matching rows *before*
        # keying, so a current row is never hidden by an old one with the same
        # key (e.g. a closed and an open visit for one bed). The runner applies
        # the filter again to every change, so connectors may ignore it.
        self.row_filter: Callable[[Record], bool] | None = None

    # -- required ---------------------------------------------------------

    @abc.abstractmethod
    async def test(self) -> TestReport:
        """Check connectivity, auth, encryption, permissions. Never raises."""

    @abc.abstractmethod
    async def discover(self) -> list[Dataset]:
        """List datasets this source exposes to the configured credentials."""

    @abc.abstractmethod
    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        """Return up to ``limit`` normalised records for the mapping UI."""

    @abc.abstractmethod
    def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        """Yield changes forever, starting with the current state as UPSERTs.

        The first batch must describe the full current state so a fresh
        subscriber can build the map, followed by exactly one
        ``ChangeOp.SNAPSHOT_END`` marker (use ``snapshot_end(dataset)``), then
        only differences. Records without a key value are skipped and counted
        in ``self.skipped_records``; they must never stop the stream.
        """

    # -- optional ---------------------------------------------------------

    async def health(self) -> Health:
        started = time.monotonic()
        report = await self.test()
        return Health(
            ok=report.ok,
            detail="" if report.ok else next((s.detail for s in report.steps if not s.ok), ""),
            latency_ms=int((time.monotonic() - started) * 1000),
        )

    async def close(self) -> None:  # noqa: B027 - optional hook
        """Release connections."""


class PollingConnector(Connector):
    """Helper for poll-mode connectors: implement ``snapshot`` and get
    ``stream`` (snapshot diffing) for free.

    The poll interval comes from ``options["poll_interval_s"]`` (default 3 s,
    never below ``MIN_POLL_INTERVAL_S``).

    ``snapshot`` must return the *whole* dataset or raise ``ConnectorError``.
    Never return a silently truncated snapshot: missing rows would be read as
    deletes. Use ``check_row_cap()``.
    """

    @abc.abstractmethod
    async def snapshot(self, dataset: str) -> list[Record]:
        """Return all current records of ``dataset`` (normalised)."""

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        return (await self.snapshot(dataset))[:limit]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        interval = max(MIN_POLL_INTERVAL_S, float((options or {}).get("poll_interval_s", 3.0)))
        previous: dict[str, Record] | None = None
        while True:
            rows = await self.snapshot(dataset)
            if self.row_filter is not None:
                keep = self.row_filter
                rows = [r for r in rows if keep(r)]
            current, skipped = key_records(rows, key_fields)
            self.skipped_records = skipped  # per poll: how many rows lack a key right now
            for change in diff_snapshots(dataset, previous, current):
                yield change
            previous = current
            await asyncio.sleep(interval)


MIN_POLL_INTERVAL_S = 0.5
MAX_SNAPSHOT_ROWS = 50_000


def check_row_cap(count: int, dataset: str, cap: int = MAX_SNAPSHOT_ROWS) -> None:
    """Raise when a poll snapshot would be truncated. Fetch ``cap + 1`` rows and
    pass how many came back."""
    if count > cap:
        raise ConnectorError(
            f"{dataset} has more than {cap:,} rows, which is too many to poll",
            hint="Map a view that filters to the rows you need, or use a live-changes (CDC) source type.",
        )


def key_records(rows: list[Record], key_fields: list[str]) -> tuple[dict[str, Record], int]:
    """Key rows by ``key_fields``; rows with a missing/NULL key are skipped and counted."""
    out: dict[str, Record] = {}
    skipped = 0
    for r in rows:
        try:
            out[record_key(r, key_fields)] = r
        except KeyError:
            skipped += 1
    return out, skipped


def snapshot_end(dataset: str) -> Change:
    return Change(op=ChangeOp.SNAPSHOT_END, dataset=dataset, key="", record={})


def diff_snapshots(dataset: str, previous: dict[str, Record] | None, current: dict[str, Record]) -> list[Change]:
    """Compare two keyed snapshots. ``previous=None`` emits everything."""
    out: list[Change] = []
    if previous is None:
        initial = [Change(op=ChangeOp.UPSERT, dataset=dataset, key=k, record=r) for k, r in current.items()]
        return [*initial, snapshot_end(dataset)]
    for k, r in current.items():
        if previous.get(k) != r:
            out.append(Change(op=ChangeOp.UPSERT, dataset=dataset, key=k, record=r))
    for k in previous.keys() - current.keys():
        out.append(Change(op=ChangeOp.DELETE, dataset=dataset, key=k, record={}))
    return out
