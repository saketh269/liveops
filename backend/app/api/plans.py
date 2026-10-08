"""Floor plan images for site layouts (ADR 0006).

``POST /api/sites/{site_id}/plans`` (multipart, field ``file``) accepts PNG,
JPEG, WebP or PDF. The type is decided by the file's first bytes, never by its
name. Raster images are fully decoded once to prove they are valid, after the
pixel count is checked against ``LIVEOPS_MAX_PLAN_MEGAPIXELS`` from the header
alone (so a decompression bomb is refused before it is expanded). The first
page of a PDF is rendered to PNG. Files are stored as
``LIVEOPS_DATA_DIR/plans/<site id>/<asset id>.<ext>``; the asset id is a random
UUID, so user input never becomes a path.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import math
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.api.uploads import receive_file
from app.config import get_settings
from app.db import Site, get_session

router = APIRouter(prefix="/api/sites", tags=["plans"])

ASSET_ID = re.compile(r"^[0-9a-f]{32}$")
SAFE_SITE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Extension and media type per stored format. The order is the lookup order for GET.
FORMATS: dict[str, tuple[str, str]] = {
    "PNG": (".png", "image/png"),
    "JPEG": (".jpg", "image/jpeg"),
    "WEBP": (".webp", "image/webp"),
}
CONTENT_TYPES = {ext: ctype for ext, ctype in FORMATS.values()}
PDF_MAX_DPI = 300
PDF_MAX_SIDE_PX = 8000
PROCESS_TIMEOUT_S = 60
CACHE_CONTROL = "private, max-age=31536000, immutable"  # an asset id never changes content
TOO_BIG_HINT = "Export the plan at a lower resolution or as PNG, or ask an admin to raise LIVEOPS_MAX_PLAN_MB."
TYPE_HINT = "Upload a PNG, JPEG, WebP or PDF floor plan. From other formats, export or save as PNG first."


class PlanError(Exception):
    def __init__(self, status: int, message: str, hint: str) -> None:
        super().__init__(message)
        self.status, self.message, self.hint = status, message, hint

    def http(self) -> HTTPException:
        return HTTPException(self.status, detail={"message": self.message, "hint": self.hint})


@dataclass(frozen=True)
class ProcessedPlan:
    data: bytes | None  # None: store the uploaded bytes unchanged
    ext: str
    content_type: str
    width_px: int
    height_px: int


def sniff(head: bytes) -> str | None:
    """File type from magic bytes: PNG, JPEG, WEBP, PDF or None."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if head.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    if head.lstrip(b"\x00\t\n\r ")[:5] == b"%PDF-":
        return "PDF"
    return None


def _too_many_pixels(w: int, h: int, max_pixels: int) -> PlanError:
    return PlanError(
        413,
        f"The image is {w} × {h} pixels, more than the {max_pixels // 1_000_000} megapixel limit",
        "Export the plan at a lower resolution (about 4000 pixels on the long side is plenty), "
        "or ask an admin to raise LIVEOPS_MAX_PLAN_MEGAPIXELS.",
    )


def _encode_png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def _process_raster(data: bytes, fmt: str, max_pixels: int) -> ProcessedPlan:
    ext, ctype = FORMATS[fmt]
    try:
        with Image.open(io.BytesIO(data), formats=[fmt]) as im:
            w, h = im.size
            if w <= 0 or h <= 0:
                raise PlanError(422, "The image has no pixels", "Export the floor plan again and upload the new file.")
            if w * h > max_pixels:
                raise _too_many_pixels(w, h, max_pixels)
            if getattr(im, "n_frames", 1) > 1:
                raise PlanError(415, "Animated images can't be used as a floor plan", "Export a still PNG or JPEG.")
            im.load()  # full decode: proves the file is complete and valid
            orientation = im.getexif().get(0x0112, 1) if fmt == "JPEG" else 1
            if orientation not in (1, None):
                # Store the image upright so the browser, the 3D texture and width/height all agree.
                upright = ImageOps.exif_transpose(im)
                buf = io.BytesIO()
                upright.convert("RGB").save(buf, format="JPEG", quality=92)
                return ProcessedPlan(buf.getvalue(), ext, ctype, upright.width, upright.height)
            return ProcessedPlan(None, ext, ctype, w, h)
    except PlanError:
        raise
    except Image.DecompressionBombError:
        raise PlanError(
            413,
            "The image has too many pixels to open safely",
            "Export the plan at a lower resolution (about 4000 pixels on the long side is plenty).",
        ) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise PlanError(
            422,
            f"The file starts like a {fmt} image but could not be read; it may be damaged or cut off",
            "Open the plan in an image viewer, export it again as PNG, and upload the new file.",
        ) from None


def _process_pdf(data: bytes, max_pixels: int) -> ProcessedPlan:
    try:
        import pypdfium2 as pdfium
    except ImportError:  # pragma: no cover - pypdfium2 is a declared dependency
        raise PlanError(
            415, "This server can't read PDF files", "Export the floor plan as PNG and upload that."
        ) from None
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError:
        raise PlanError(
            422,
            "The PDF could not be opened; it may be damaged or protected with a password",
            "Remove the password or export the floor plan page as PNG, then upload it again.",
        ) from None
    try:
        if len(pdf) == 0:
            raise PlanError(422, "The PDF has no pages", "Export the floor plan page as PDF or PNG again.")
        page = pdf[0]
        try:
            pw, ph = page.get_size()  # PDF points (1/72 inch)
            if not (pw > 0 and ph > 0):
                raise PlanError(422, "The first page of the PDF is empty", "Export the floor plan page as PNG.")
            budget = min(max_pixels, PDF_MAX_SIDE_PX * PDF_MAX_SIDE_PX) * 0.98  # headroom for rounding up
            scale = min(PDF_MAX_DPI / 72, math.sqrt(budget / (pw * ph)), PDF_MAX_SIDE_PX / max(pw, ph))
            bitmap = page.render(scale=scale)
            try:
                im = bitmap.to_pil()
                if im.width * im.height > max_pixels:
                    raise _too_many_pixels(im.width, im.height, max_pixels)
                png = _encode_png(im.convert("RGB"))
                return ProcessedPlan(png, ".png", "image/png", im.width, im.height)
            finally:
                bitmap.close()
        except pdfium.PdfiumError:
            raise PlanError(
                422,
                "The first page of the PDF could not be drawn",
                "Export the floor plan page as PNG and upload that.",
            ) from None
        finally:
            page.close()
    finally:
        pdf.close()


def process_plan(data: bytes, max_pixels: int) -> ProcessedPlan:
    """Validate an uploaded plan and convert it to a stored image. Raises PlanError."""
    fmt = sniff(data[:64])
    if fmt is None:
        raise PlanError(415, "This file isn't a PNG, JPEG, WebP or PDF", TYPE_HINT)
    if fmt == "PDF":
        return _process_pdf(data, max_pixels)
    return _process_raster(data, fmt, max_pixels)


def plans_root() -> Path:
    return Path(get_settings().data_dir) / "plans"


def site_folder(site_id: str) -> Path:
    if not SAFE_SITE_ID.match(site_id):
        raise HTTPException(404, detail={"message": "Site not found"})
    return plans_root() / site_id


def remove_site_plans(site_id: str) -> None:
    """Delete every plan image of a site (called when the site is deleted)."""
    if SAFE_SITE_ID.match(site_id):
        shutil.rmtree(plans_root() / site_id, ignore_errors=True)


def _find(site_id: str, asset_id: str) -> Path | None:
    if not ASSET_ID.match(asset_id):
        return None
    folder = site_folder(site_id)
    for ext in CONTENT_TYPES:
        p = folder / f"{asset_id}{ext}"
        if p.is_file():
            return p
    return None


def _require_site(session: Session, site_id: str) -> Site:
    s = session.get(Site, site_id)
    if s is None:
        raise HTTPException(404, detail={"message": "Site not found"})
    return s


def _plan_name(raw: str | None) -> str:
    # The stored name is a random id; the uploaded name is only checked for presence.
    if not (raw or "").strip():
        raise HTTPException(422, detail={"message": "The upload has no file name", "hint": "Pick a file to upload."})
    return "plan"


def _not_found() -> HTTPException:
    return HTTPException(
        404,
        detail={
            "message": "Floor plan image not found",
            "hint": "It may have been removed. Open the layout editor and upload the plan again.",
        },
    )


@router.post("/{site_id}/plans", status_code=201)
async def upload_plan(site_id: str, request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    _require_site(session, site_id)
    settings = get_settings()
    folder = site_folder(site_id)
    await asyncio.to_thread(folder.mkdir, parents=True, exist_ok=True)
    existing = await asyncio.to_thread(lambda: sum(1 for p in folder.iterdir() if p.suffix in CONTENT_TYPES))
    if existing >= settings.max_plans_per_site:
        raise HTTPException(
            409,
            detail={
                "message": f"This site already has {existing} floor plan images",
                "hint": "Remove plans you no longer use in the layout editor, then upload again.",
            },
        )
    limit = settings.max_plan_mb * 1024 * 1024
    tmp = folder / f".upload-{uuid.uuid4().hex}.tmp"
    try:
        await receive_file(
            request,
            tmp,
            limit,
            check_name=_plan_name,
            too_big_hint=TOO_BIG_HINT,
        )
        data = await asyncio.to_thread(tmp.read_bytes)
        try:
            plan = await asyncio.wait_for(
                asyncio.to_thread(process_plan, data, settings.max_plan_megapixels * 1_000_000), PROCESS_TIMEOUT_S
            )
        except PlanError as e:
            raise e.http() from None
        except TimeoutError:
            raise HTTPException(
                422,
                detail={
                    "message": "The file took too long to read",
                    "hint": "Export the floor plan as PNG and upload that.",
                },
            ) from None
        asset_id = uuid.uuid4().hex
        final = folder / f"{asset_id}{plan.ext}"
        if plan.data is not None:
            await asyncio.to_thread(tmp.write_bytes, plan.data)
        await asyncio.to_thread(os.replace, tmp, final)
    finally:
        with contextlib.suppress(FileNotFoundError):
            await asyncio.to_thread(tmp.unlink)
    return {
        "asset_id": asset_id,
        "width_px": plan.width_px,
        "height_px": plan.height_px,
        "content_type": plan.content_type,
    }


@router.get("/{site_id}/plans/{asset_id}", response_model=None)
async def get_plan(site_id: str, asset_id: str, request: Request, session: Session = Depends(get_session)) -> Response:
    _require_site(session, site_id)
    path = await asyncio.to_thread(_find, site_id, asset_id)
    if path is None:
        raise _not_found()
    etag = f'"{asset_id}"'
    headers = {
        "Cache-Control": CACHE_CONTROL,
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        "Content-Disposition": "inline",
    }
    if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type=CONTENT_TYPES[path.suffix], headers=headers)


@router.delete("/{site_id}/plans/{asset_id}", status_code=204)
async def delete_plan(site_id: str, asset_id: str, session: Session = Depends(get_session)) -> None:
    _require_site(session, site_id)
    path = await asyncio.to_thread(_find, site_id, asset_id)
    if path is None:
        raise _not_found()
    with contextlib.suppress(FileNotFoundError):
        await asyncio.to_thread(path.unlink)
