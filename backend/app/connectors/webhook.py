"""Webhook connector, push mode.

A system sends us JSON at ``POST /api/webhooks/{source_id}`` (see
``app/api/webhooks.py``). The body is one record or a list of records. A
record with ``"_deleted": true`` removes that key.

Every request must be signed with the source's signing secret:

- ``X-LiveOps-Timestamp``: Unix time in seconds. Must be within 5 minutes of
  our clock (replay protection).
- ``X-LiveOps-Signature``: ``sha256=`` + hex HMAC-SHA256 of
  ``"{timestamp}.{raw body}"`` using the signing secret. The timestamp is part
  of the signed message so it can't be changed by someone replaying a request.

Send a signed event with curl (bash)::

    SECRET='your-signing-secret'; URL='https://liveops.example.com/api/webhooks/<source id>'
    BODY='{"id":"B01","status":"in_use","zone":"ICU"}'
    TS=$(date +%s)
    SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
    curl -sS -X POST "$URL" -H 'Content-Type: application/json' \\
         -H "X-LiveOps-Timestamp: $TS" -H "X-LiveOps-Signature: sha256=$SIG" --data "$BODY"

The same request with ``{"id":"B01","_deleted":true}`` removes B01.

State: the latest record per key is kept in a bounded in-process buffer, so a
mapping that starts after events arrived still gets the current state first.
Each source has its own buffer, keyed by its source id. The buffer and the
replay cache live in the API process (single process for v0.1); a restart
empties them until the sender sends again.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.connectors.base import (
    Category,
    Change,
    ChangeOp,
    Connector,
    ConnectorError,
    ConnectorSpec,
    Dataset,
    Mode,
    Record,
    TestReport,
    TestStep,
    normalize_record,
    snapshot_end,
)
from app.connectors.registry import register
from app.connectors.rest import infer_columns

SIGNATURE_HEADER = "X-LiveOps-Signature"
TIMESTAMP_HEADER = "X-LiveOps-Timestamp"
REPLAY_WINDOW_S = 300
DEFAULT_MAX_BODY_BYTES = 1024 * 1024
HARD_MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_RECORDS_PER_REQUEST = 5_000
DEFAULT_MAX_KEYS = 10_000
HARD_MAX_KEYS = 100_000
SUBSCRIBER_QUEUE = 10_000
MIN_SECRET_LEN = 16
DELETED_FIELD = "_deleted"


# --------------------------------------------------------------------------
# Signatures
# --------------------------------------------------------------------------


def sign(secret: str, timestamp: str, body: bytes) -> str:
    """The value of the signature header for ``body`` sent at ``timestamp``."""
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


class SignatureError(Exception):
    """Why a request was refused. The message is safe to return to the caller."""


SIGNATURE_FORMAT = re.compile(r"sha256=([0-9a-f]{64})", re.ASCII)
TIMESTAMP_FORMAT = re.compile(r"[0-9]{1,12}", re.ASCII)


def verify(secret: str, timestamp: str | None, signature: str | None, body: bytes, now: float | None = None) -> str:
    """Check a request; return the canonical MAC (64 lowercase hex) on success.

    Headers are matched exactly: no trimming, ASCII digits/hex only, so padded
    or re-encoded variants of a captured header are refused rather than
    treated as new requests (LIVEOPS-17).
    """
    if not timestamp or not signature:
        raise SignatureError(
            f"Missing {TIMESTAMP_HEADER} or {SIGNATURE_HEADER} header. Sign each request; see the webhook docs."
        )
    if not TIMESTAMP_FORMAT.fullmatch(timestamp):
        raise SignatureError(f"{TIMESTAMP_HEADER} must be Unix time in whole seconds (digits only).")
    m = SIGNATURE_FORMAT.fullmatch(signature)
    if m is None:
        raise SignatureError(
            f"{SIGNATURE_HEADER} must be exactly 'sha256=' followed by 64 lowercase hex characters, "
            "with no spaces or other characters."
        )
    ts = int(timestamp)
    now = time.time() if now is None else now
    if abs(now - ts) > REPLAY_WINDOW_S:
        raise SignatureError(
            f"{TIMESTAMP_HEADER} is more than {REPLAY_WINDOW_S // 60} minutes from our clock. "
            "Send the current time, and check the sender's clock (NTP)."
        )
    expected = sign(secret, timestamp, body)
    if not hmac.compare_digest(expected, signature):
        raise SignatureError(
            "Signature doesn't match. Sign the exact raw body as HMAC-SHA256 of '<timestamp>.<body>' "
            "with this source's signing secret, sent as 'sha256=<hex>'."
        )
    return m.group(1)


# --------------------------------------------------------------------------
# In-process hub: latest state per key + live subscribers
# --------------------------------------------------------------------------


@dataclass
class _Event:
    record: Record
    deleted: bool
    ts: float


@dataclass
class _Subscriber:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[_Event | None]
    overflowed: bool = False


@dataclass
class _Channel:
    max_keys: int = DEFAULT_MAX_KEYS
    state: OrderedDict[str, Record] = field(default_factory=OrderedDict)
    subscribers: list[_Subscriber] = field(default_factory=list)
    received: int = 0
    last_ts: float | None = None
    seen_signatures: OrderedDict[str, float] = field(default_factory=OrderedDict)


class WebhookHub:
    """Thread-safe: the API may run on another thread/loop than the runner."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._channels: dict[str, _Channel] = {}

    def _chan(self, cid: str, max_keys: int | None = None) -> _Channel:
        ch = self._channels.get(cid)
        if ch is None:
            ch = self._channels[cid] = _Channel()
        if max_keys:
            ch.max_keys = max(1, min(max_keys, HARD_MAX_KEYS))
        return ch

    def check_replay(self, cid: str, signature: str, now: float | None = None) -> bool:
        """True if this request (canonical ``timestamp:mac``) was already accepted within the window."""
        now = time.time() if now is None else now
        with self._lock:
            ch = self._chan(cid)
            while ch.seen_signatures and next(iter(ch.seen_signatures.values())) < now - 2 * REPLAY_WINDOW_S:
                ch.seen_signatures.popitem(last=False)
            if signature in ch.seen_signatures:
                return True
            ch.seen_signatures[signature] = now
            while len(ch.seen_signatures) > 100_000:
                ch.seen_signatures.popitem(last=False)
            return False

    def publish(self, cid: str, key_field: str, records: list[Record], ts: float, max_keys: int | None = None) -> None:
        with self._lock:
            ch = self._chan(cid, max_keys)
            events = []
            for raw in records:
                deleted = raw.get(DELETED_FIELD) is True
                rec = {k: v for k, v in raw.items() if k != DELETED_FIELD}
                key = str(rec[key_field])
                if deleted:
                    ch.state.pop(key, None)
                else:
                    ch.state[key] = rec
                    ch.state.move_to_end(key)
                    while len(ch.state) > ch.max_keys:
                        ch.state.popitem(last=False)
                events.append(_Event(rec, deleted, ts))
            ch.received += len(records)
            ch.last_ts = ts
            for sub in ch.subscribers:
                for ev in events:
                    sub.loop.call_soon_threadsafe(_offer, sub, ev)

    def subscribe(self, cid: str) -> tuple[list[Record], _Subscriber]:
        """Current state and a live queue, taken atomically so nothing is missed."""
        sub = _Subscriber(asyncio.get_running_loop(), asyncio.Queue(maxsize=SUBSCRIBER_QUEUE))
        with self._lock:
            ch = self._chan(cid)
            ch.subscribers.append(sub)
            return list(ch.state.values()), sub

    def unsubscribe(self, cid: str, sub: _Subscriber) -> None:
        with self._lock:
            ch = self._channels.get(cid)
            if ch is not None and sub in ch.subscribers:
                ch.subscribers.remove(sub)

    def current(self, cid: str) -> list[Record]:
        with self._lock:
            ch = self._channels.get(cid)
            return list(ch.state.values()) if ch else []

    def stats(self, cid: str) -> tuple[int, float | None]:
        with self._lock:
            ch = self._channels.get(cid)
            return (ch.received, ch.last_ts) if ch else (0, None)


def _offer(sub: _Subscriber, ev: _Event) -> None:
    if sub.overflowed:
        return
    try:
        sub.queue.put_nowait(ev)
    except asyncio.QueueFull:
        # The consumer fell behind: stop feeding it and let it restart from state.
        sub.overflowed = True
        while not sub.queue.empty():
            sub.queue.get_nowait()
        sub.queue.put_nowait(None)


HUB = WebhookHub()


# --------------------------------------------------------------------------
# Connector
# --------------------------------------------------------------------------


@register
class WebhookConnector(Connector):
    spec = ConnectorSpec(
        type="webhook",
        display_name="Webhook (push)",
        category=Category.API,
        modes=[Mode.PUSH],
        description="Your system POSTs signed JSON records to a Live Ops URL; changes show up immediately.",
        maturity="beta",
        settings_schema={
            "type": "object",
            "required": ["key_field"],
            "properties": {
                "key_field": {
                    "type": "string",
                    "title": "Record ID field",
                    "default": "id",
                    "description": "Field that identifies a record, e.g. bed_id. Every record must have it.",
                },
                "dataset_name": {"type": "string", "title": "Dataset name", "default": "events"},
                "max_body_kb": {
                    "type": "integer",
                    "title": "Max request size (KB)",
                    "default": DEFAULT_MAX_BODY_BYTES // 1024,
                    "minimum": 1,
                    "maximum": HARD_MAX_BODY_BYTES // 1024,
                },
                "max_records": {
                    "type": "integer",
                    "title": "Records kept as current state",
                    "default": DEFAULT_MAX_KEYS,
                    "minimum": 1,
                    "maximum": HARD_MAX_KEYS,
                },
            },
        },
        secrets_schema={
            "type": "object",
            "required": ["signing_secret"],
            "properties": {
                "signing_secret": {
                    "type": "string",
                    "title": "Signing secret",
                    "format": "password",
                    "minLength": MIN_SECRET_LEN,
                    "description": "Shared with the sender; used for HMAC-SHA256 signatures. 16+ characters.",
                }
            },
        },
    )

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any], *, source_id: str | None = None) -> None:
        super().__init__(settings, secrets, source_id=source_id)
        self.hub = HUB

    @property
    def key_field(self) -> str:
        return str(self.settings.get("key_field") or "id")

    @property
    def dataset_name(self) -> str:
        return str(self.settings.get("dataset_name") or "events")

    @property
    def max_body_bytes(self) -> int:
        kb = int(self.settings.get("max_body_kb") or DEFAULT_MAX_BODY_BYTES // 1024)
        return max(1024, min(kb * 1024, HARD_MAX_BODY_BYTES))

    @property
    def max_keys(self) -> int:
        return max(1, min(int(self.settings.get("max_records") or DEFAULT_MAX_KEYS), HARD_MAX_KEYS))

    def _secret(self) -> str:
        s = str(self.secrets.get("signing_secret") or "")
        if len(s) < MIN_SECRET_LEN:
            raise ConnectorError(
                f"The signing secret must be at least {MIN_SECRET_LEN} characters",
                hint="Generate one, e.g. with: openssl rand -hex 32, and give the same value to the sender.",
            )
        return s

    @property
    def channel(self) -> str:
        """The hub buffer for this source: its portal source id (ADR 0004, LIVEOPS-31)."""
        if not self.source_id:
            raise ConnectorError(
                "This webhook source has no id yet", hint="Save the source first; its URL ends with the source id."
            )
        return str(self.source_id)

    # -- used by the API route -------------------------------------------

    def accept(self, body: bytes, timestamp: str | None, signature: str | None) -> int:
        """Verify, parse and publish one request. Raises ``SignatureError``
        (-> 401) or ``ValueError`` (-> 422); returns the number of records."""
        secret = self._secret()
        cid = self.channel
        mac = verify(secret, timestamp, signature, body)
        if self.hub.check_replay(cid, f"{timestamp}:{mac}"):
            raise SignatureError("This exact request was already received. Send a new timestamp and signature.")
        try:
            doc = json.loads(body)
        except ValueError:
            raise ValueError("Body is not valid JSON. Send one JSON object or a list of objects.") from None
        items = doc if isinstance(doc, list) else [doc]
        if not items:
            raise ValueError("Body is an empty list. Send at least one record.")
        if len(items) > MAX_RECORDS_PER_REQUEST:
            raise ValueError(f"Too many records in one request (max {MAX_RECORDS_PER_REQUEST}). Split the batch.")
        records: list[Record] = []
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f'Record {i} is not a JSON object. Send objects like {{"{self.key_field}": ...}}.')
            if item.get(self.key_field) in (None, ""):
                raise ValueError(
                    f"Record {i} has no {self.key_field!r} field. Every record needs it to identify what changed."
                )
            records.append(normalize_record(item))
        self.hub.publish(cid, self.key_field, records, float(int(str(timestamp))), self.max_keys)
        return len(records)

    # -- contract ---------------------------------------------------------

    async def test(self) -> TestReport:
        started = time.monotonic()
        steps: list[TestStep] = []
        try:
            self._secret()
            steps.append(TestStep(name="Signing secret", ok=True, detail="set and long enough"))
        except ConnectorError as e:
            steps.append(TestStep(name="Signing secret", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        try:
            cid = self.channel
            steps.append(TestStep(name="Webhook URL", ok=True, detail=f"POST signed JSON to /api/webhooks/{cid}"))
        except ConnectorError as e:
            steps.append(TestStep(name="Webhook URL", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        received, last = self.hub.stats(cid)
        detail = (
            f"{received} records received, last at {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(last))} UTC"
            if last
            else "nothing received yet since the server started"
        )
        steps.append(TestStep(name="Events received", ok=True, detail=detail))
        return TestReport.from_steps(steps, started)

    async def discover(self) -> list[Dataset]:
        cols = infer_columns(self.hub.current(self.channel))
        if self.key_field not in {c.name for c in cols}:
            cols.insert(0, infer_columns([{self.key_field: ""}])[0])
        return [Dataset(name=self.dataset_name, columns=cols, primary_key=[self.key_field])]

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        self._resolve(dataset)
        return self.hub.current(self.channel)[-limit:]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        self._resolve(dataset)
        cid = self.channel
        state, sub = self.hub.subscribe(cid)
        try:
            for rec in state:
                key = _key(rec, key_fields)
                if key is None:
                    self.skipped_records += 1
                    continue
                yield Change(op=ChangeOp.UPSERT, dataset=dataset, key=key, record=rec)
            yield snapshot_end(dataset)  # exactly once, right after the current state (ADR 0004)
            while True:
                ev = await sub.queue.get()
                if ev is None:
                    raise ConnectorError(
                        "The live map fell behind the webhook sender",
                        hint="It will restart from the current state automatically. If this repeats, "
                        "send fewer events per second.",
                    )
                key = _key(ev.record, key_fields)
                if key is None:
                    self.skipped_records += 1
                    continue
                if ev.deleted:
                    yield Change(op=ChangeOp.DELETE, dataset=dataset, key=key, record={}, source_ts=ev.ts)
                else:
                    yield Change(op=ChangeOp.UPSERT, dataset=dataset, key=key, record=ev.record, source_ts=ev.ts)
        finally:
            self.hub.unsubscribe(cid, sub)

    def _resolve(self, dataset: str) -> None:
        if dataset != self.dataset_name:
            raise ConnectorError(
                f"This webhook source has one dataset, {self.dataset_name!r}, not {dataset!r}",
                hint="Pick the dataset listed for this source.",
            )


def _key(record: Record, key_fields: list[str]) -> str | None:
    parts = []
    for f in key_fields:
        v = record.get(f)
        if v is None:
            return None
        parts.append(str(v))
    return "|".join(parts) if parts else None
