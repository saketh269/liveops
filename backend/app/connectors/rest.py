"""REST / JSON HTTP API connector, poll mode.

Polls one JSON endpoint and turns the records it returns into one dataset.

Safety:
- Only ``http``/``https`` URLs are accepted; plain ``http`` needs ``allow_http``
  (local testing only, the API warns). The OAuth2 token URL follows the same rule.
- Redirects are not followed, and "next page" links must stay on the same
  scheme, host and port as the base URL, so a response can't steer us to
  another server.
- Every request has a timeout; every response body is capped in bytes; the
  number of pages is capped; the total number of records is capped.
- Only ``GET`` is issued (read-only). Secrets (API key, bearer token, OAuth2
  client secret) are only sent as auth headers and never appear in errors.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import zlib
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from app.connectors.base import (
    MAX_SNAPSHOT_ROWS,
    Category,
    Column,
    ConnectorError,
    ConnectorSpec,
    Dataset,
    Mode,
    PollingConnector,
    Record,
    TestReport,
    TestStep,
    check_row_cap,
    normalize_record,
)
from app.connectors.netguard import GuardedTransport
from app.connectors.registry import register

MAX_ROWS = MAX_SNAPSHOT_ROWS  # records per snapshot; more raises (never truncates)
DEFAULT_MAX_PAGES = 50
HARD_MAX_PAGES = 1_000
DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
HARD_MAX_RESPONSE_BYTES = 50 * 1024 * 1024
SAMPLE_SIZE = 50  # records used to infer columns
TOKEN_REFRESH_MARGIN_S = 30.0


_STR_SETTINGS = (
    "base_url",
    "path",
    "record_path",
    "dataset_name",
    "api_key_header",
    "token_url",
    "oauth_scope",
    "page_param",
    "page_size_param",
    "cursor_param",
    "cursor_path",
)
_INT_SETTINGS = ("page_size", "start_page", "max_pages")
_NUM_SETTINGS = ("timeout_s", "max_response_mb")
_ENUM_SETTINGS = {
    "method": ("GET",),
    "auth": ("none", "api_key", "bearer", "oauth2_client_credentials"),
    "pagination": ("none", "page_number", "cursor", "link_header"),
}


def select_path(doc: Any, path: str | None) -> Any:
    """Pick a value out of parsed JSON with a simple dotted selector.

    ``""``/``"$"`` is the whole document; ``"data.items"`` walks object keys;
    numeric parts index lists (``"results.0.rows"``); a leading ``"$."`` is
    accepted for JSONPath habits. Returns ``None`` if the path doesn't exist.
    """
    p = (path or "").strip()
    if p.startswith("$"):
        p = p[1:].lstrip(".")
    if not p:
        return doc
    cur = doc
    for part in re.split(r"\.|\[(\d+)\]", p):
        if part is None or part == "":
            continue
        if isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit():
            idx = int(part)
            if idx >= len(cur):
                return None
            cur = cur[idx]
        else:
            return None
    return cur


def infer_columns(records: list[Record]) -> list[Column]:
    """Columns from a sample of records: union of keys, first seen order."""
    names: dict[str, set[str]] = {}
    for r in records[:SAMPLE_SIZE]:
        for k, v in r.items():
            names.setdefault(k, set())
            if v is not None:
                names[k].add(_json_type(v))
    return [Column(name=k, type="/".join(sorted(t)) or "null") for k, t in names.items()]


def _json_type(v: Any) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def primary_key_guess(columns: list[Column]) -> list[str]:
    names = [c.name for c in columns]
    for cand in ("id", "ID", "Id", "uuid", "key"):
        if cand in names:
            return [cand]
    return []


@register
class RestConnector(PollingConnector):
    spec = ConnectorSpec(
        type="rest",
        display_name="REST API (JSON)",
        category=Category.API,
        modes=[Mode.POLL],
        description="Polls a JSON HTTP API endpoint (GET) and diffs the records it returns.",
        maturity="beta",
        settings_schema={
            "type": "object",
            "required": ["base_url"],
            "properties": {
                "base_url": {"type": "string", "title": "Base URL", "examples": ["https://api.example.com"]},
                "path": {"type": "string", "title": "Path", "default": "", "examples": ["/v1/beds"]},
                "method": {"type": "string", "title": "Method", "enum": ["GET"], "default": "GET"},
                "query": {
                    "type": "object",
                    "title": "Query parameters",
                    "additionalProperties": {"type": "string"},
                    "default": {},
                },
                "record_path": {
                    "type": "string",
                    "title": "Where the records are",
                    "description": "Dotted path to the list of records in the response, e.g. data.items. "
                    "Leave empty if the response itself is the list.",
                    "default": "",
                },
                "dataset_name": {
                    "type": "string",
                    "title": "Dataset name",
                    "description": "Name shown in the mapping screen. Defaults to the path.",
                },
                "auth": {
                    "type": "string",
                    "title": "Sign-in method",
                    "enum": ["none", "api_key", "bearer", "oauth2_client_credentials"],
                    "default": "none",
                },
                "api_key_header": {"type": "string", "title": "API key header name", "default": "X-API-Key"},
                "token_url": {"type": "string", "title": "OAuth2 token URL"},
                "oauth_scope": {"type": "string", "title": "OAuth2 scope (optional)"},
                "pagination": {
                    "type": "string",
                    "title": "Pagination",
                    "enum": ["none", "page_number", "cursor", "link_header"],
                    "default": "none",
                },
                "page_param": {"type": "string", "title": "Page number parameter", "default": "page"},
                "page_size_param": {"type": "string", "title": "Page size parameter", "default": "per_page"},
                "page_size": {"type": "integer", "title": "Page size", "default": 100, "minimum": 1},
                "start_page": {"type": "integer", "title": "First page number", "default": 1},
                "cursor_param": {"type": "string", "title": "Cursor parameter", "default": "cursor"},
                "cursor_path": {
                    "type": "string",
                    "title": "Where the next cursor is",
                    "description": "Dotted path in the response, e.g. meta.next_cursor.",
                    "default": "next_cursor",
                },
                "max_pages": {
                    "type": "integer",
                    "title": "Max pages per poll",
                    "default": DEFAULT_MAX_PAGES,
                    "minimum": 1,
                    "maximum": HARD_MAX_PAGES,
                },
                "timeout_s": {"type": "number", "title": "Timeout (seconds)", "default": 15, "minimum": 1},
                "max_response_mb": {"type": "number", "title": "Max response size (MB)", "default": 10},
                "allow_http": {
                    "type": "boolean",
                    "title": "Allow plain HTTP",
                    "default": False,
                    "description": "Only for local testing. Company APIs should use HTTPS.",
                },
                "allow_private_network": {
                    "type": "boolean",
                    "title": "Allow private network addresses",
                    "default": False,
                    "description": "Needed for APIs inside your company network (10.x, 192.168.x, localhost). "
                    "Cloud metadata and link-local addresses are always blocked.",
                },
            },
        },
        secrets_schema={
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "title": "API key", "format": "password"},
                "bearer_token": {"type": "string", "title": "Bearer token", "format": "password"},
                "client_id": {"type": "string", "title": "OAuth2 client ID"},
                "client_secret": {"type": "string", "title": "OAuth2 client secret", "format": "password"},
            },
        },
    )

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any], *, source_id: str | None = None) -> None:
        super().__init__(settings, secrets, source_id=source_id)
        self._client: httpx.AsyncClient | None = None
        self._token: str | None = None
        self._token_expires = 0.0

    # -- settings helpers ------------------------------------------------

    @property
    def dataset_name(self) -> str:
        name = (self.settings.get("dataset_name") or "").strip()
        if name:
            return name
        path = (self.settings.get("path") or "").strip("/")
        return path or "records"

    def _url(self) -> str:
        base = str(self.settings.get("base_url", "")).strip()
        path = str(self.settings.get("path") or "")
        if not path:
            return base
        _check_relative_path(path)
        url = urljoin(base.rstrip("/") + "/", path.lstrip("/"))
        a, b = urlsplit(base), urlsplit(url)
        if (a.scheme, a.hostname, a.port) != (b.scheme, b.hostname, b.port):
            raise _absolute_path_error()
        return url

    def _check_url(self, url: str, what: str) -> None:
        """Refuse anything that isn't http(s), and http unless allowed."""
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https"):
            raise ConnectorError(
                f"The {what} must start with https:// (got scheme {scheme or 'none'!r})",
                hint="Use a web address like https://api.example.com. Other schemes (file:, ftp:, gopher:) "
                "are refused for safety.",
            )
        if not parts.hostname:
            raise ConnectorError(
                f"The {what} has no host name", hint="Use a full address like https://api.example.com."
            )
        if scheme == "http" and not self.settings.get("allow_http"):
            raise ConnectorError(
                f"The {what} uses plain http://, which isn't encrypted",
                hint="Use https://. For local testing only, turn on 'Allow plain HTTP'.",
            )

    def _same_origin(self, url: str) -> bool:
        a, b = urlsplit(self._url()), urlsplit(url)
        return (a.scheme, a.hostname, a.port) == (b.scheme, b.hostname, b.port)

    def _max_bytes(self) -> int:
        mb = float(self.settings.get("max_response_mb") or DEFAULT_MAX_RESPONSE_BYTES / 1024 / 1024)
        return max(1024, min(int(mb * 1024 * 1024), HARD_MAX_RESPONSE_BYTES))

    def _max_pages(self) -> int:
        return max(1, min(int(self.settings.get("max_pages") or DEFAULT_MAX_PAGES), HARD_MAX_PAGES))

    def check_settings(self) -> None:
        """Type-check settings so a malformed form value gives a clear error, not a crash.

        Messages name the setting but never echo its value.
        """
        s = self.settings
        if not isinstance(s, dict):
            raise ConnectorError("Settings must be an object", hint="Re-save the source from the form.")

        def bad(name: str, what: str) -> ConnectorError:
            return ConnectorError(f"Setting {name!r} must be {what}", hint=f"Fix {name!r} on the source and save.")

        for name in _STR_SETTINGS:
            if s.get(name) is not None and not isinstance(s[name], str):
                raise bad(name, "text")
        for name in _INT_SETTINGS:
            v = s.get(name)
            if v is not None and (isinstance(v, bool) or not isinstance(v, int)):
                raise bad(name, "a whole number")
        for name in _NUM_SETTINGS:
            v = s.get(name)
            if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0):
                raise bad(name, "a positive number")
        for name in ("allow_http", "allow_private_network"):
            if s.get(name) is not None and not isinstance(s[name], bool):
                raise bad(name, "true or false")
        for name, allowed in _ENUM_SETTINGS.items():
            if s.get(name) not in (None, "", *allowed):
                raise bad(name, "one of " + ", ".join(allowed))
        q = s.get("query")
        if q is not None and (
            not isinstance(q, dict)
            or not all(isinstance(k, str) and isinstance(v, (str, int, float, bool)) for k, v in q.items())
        ):
            raise bad("query", "a list of name/value pairs (text values)")
        if s.get("path"):
            _check_relative_path(str(s["path"]))
        if not str(s.get("base_url") or "").strip():
            raise ConnectorError(
                "Setting 'base_url' is empty", hint="Enter the API address, e.g. https://api.example.com."
            )

    # -- HTTP -------------------------------------------------------------

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            timeout = float(self.settings.get("timeout_s") or 15)
            self._client = httpx.AsyncClient(
                transport=GuardedTransport(allow_private=self.settings.get("allow_private_network") is True),
                trust_env=False,
                timeout=httpx.Timeout(timeout, connect=min(timeout, 10.0)),
                follow_redirects=False,
                # Only codings we decode ourselves, with a cap (LIVEOPS-64).
                headers={"Accept": "application/json", "Accept-Encoding": "gzip, deflate", "User-Agent": "liveops/0.1"},
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
        self._client = None

    async def _auth_headers(self) -> dict[str, str]:
        auth = self.settings.get("auth") or "none"
        if auth == "api_key":
            key = self.secrets.get("api_key")
            if not key:
                raise ConnectorError("No API key is set", hint="Enter the API key under Secrets.")
            return {str(self.settings.get("api_key_header") or "X-API-Key"): str(key)}
        if auth == "bearer":
            tok = self.secrets.get("bearer_token")
            if not tok:
                raise ConnectorError("No bearer token is set", hint="Enter the bearer token under Secrets.")
            return {"Authorization": f"Bearer {tok}"}
        if auth == "oauth2_client_credentials":
            return {"Authorization": f"Bearer {await self._oauth_token()}"}
        return {}

    async def _oauth_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires:
            return self._token
        token_url = str(self.settings.get("token_url") or "").strip()
        if not token_url:
            raise ConnectorError("No OAuth2 token URL is set", hint="Enter the token URL from the API's docs.")
        self._check_url(token_url, "token URL")
        cid, csec = self.secrets.get("client_id"), self.secrets.get("client_secret")
        if not cid or not csec:
            raise ConnectorError("OAuth2 client ID or secret is missing", hint="Enter both under Secrets.")
        data = {"grant_type": "client_credentials"}
        if self.settings.get("oauth_scope"):
            data["scope"] = str(self.settings["oauth_scope"])
        try:
            async with asyncio.timeout(self._deadline()):
                async with self._http().stream("POST", token_url, data=data, auth=(str(cid), str(csec))) as resp:
                    status = resp.status_code
                    raw = await read_capped(resp, MAX_TOKEN_RESPONSE_BYTES) if status < 300 else b""
        except TimeoutError:
            raise ConnectorError("The token URL didn't answer in time", hint="Check the token URL.") from None
        except httpx.HTTPError as e:
            raise ConnectorError(f"Couldn't reach the token URL: {type(e).__name__}", hint=_network_hint(e)) from None
        if status in (400, 401, 403):
            raise ConnectorError(
                f"The token URL refused the client credentials (HTTP {status})",
                hint="Check the client ID and secret, and that the client is allowed the client-credentials grant.",
            )
        if status >= 300:
            raise ConnectorError(f"The token URL answered HTTP {status}", hint="Check the token URL.")
        try:
            body = json.loads(raw)
            token = str(body["access_token"])
        except (ValueError, KeyError, TypeError):
            raise ConnectorError(
                "The token URL didn't return an access_token", hint="Check the token URL is the OAuth2 token endpoint."
            ) from None
        try:
            expires_in = float(body.get("expires_in") or 300)
        except (TypeError, ValueError):
            expires_in = 300.0
        self._token = token
        self._token_expires = time.monotonic() + max(0.0, expires_in - TOKEN_REFRESH_MARGIN_S)
        return token

    def _deadline(self) -> float:
        """Overall time for one request, so a server trickling bytes can't hold a poll forever."""
        return 2 * float(self.settings.get("timeout_s") or 15)

    async def _get_json(self, url: str, params: dict[str, Any] | None) -> tuple[Any, httpx.Response]:
        self.check_settings()
        self._check_url(url, "API URL")
        headers = await self._auth_headers()
        try:
            async with asyncio.timeout(self._deadline()):
                return await self._get_json_inner(url, params, headers)
        except TimeoutError:
            raise ConnectorError(
                f"The API took longer than {self._deadline():g} s to answer",
                hint="Check the API is healthy, use smaller pages, or raise the timeout.",
            ) from None

    async def _get_json_inner(
        self, url: str, params: dict[str, Any] | None, headers: dict[str, str]
    ) -> tuple[Any, httpx.Response]:
        limit = self._max_bytes()
        try:
            async with self._http().stream("GET", url, params=params, headers=headers) as resp:
                if resp.status_code == 401 and self.settings.get("auth") == "oauth2_client_credentials":
                    self._token = None  # expired early; next poll fetches a new one
                if resp.status_code >= 300:
                    raise _status_error(resp.status_code)
                buf = await read_capped(resp, limit)
        except httpx.HTTPError as e:
            raise ConnectorError(f"Couldn't reach the API: {type(e).__name__}", hint=_network_hint(e)) from None
        try:
            return json.loads(bytes(buf)), resp
        except ValueError:
            raise ConnectorError(
                "The API didn't return JSON", hint="Check the path points at a JSON endpoint, not a web page."
            ) from None

    def _records_from(self, doc: Any) -> list[Record]:
        path = self.settings.get("record_path") or ""
        found = select_path(doc, path)
        if found is None:
            raise ConnectorError(
                f"No records found at {path or 'the top level'!r} in the response",
                hint="Open the URL in a browser and set 'Where the records are' to the dotted path of the list.",
            )
        if isinstance(found, dict):
            found = [found]
        if not isinstance(found, list):
            raise ConnectorError(
                f"The value at {path or 'the top level'!r} is not a list of records",
                hint="Point 'Where the records are' at a list of JSON objects.",
            )
        return [normalize_record(r) for r in found if isinstance(r, dict)]

    async def fetch_all(self, max_records: int = MAX_ROWS) -> list[Record]:
        """Fetch every page (up to the page cap) and return all records.

        Raises instead of truncating: a partial snapshot would look like deletes."""
        self.check_settings()
        mode = self.settings.get("pagination") or "none"
        max_pages = self._max_pages()
        base_params: dict[str, Any] = {str(k): v for k, v in (self.settings.get("query") or {}).items()}
        url: str | None = self._url()
        params: dict[str, Any] | None = dict(base_params)
        page_no = int(self.settings.get("start_page") or 1)
        page_size = int(self.settings.get("page_size") or 100)
        seen_cursors: set[str] = set()
        out: list[Record] = []
        pages = 0
        while url is not None:
            if pages >= max_pages:
                raise ConnectorError(
                    f"The API has more than {max_pages} pages",
                    hint="Raise 'Max pages per poll', increase the page size, or filter the query so fewer "
                    "records come back.",
                )
            if mode == "page_number":
                assert params is not None
                params[str(self.settings.get("page_param") or "page")] = page_no
                params[str(self.settings.get("page_size_param") or "per_page")] = page_size
            doc, resp = await self._get_json(url, params)
            pages += 1
            recs = self._records_from(doc)
            out.extend(recs)
            check_row_cap(len(out), f"The API endpoint {self.dataset_name!r}", max_records)
            if mode == "page_number":
                if len(recs) < page_size:
                    break
                page_no += 1
            elif mode == "cursor":
                cur = select_path(doc, self.settings.get("cursor_path") or "next_cursor")
                if cur in (None, "", False):
                    break
                cur_s = str(cur)
                if cur_s in seen_cursors:
                    raise ConnectorError(
                        "The API returned the same cursor twice", hint="Check 'Where the next cursor is'."
                    )
                seen_cursors.add(cur_s)
                params = {**base_params, str(self.settings.get("cursor_param") or "cursor"): cur_s}
            elif mode == "link_header":
                nxt = resp.links.get("next", {}).get("url")
                if not nxt:
                    break
                nxt = urljoin(str(resp.request.url), nxt)  # the logical URL we asked for (LIVEOPS-56)
                if not self._same_origin(nxt):
                    raise ConnectorError(
                        "The API's next-page link points at a different server",
                        hint="For safety, pages must come from the same host as the base URL.",
                    )
                url, params = nxt, None  # the link already carries the query
            else:
                break
        return out

    # -- contract ---------------------------------------------------------

    async def test(self) -> TestReport:
        started = time.monotonic()
        steps: list[TestStep] = []
        try:
            return await self._test(steps, started)
        except Exception as e:  # noqa: BLE001 - test() must never raise
            steps.append(
                TestStep(
                    name="Run test",
                    ok=False,
                    detail=f"Unexpected error: {type(e).__name__}",
                    hint="Check the settings; if this repeats, report it with the source type.",
                )
            )
            return TestReport.from_steps(steps, started)

    async def _test(self, steps: list[TestStep], started: float) -> TestReport:
        try:
            self.check_settings()
            steps.append(TestStep(name="Check the settings", ok=True, detail="valid"))
        except ConnectorError as e:
            steps.append(TestStep(name="Check the settings", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        try:
            self._check_url(self._url(), "API URL")
            detail = self._url()
            if urlsplit(detail).scheme == "http":
                detail += " (plain HTTP: local testing only)"
            steps.append(TestStep(name="Check the address", ok=True, detail=detail))
        except ConnectorError as e:
            steps.append(TestStep(name="Check the address", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        if self.settings.get("auth") == "oauth2_client_credentials":
            try:
                await self._oauth_token()
                steps.append(TestStep(name="Get an OAuth2 token", ok=True, detail="token received"))
            except ConnectorError as e:
                steps.append(TestStep(name="Get an OAuth2 token", ok=False, detail=str(e), hint=e.hint))
                return TestReport.from_steps(steps, started)
        try:
            doc, resp = await self._get_json(self._url(), self._first_page_params())
            steps.append(TestStep(name="Call the API", ok=True, detail=f"HTTP {resp.status_code}"))
        except ConnectorError as e:
            steps.append(TestStep(name="Call the API", ok=False, detail=str(e), hint=e.hint))
            return TestReport.from_steps(steps, started)
        try:
            recs = self._records_from(doc)
            steps.append(
                TestStep(
                    name="Find records",
                    ok=bool(recs),
                    detail=f"{len(recs)} records on the first page",
                    hint="" if recs else "The list is empty. Check the query parameters and record path.",
                )
            )
        except ConnectorError as e:
            steps.append(TestStep(name="Find records", ok=False, detail=str(e), hint=e.hint))
        return TestReport.from_steps(steps, started)

    def _first_page_params(self) -> dict[str, Any]:
        params: dict[str, Any] = {str(k): v for k, v in (self.settings.get("query") or {}).items()}
        if (self.settings.get("pagination") or "none") == "page_number":
            params[str(self.settings.get("page_param") or "page")] = int(self.settings.get("start_page") or 1)
            params[str(self.settings.get("page_size_param") or "per_page")] = int(self.settings.get("page_size") or 100)
        return params

    async def discover(self) -> list[Dataset]:
        self.check_settings()
        doc, _ = await self._get_json(self._url(), self._first_page_params())
        cols = infer_columns(self._records_from(doc))
        return [Dataset(name=self.dataset_name, columns=cols, primary_key=primary_key_guess(cols))]

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        self._resolve(dataset)
        self.check_settings()
        doc, _ = await self._get_json(self._url(), self._first_page_params())
        return self._records_from(doc)[:limit]

    async def snapshot(self, dataset: str) -> list[Record]:
        self._resolve(dataset)
        return await self.fetch_all()

    def _resolve(self, dataset: str) -> None:
        if dataset != self.dataset_name:
            raise ConnectorError(
                f"This API source has one dataset, {self.dataset_name!r}, not {dataset!r}",
                hint="Pick the dataset listed for this source.",
            )


MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
_DECODERS = {"gzip": 16 + zlib.MAX_WBITS, "x-gzip": 16 + zlib.MAX_WBITS, "deflate": zlib.MAX_WBITS}


async def read_capped(resp: httpx.Response, limit: int) -> bytes:
    """Read a response body, never holding or *decoding* more than ``limit`` bytes.

    httpx would decode every listed Content-Encoding with no output bound, so a
    few KB of stacked gzip can expand to GBs (LIVEOPS-64). We read the raw
    bytes and inflate them ourselves with ``max_length``. Only one coding
    (gzip or deflate) is accepted; stacked or unknown codings are refused.
    """
    declared = resp.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _too_big(limit)
    codings = [c.strip().lower() for c in resp.headers.get("content-encoding", "").split(",")]
    codings = [c for c in codings if c and c != "identity"]
    if len(codings) > 1 or (codings and codings[0] not in _DECODERS):
        raise ConnectorError(
            "The API sent the response in an encoding Live Ops doesn't accept",
            hint="Ask the API owner to send plain or gzip-compressed JSON (one compression layer).",
        )
    dec = zlib.decompressobj(_DECODERS[codings[0]]) if codings else None
    out = bytearray()
    raw_total = 0
    try:
        async for chunk in resp.aiter_raw():
            raw_total += len(chunk)
            if raw_total > limit:
                raise _too_big(limit)
            if dec is None:
                out.extend(chunk)
            else:
                data = chunk
                while data and not dec.eof:
                    out.extend(dec.decompress(data, limit - len(out) + 1))
                    if len(out) > limit:
                        raise _too_big(limit)
                    data = dec.unconsumed_tail
            if len(out) > limit:
                raise _too_big(limit)
        if dec is not None:
            out.extend(dec.flush(limit - len(out) + 1))
            if len(out) > limit:
                raise _too_big(limit)
    except zlib.error:
        raise ConnectorError(
            "The API's compressed response is damaged", hint="Try again; if it repeats, ask the API owner."
        ) from None
    return bytes(out)


def _absolute_path_error() -> ConnectorError:
    return ConnectorError(
        "Setting 'path' must be a path on the base URL's server, not a full address",
        hint="Put the server in 'Base URL' and only the part after it (like /v1/beds) in 'Path'.",
    )


def _check_relative_path(path: str) -> None:
    """``path`` may not name another server: no scheme, no //host, no backslashes (LIVEOPS-24)."""
    p = path.strip()
    if (
        re.match(r"^[A-Za-z][A-Za-z0-9+.\-]*:", p)
        or p.startswith("//")
        or "\\" in p
        or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in p)
    ):
        raise _absolute_path_error()


def _status_error(code: int) -> ConnectorError:
    if code in (401, 403):
        return ConnectorError(
            f"The API refused the request (HTTP {code})",
            hint="Check the sign-in method and the API key or token, and that it may read this endpoint.",
        )
    if code == 404:
        return ConnectorError("The API says this path doesn't exist (HTTP 404)", hint="Check the base URL and path.")
    if code == 429:
        return ConnectorError(
            "The API is rate-limiting us (HTTP 429)",
            hint="Raise the poll interval on the mapping, or ask for a higher rate limit.",
        )
    if 300 <= code < 400:
        return ConnectorError(
            f"The API answered with a redirect (HTTP {code})",
            hint="Redirects aren't followed for safety. Use the final address (often https:// instead of http://).",
        )
    if code >= 500:
        return ConnectorError(f"The API had a server error (HTTP {code})", hint="Try again later or ask the API owner.")
    return ConnectorError(f"The API answered HTTP {code}", hint="Check the path and query parameters.")


def _too_big(limit: int) -> ConnectorError:
    return ConnectorError(
        f"The API response is larger than {limit // (1024 * 1024) or 1} MB",
        hint="Use pagination with a smaller page size, filter the query, or raise 'Max response size'.",
    )


def _network_hint(e: Exception) -> str:
    if isinstance(e, httpx.TimeoutException):
        return "The API didn't answer in time. Check the address, or raise the timeout."
    if isinstance(e, httpx.ConnectError):
        return (
            "Check the host name and port, and that a firewall allows the connection. From Docker, use "
            "host.docker.internal for an API on your own computer."
        )
    return "Check the address and your network."
