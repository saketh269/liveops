"""Floor plan image processing (ADR 0006): type sniffing, pixel caps, PDFs."""

from __future__ import annotations

import io
import struct
import zlib

import pytest
from PIL import Image

from app.api.plans import PlanError, process_plan, sniff

MAX = 40_000_000


def img_bytes(fmt: str, size: tuple[int, int] = (64, 32), mode: str = "RGB", **kw: object) -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, 255 if mode in ("L", "1") else (255, 255, 255)).save(buf, format=fmt, **kw)
    return buf.getvalue()


def png_claiming(width: int, height: int) -> bytes:
    """A PNG whose header claims a huge size; its data is never valid for that size."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    chunk = b"IHDR" + ihdr
    body = struct.pack(">I", len(ihdr)) + chunk + struct.pack(">I", zlib.crc32(chunk))
    idat = b"IDAT" + zlib.compress(b"\x00" * 64)
    body += struct.pack(">I", len(idat) - 4) + idat + struct.pack(">I", zlib.crc32(idat))
    iend = b"IEND"
    body += struct.pack(">I", 0) + iend + struct.pack(">I", zlib.crc32(iend))
    return b"\x89PNG\r\n\x1a\n" + body


@pytest.mark.parametrize(
    ("head", "fmt"),
    [
        (b"\x89PNG\r\n\x1a\n....", "PNG"),
        (b"\xff\xd8\xff\xe0....", "JPEG"),
        (b"RIFF\x10\x00\x00\x00WEBPVP8 ", "WEBP"),
        (b"%PDF-1.7\n", "PDF"),
        (b"\n %PDF-1.4", "PDF"),
        (b"GIF89a....", None),
        (b"<svg xmlns=", None),
        (b"RIFF\x10\x00\x00\x00WAVEfmt ", None),
        (b"", None),
    ],
)
def test_sniff_uses_magic_bytes(head: bytes, fmt: str | None) -> None:
    assert sniff(head) == fmt


@pytest.mark.parametrize(
    ("fmt", "ext", "ctype"),
    [("PNG", ".png", "image/png"), ("JPEG", ".jpg", "image/jpeg"), ("WEBP", ".webp", "image/webp")],
)
def test_raster_images_are_kept_as_uploaded(fmt: str, ext: str, ctype: str) -> None:
    p = process_plan(img_bytes(fmt, (640, 480)), MAX)
    assert (p.ext, p.content_type, p.width_px, p.height_px) == (ext, ctype, 640, 480)
    assert p.data is None  # stored byte for byte


def test_pixel_cap_refuses_a_bomb_before_decoding() -> None:
    # The header claims 10,000 × 5,000; the data is junk, so a decode attempt would fail with 422.
    with pytest.raises(PlanError) as e:
        process_plan(png_claiming(10_000, 5_000), MAX)
    assert e.value.status == 413 and "10000 × 5000" in e.value.message
    assert "LIVEOPS_MAX_PLAN_MEGAPIXELS" in e.value.hint


def test_huge_claimed_size_is_refused() -> None:
    # 50,000 × 50,000 (~7 GB decoded): Pillow's own guard trips first; still a 413 with a hint.
    with pytest.raises(PlanError) as e:
        process_plan(png_claiming(50_000, 50_000), MAX)
    assert e.value.status == 413 and "lower resolution" in e.value.hint


def test_real_compressed_bomb_is_refused() -> None:
    data = img_bytes("PNG", (8000, 6000), mode="1")  # 48 MP of zeros: a few KB on disk
    assert len(data) < 200_000
    with pytest.raises(PlanError) as e:
        process_plan(data, MAX)
    assert e.value.status == 413


def test_pixel_cap_is_configurable() -> None:
    with pytest.raises(PlanError):
        process_plan(img_bytes("PNG", (2000, 1000)), 1_000_000)
    assert process_plan(img_bytes("PNG", (1000, 1000)), 1_000_000).width_px == 1000


def test_truncated_image_is_refused_with_a_hint() -> None:
    data = img_bytes("PNG", (400, 400), mode="RGB")
    noisy = io.BytesIO()
    Image.effect_noise((400, 400), 50).save(noisy, format="PNG")
    for broken in (data[: len(data) // 2], noisy.getvalue()[: len(noisy.getvalue()) // 2]):
        with pytest.raises(PlanError) as e:
            process_plan(broken, MAX)
        assert e.value.status == 422 and "export it again" in e.value.hint


@pytest.mark.parametrize(
    "data", [b"name,zone\nB1,ICU\n", b"<html><script>alert(1)</script>", b"GIF89a\x01\x00\x01\x00", b""]
)
def test_unsupported_types_get_415(data: bytes) -> None:
    with pytest.raises(PlanError) as e:
        process_plan(data, MAX)
    assert e.value.status == 415 and "PNG" in e.value.hint


def test_png_named_anything_is_still_checked_by_content() -> None:
    # A JPEG body is accepted as JPEG whatever it is called; the name is never trusted.
    assert process_plan(img_bytes("JPEG"), MAX).content_type == "image/jpeg"


def test_animated_image_is_refused() -> None:
    buf = io.BytesIO()
    frames = [Image.new("RGB", (10, 10), c) for c in ((255, 0, 0), (0, 0, 255))]
    frames[0].save(buf, format="WEBP", save_all=True, append_images=frames[1:])
    with pytest.raises(PlanError) as e:
        process_plan(buf.getvalue(), MAX)
    assert e.value.status == 415


def test_jpeg_with_exif_rotation_is_stored_upright() -> None:
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise to display
    p = process_plan(img_bytes("JPEG", (200, 100), exif=exif), MAX)
    assert (p.width_px, p.height_px) == (100, 200)
    assert p.data is not None
    with Image.open(io.BytesIO(p.data)) as im:
        assert im.size == (100, 200) and im.getexif().get(0x0112, 1) == 1


def test_pdf_first_page_is_rendered_to_png() -> None:
    buf = io.BytesIO()
    pages = [Image.new("RGB", (842, 595), (255, 255, 255)), Image.new("RGB", (100, 100), (0, 0, 0))]
    pages[0].save(buf, format="PDF", save_all=True, append_images=pages[1:], resolution=72)
    p = process_plan(buf.getvalue(), MAX)
    assert p.content_type == "image/png" and p.ext == ".png" and p.data is not None
    # A4 landscape at up to 300 dpi, within the pixel budget, aspect kept.
    assert p.width_px > p.height_px
    assert abs(p.width_px / p.height_px - 842 / 595) < 0.01
    assert p.width_px * p.height_px <= MAX
    with Image.open(io.BytesIO(p.data)) as im:
        assert im.format == "PNG" and im.size == (p.width_px, p.height_px)


def test_pdf_render_respects_a_small_pixel_budget() -> None:
    buf = io.BytesIO()
    Image.new("RGB", (2000, 1000)).save(buf, format="PDF", resolution=72)
    p = process_plan(buf.getvalue(), 1_000_000)
    assert p.width_px * p.height_px <= 1_000_000


@pytest.mark.parametrize("data", [b"%PDF-1.7\n garbage that is not a pdf", b"%PDF-1.4\n%%EOF"])
def test_broken_pdf_is_refused_with_a_hint(data: bytes) -> None:
    with pytest.raises(PlanError) as e:
        process_plan(data, MAX)
    assert e.value.status == 422 and "PNG" in e.value.hint
