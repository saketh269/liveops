"""Webhook connector, push mode.

A system sends us JSON at ``POST /api/webhooks/{source_id}`` (see
``app/api/webhooks.py``). The body is one record or a list of records. A
record with ``"_deleted": true`` removes that key.

Every request must be signed with the source's signing secret:

- ``X-LiveOps-Timestamp``: Unix time in seconds. Must be within 5 minutes of
  our clock (replay protection).
- ``X-LiveOps-Signature``: ``sha256=`` + hex HMAC-SHA256 of
  ``"{source id}.{timestamp}.{raw body}"`` using the signing secret. The source
  id and timestamp are part of the signed message, so a captured request can't
  be replayed with a new timestamp or sent to another source (LIVEOPS-72).
  (Changed in 0.1: earlier builds signed ``"{timestamp}.{raw body}"``.)

Send a signed event with curl (bash)::

    SECRET='your-signing-secret'; SOURCE_ID='<source id>'
    URL="https://liveops.example.com/api/webhooks/$SOURCE_ID"
    BODY='{"id":"B01","status":"in_use","zone":"ICU"}'
    TS=$(date +%s)
    SIG=$(printf '%s.%s.%s' "$SOURCE_ID" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
    curl -sS -X POST "$URL" -H 'Content-Type: application/json' \\
         -H "X-LiveOps-Timestamp: $TS" -H "X-LiveOps-Signature: sha256=$SIG" --data "$BODY"

The same request with ``{"id":"B01","_deleted":true}`` removes B01.
``_deleted`` must be JSON ``true`` or ``false``.

State: the latest record per key is kept (bounded, per source), so a mapping
that starts after events arrived still gets the current state first, also
after a backend restart (LIVEOPS-89):

- with ``LIVEOPS_REDIS_URL``: in Redis. Any backend process can accept a
  webhook; the process running the mapping receives it through a Redis
  stream, and the replay cache is shared.
- without Redis: in this process, written through to
  ``LIVEOPS_DATA_DIR/webhooks/<source id>.jsonl``.

See ``app/connectors/webhook_store.py``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import AsyncIterator
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
from app.connectors.webhook_store import DELETED_FIELD, WebhookStore, get_store

SIGNATURE_HEADER = "X-LiveOps-Signature"
TIMESTAMP_HEADER = "X-LiveOps-Timestamp"
REPLAY_WINDOW_S = 300
DEFAULT_MAX_BODY_BYTES = 1024 * 1024
HARD_MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_RECORDS_PER_REQUEST = 5_000
DEFAULT_MAX_KEYS = 10_000
HARD_MAX_KEYS = 100_000
MIN_SECRET_LEN = 16


# --------------------------------------------------------------------------
# Signatures
# --------------------------------------------------------------------------


def sign(secret: str, timestamp: str, body: bytes, *, source_id: str) -> str:
    """The signature header for ``body`` sent to ``source_id`` at ``timestamp``."""
    msg = source_id.encode() + b"." + timestamp.encode() + b"." + body
    return "sha256=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


class SignatureError(Exception):
    """Why a request was refused. The message is safe to return to the caller."""


SIGNATURE_FORMAT = re.compile(r"sha256=([0-9a-f]{64})", re.ASCII)
TIMESTAMP_FORMAT = re.compile(r"[0-9]{1,12}", re.ASCII)


def verify(
    secret: str,
    timestamp: str | None,
    signature: str | None,
    body: bytes,
    *,
    source_id: str,
    now: float | None = None,
) -> str:
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
    expected = sign(secret, timestamp, body, source_id=source_id)
    if not hmac.compare_digest(expected, signature):
        raise SignatureError(
            "Signature doesn't match. Sign HMAC-SHA256 of '<source id>.<timestamp>.<raw body>' "
            "with this source's signing secret, sent as 'sha256=<hex>'."
        )
    return m.group(1)


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
        description="Your system POSTs signed JSON records to a Live Ops URL; changes show up immediately. "
        "The last record per ID is kept, also across backend restarts, so the map shows the last known state "
        "until the sender sends again.",
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
        self.store: WebhookStore = get_store()

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
        """The webhook buffer for this source: its portal source id (ADR 0004, LIVEOPS-31)."""
        if not self.source_id:
            raise ConnectorError(
                "This webhook source has no id yet", hint="Save the source first; its URL ends with the source id."
            )
        return str(self.source_id)

    # -- used by the API route -------------------------------------------

    async def accept(self, body: bytes, timestamp: str | None, signature: str | None) -> int:
        """Verify, parse and publish one request. Raises ``SignatureError``
        (-> 401) or ``ValueError`` (-> 422); returns the number of records."""
        secret = self._secret()
        cid = self.channel
        mac = verify(secret, timestamp, signature, body, source_id=cid)
        records = self._parse(body)
        if await self.store.seen_before(cid, f"{timestamp}:{mac}"):
            raise SignatureError("This exact request was already received. Send a new timestamp and signature.")
        await self.store.publish(cid, self.key_field, records, float(int(str(timestamp))), self.max_keys)
        return len(records)

    def _parse(self, body: bytes) -> list[Record]:
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
            if DELETED_FIELD in item and not isinstance(item[DELETED_FIELD], bool):
                raise ValueError(
                    f'Record {i}: "{DELETED_FIELD}" must be true or false (JSON booleans, not text or numbers).'
                )
            records.append(normalize_record(item))
        return records

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
        try:
            st = await self.store.stats(cid)
            current = len(await self.store.current(cid))
        except ConnectorError as e:
            steps.append(TestStep(name="Events received", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        last = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(st.last_ts)) + " UTC" if st.last_ts else None
        if st.received:
            detail = f"{st.received} records received, last at {last}; {current} records in the current state"
        elif current:
            detail = (
                f"No new events since the server started; showing {current} records kept from before the restart "
                f"(last event at {last})"
            )
        else:
            detail = "Nothing received yet"
        steps.append(TestStep(name="Events received", ok=True, detail=detail))
        return TestReport.from_steps(steps, started)

    async def discover(self) -> list[Dataset]:
        cols = infer_columns(await self.store.current(self.channel))
        if self.key_field not in {c.name for c in cols}:
            cols.insert(0, infer_columns([{self.key_field: ""}])[0])
        return [Dataset(name=self.dataset_name, columns=cols, primary_key=[self.key_field])]

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        self._resolve(dataset)
        return (await self.store.current(self.channel))[-limit:]

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        self._resolve(dataset)
        cid = self.channel
        state, sub = await self.store.open(cid)
        try:
            for rec in state:
                key = _key(rec, key_fields)
                if key is None:
                    self.skipped_records += 1
                    continue
                yield Change(op=ChangeOp.UPSERT, dataset=dataset, key=key, record=rec)
            yield snapshot_end(dataset)  # exactly once, right after the current state (ADR 0004)
            while True:
                ev = await sub.get()
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
            await sub.close()

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
