"""File uploads for ``csv_file`` sources.

``POST /api/sources/{source_id}/upload`` (multipart, field ``file``). The file
is written to ``LIVEOPS_DATA_DIR/<folder>/<name>`` atomically (temp file, then
rename), so a running poll never reads a half-written file. Uploading the same
name again replaces it and the map updates on the next poll.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, BinaryIO

from fastapi import APIRouter, Depends, HTTPException, Request
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import mapping_spec, runner
from app.config import get_settings
from app.connectors.base import ConnectorError
from app.connectors.files import LOCAL_EXTENSIONS, parse_bytes, safe_folder
from app.connectors.rest import infer_columns
from app.core.runner import RunnerManager
from app.db import Mapping, Source, get_session

router = APIRouter(prefix="/api", tags=["uploads"])

MULTIPART_OVERHEAD = 64 * 1024  # boundaries and part headers around the file
UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def safe_filename(raw: str | None) -> str:
    """Accept a plain file name only. Anything with folders is refused (422)."""
    name = (raw or "").strip()
    if not name:
        raise HTTPException(422, detail={"message": "The upload has no file name", "hint": "Pick a file to upload."})
    if "/" in name or "\\" in name or "\x00" in name or name in (".", "..") or ".." in name:
        raise HTTPException(
            422,
            detail={
                "message": "File name can't contain folders or '..'",
                "hint": "Rename the file to a plain name like beds.csv and upload it again.",
            },
        )
    stem, ext = os.path.splitext(name)
    if ext.lower() not in LOCAL_EXTENSIONS:
        raise HTTPException(
            415,
            detail={
                "message": f"Files of type {ext or '(none)'!r} aren't supported",
                "hint": "Upload a .csv or .xlsx file. For .xls or .numbers, save as .xlsx first.",
            },
        )
    stem = UNSAFE_CHARS.sub("_", stem).strip(" .")[:120]
    if not stem:
        raise HTTPException(422, detail={"message": "File name is empty after cleaning", "hint": "Rename the file."})
    return stem + ext.lower()


class _TooBig(Exception):
    pass


def _too_big(limit: int, hint: str) -> HTTPException:
    return HTTPException(413, detail={"message": f"File is larger than {limit // (1024 * 1024)} MB", "hint": hint})


TOO_BIG_HINT = "Split it into smaller files, or ask an admin to raise LIVEOPS_MAX_UPLOAD_MB."


class _MultipartSink:
    """Receives python-multipart callbacks; writes the ``file`` part straight to
    ``tmp`` and stops as soon as it passes ``limit`` bytes (LIVEOPS-18).
    ``check_name`` validates the part's file name (raises HTTPException to refuse)."""

    def __init__(self, tmp: Path, limit: int, check_name: Callable[[str | None], str] = safe_filename) -> None:
        self.tmp, self.limit, self.check_name = tmp, limit, check_name
        self.filename: str | None = None
        self.size = 0
        self._out: BinaryIO | None = None
        self._in_file = False
        self._done = False  # the file part ended (python-multipart saw the next boundary)
        self.ended = False  # the closing boundary was seen: the body is complete (LIVEOPS-57)
        self._hfield = bytearray()
        self._hvalue = bytearray()
        self._headers: dict[bytes, bytes] = {}

    def callbacks(self) -> dict[str, Any]:
        return {
            "on_part_begin": self._part_begin,
            "on_header_field": lambda d, a, b: self._hfield.extend(d[a:b]),
            "on_header_value": lambda d, a, b: self._hvalue.extend(d[a:b]),
            "on_header_end": self._header_end,
            "on_headers_finished": self._headers_finished,
            "on_part_data": self._part_data,
            "on_part_end": self._part_end,
            "on_end": self._end,
        }

    def _end(self) -> None:
        self.ended = True

    def _part_begin(self) -> None:
        self._headers = {}
        self._in_file = False

    def _header_end(self) -> None:
        self._headers[bytes(self._hfield).lower()] = bytes(self._hvalue)
        self._hfield.clear()
        self._hvalue.clear()

    def _headers_finished(self) -> None:
        disp, params = parse_options_header(self._headers.get(b"content-disposition", b""))
        if disp != b"form-data" or params.get(b"name") != b"file" or self._done:
            return
        raw = params.get(b"filename")
        self.filename = self.check_name(raw.decode("utf-8", errors="replace") if raw is not None else None)
        self._out = self.tmp.open("wb")
        self._in_file = True

    def _part_data(self, data: bytes, start: int, end: int) -> None:
        if not self._in_file or self._out is None:
            return
        self.size += end - start
        if self.size > self.limit:
            raise _TooBig
        self._out.write(data[start:end])

    def _part_end(self) -> None:
        if self._in_file:
            self._in_file = False
            self._done = True
            self.close()

    def close(self) -> None:
        if self._out is not None:
            self._out.close()
            self._out = None


async def receive_file(
    request: Request,
    tmp: Path,
    limit: int,
    check_name: Callable[[str | None], str] = safe_filename,
    too_big_hint: str = TOO_BIG_HINT,
) -> tuple[str, int]:
    """Stream the multipart body: refuse early by Content-Length, then count while
    parsing, so an oversized upload is never fully read or spooled anywhere."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit + MULTIPART_OVERHEAD:
        raise _too_big(limit, too_big_hint)
    ctype, params = parse_options_header(request.headers.get("content-type", ""))
    boundary = params.get(b"boundary")
    if ctype != b"multipart/form-data" or not boundary:
        raise HTTPException(
            422,
            detail={
                "message": "Upload must be multipart/form-data with a 'file' field",
                "hint": "Send the file as a form upload, e.g. curl -F file=@beds.csv <url>.",
            },
        )
    sink = _MultipartSink(tmp, limit, check_name)
    parser = MultipartParser(boundary, sink.callbacks())  # type: ignore[arg-type]
    received = 0
    try:
        async for chunk in request.stream():
            received += len(chunk)
            if received > limit + MULTIPART_OVERHEAD:
                raise _TooBig
            parser.write(chunk)
        parser.finalize()
    except _TooBig:
        raise _too_big(limit, too_big_hint) from None
    except MultipartParseError:
        raise HTTPException(
            422, detail={"message": "The upload is not valid multipart form data", "hint": "Upload the file again."}
        ) from None
    finally:
        sink.close()
    if sink.filename is None:
        raise HTTPException(
            422, detail={"message": "No 'file' field in the upload", "hint": "Send the file in a field named 'file'."}
        )
    if not (sink._done and sink.ended):
        raise HTTPException(
            422,
            detail={
                "message": "The upload was cut off before the end",
                "hint": "Upload the file again. The previous version of the file was kept.",
            },
        )
    return sink.filename, sink.size


@router.post("/sources/{source_id}/upload", status_code=201)
async def upload(
    source_id: str,
    request: Request,
    session: Session = Depends(get_session),
    rm: RunnerManager = Depends(runner),
) -> dict[str, Any]:
    src = session.get(Source, source_id)
    if src is None:
        raise HTTPException(404, detail={"message": "Source not found"})
    if src.type != "csv_file":
        raise HTTPException(
            422,
            detail={
                "message": f"Source type {src.type!r} doesn't take uploads",
                "hint": "Upload to a 'CSV / Excel file' source.",
            },
        )
    settings = dict(src.settings or {})
    # Same rule as the connector: the folder setting, else the source's own folder (its id).
    try:
        folder = safe_folder(str(settings.get("folder") or src.id))
    except ConnectorError as e:
        raise HTTPException(422, detail={"message": str(e), "hint": e.hint}) from None
    limit = get_settings().max_upload_mb * 1024 * 1024
    await asyncio.to_thread(folder.mkdir, parents=True, exist_ok=True)
    tmp = folder / f".upload-{uuid.uuid4().hex}.tmp"
    try:
        name, size = await receive_file(request, tmp, limit)
        data = await asyncio.to_thread(tmp.read_bytes)
        try:
            rows = await asyncio.to_thread(parse_bytes, name, data, settings)
        except ConnectorError as e:
            raise HTTPException(422, detail={"message": str(e), "hint": e.hint}) from None
        await asyncio.to_thread(os.replace, tmp, folder / name)
    finally:
        with contextlib.suppress(FileNotFoundError):
            await asyncio.to_thread(tmp.unlink)
    # Mappings that failed because no file existed yet restart now instead of waiting for backoff.
    for m in session.scalars(select(Mapping).where(Mapping.source_id == src.id, Mapping.active.is_(True))):
        h = rm.health.get(m.id)
        if h is not None and h.status == "error":
            await rm.start(mapping_spec(m, src))
    return {
        "dataset": name,
        "bytes": size,
        "rows": len(rows),
        "columns": [c.name for c in infer_columns(rows)],
    }
