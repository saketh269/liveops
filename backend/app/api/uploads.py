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
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile
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

CHUNK = 1024 * 1024
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


@router.post("/sources/{source_id}/upload", status_code=201)
async def upload(
    source_id: str,
    file: UploadFile,
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
    name = safe_filename(file.filename)
    settings = dict(src.settings or {})
    folder_changed = not settings.get("folder")
    folder_name = str(settings.get("folder") or src.id)
    try:
        folder = safe_folder(folder_name)
    except ConnectorError as e:
        raise HTTPException(422, detail={"message": str(e), "hint": e.hint}) from None
    limit = get_settings().max_upload_mb * 1024 * 1024
    await asyncio.to_thread(folder.mkdir, parents=True, exist_ok=True)
    tmp = folder / f".upload-{uuid.uuid4().hex}.tmp"
    final = folder / name
    try:
        size = await _save(file, tmp, limit)
        data = await asyncio.to_thread(tmp.read_bytes)
        try:
            rows = await asyncio.to_thread(parse_bytes, name, data, settings)
        except ConnectorError as e:
            raise HTTPException(422, detail={"message": str(e), "hint": e.hint}) from None
        await asyncio.to_thread(os.replace, tmp, final)
    finally:
        with contextlib.suppress(FileNotFoundError):
            await asyncio.to_thread(tmp.unlink)
    if folder_changed:
        settings["folder"] = folder_name
        src.settings = settings
        session.commit()
        for m in session.scalars(select(Mapping).where(Mapping.source_id == src.id, Mapping.active.is_(True))):
            await rm.start(mapping_spec(m, src))
    return {
        "dataset": name,
        "bytes": size,
        "rows": len(rows),
        "columns": [c.name for c in infer_columns(rows)],
    }


async def _save(file: UploadFile, dest: Path, limit: int) -> int:
    size = 0
    with dest.open("wb") as out:  # noqa: ASYNC230 - small chunked writes to local disk
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise HTTPException(
                    413,
                    detail={
                        "message": f"File is larger than {limit // (1024 * 1024)} MB",
                        "hint": "Split it into smaller files, or ask an admin to raise LIVEOPS_MAX_UPLOAD_MB.",
                    },
                )
            out.write(chunk)
    return size
