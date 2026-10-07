"""csv_file connector against real files on disk, plus the upload route."""

from __future__ import annotations

import csv
import io
import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from openpyxl import Workbook

from app.config import get_settings
from app.connectors.base import Connector, ConnectorError
from app.connectors.files import CsvFileConnector, parse_csv, parse_xlsx, safe_folder
from tests.conftest import requires_pg
from tests.contract.kit import SEED_ROWS, ConnectorContract
from tests.contract.portal import portal_app

FIELDS = ["id", "status", "zone", "updated_at", "amount"]


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    monkeypatch.setenv("LIVEOPS_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    (tmp_path / "data").mkdir()
    yield tmp_path / "data"
    get_settings.cache_clear()


def csv_bytes(rows: list[dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=FIELDS)
    w.writeheader()
    for r in rows:
        w.writerow({"updated_at": "2026-10-06T10:00:00Z", "amount": "1.50", **r})
    return buf.getvalue().encode()


def xlsx_bytes(rows: list[list[Any]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    for r in rows:
        ws.append(r)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


class CsvDriver:
    dataset = "assets.csv"

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.rows = {r["id"]: dict(r) for r in SEED_ROWS}
        self._write()

    def _write(self) -> None:
        tmp = self.folder / ".tmp-write"
        tmp.write_bytes(csv_bytes(list(self.rows.values())))
        os.replace(tmp, self.folder / self.dataset)  # how an upload replaces it

    async def insert(self, row: dict[str, Any]) -> None:
        self.rows[row["id"]] = dict(row)
        self._write()

    async def update(self, key: str, changes: dict[str, Any]) -> None:
        self.rows[key].update(changes)
        self._write()

    async def delete(self, key: str) -> None:
        del self.rows[key]
        self._write()


class TestCsvFileContract(ConnectorContract):
    latency_budget_s = 3.0

    @pytest.fixture
    async def driver(self, data_dir: Path) -> AsyncIterator[CsvDriver]:
        (data_dir / "site1").mkdir()
        yield CsvDriver(data_dir / "site1")

    def make_connector(self, driver: CsvDriver) -> Connector:  # type: ignore[override]
        return CsvFileConnector({"folder": "site1"}, {})

    def make_bad_connector(self, driver: CsvDriver) -> Connector:  # type: ignore[override]
        return CsvFileConnector({"folder": "no-such-folder"}, {})


# -- focused tests -----------------------------------------------------------


async def test_rereads_only_when_file_changes(data_dir: Path) -> None:
    (data_dir / "s").mkdir()
    d = CsvDriver(data_dir / "s")
    c = CsvFileConnector({"folder": "s"}, {})
    first = await c.snapshot(d.dataset)
    assert await c.snapshot(d.dataset) is first  # unchanged file: cached rows
    await d.update("A1", {"status": "occupied"})
    again = await c.snapshot(d.dataset)
    assert again is not first
    assert {r["id"]: r["status"] for r in again}["A1"] == "occupied"


async def test_excel_file_is_a_dataset(data_dir: Path) -> None:
    (data_dir / "x").mkdir()
    (data_dir / "x" / "beds.xlsx").write_bytes(
        xlsx_bytes([["id", "status", "beds"], ["B1", "free", 2], ["B2", None, 3.5], [None, None, None]])
    )
    c = CsvFileConnector({"folder": "x"}, {})
    ds = {d.name: d for d in await c.discover()}
    assert ds["beds.xlsx"].primary_key == ["id"]
    assert await c.snapshot("beds.xlsx") == [
        {"id": "B1", "status": "free", "beds": 2},
        {"id": "B2", "status": None, "beds": 3.5},
    ]


@pytest.mark.parametrize("folder", ["../etc", "/etc", "a/../../b", "..", ".hidden", "a\\..\\..\\b"])
def test_folder_setting_cannot_escape_data_dir(data_dir: Path, folder: str) -> None:
    with pytest.raises(ConnectorError):
        safe_folder(folder)


async def test_symlinks_and_other_files_are_not_listed(data_dir: Path, tmp_path: Path) -> None:
    (data_dir / "s").mkdir()
    secret = tmp_path / "outside.csv"
    secret.write_text("id\nleak\n")
    (data_dir / "s" / "link.csv").symlink_to(secret)
    (data_dir / "s" / "notes.txt").write_text("hi")
    (data_dir / "s" / "ok.csv").write_text("id\n1\n")
    c = CsvFileConnector({"folder": "s"}, {})
    assert [d.name for d in await c.discover()] == ["ok.csv"]
    with pytest.raises(ConnectorError):
        await c.snapshot("link.csv")
    with pytest.raises(ConnectorError):
        await c.snapshot("../outside.csv")


async def test_no_folder_yet_says_upload(data_dir: Path) -> None:
    report = await CsvFileConnector({}, {}).test()
    assert not report.ok and "Upload" in report.steps[0].hint


def test_csv_edge_cases() -> None:
    rows = parse_csv('﻿id;name;\nA;Zoë;\n;;\nB;"x;y";z\n'.encode(), delimiter=";")
    assert rows == [{"id": "A", "name": "Zoë", "column_3": None}, {"id": "B", "name": "x;y", "column_3": "z"}]
    assert parse_csv(b"") == []
    with pytest.raises(ConnectorError, match="UTF-8|utf-8"):
        parse_csv(b"id\n\xff\xfe\n", encoding="utf-8")


def test_bad_xlsx_has_hint() -> None:
    with pytest.raises(ConnectorError) as e:
        parse_xlsx(b"not a zip")
    assert ".xlsx" in e.value.hint


# -- upload route ------------------------------------------------------------


@pytest.fixture
def app(temp_database: str, data_dir: Path) -> Iterator[FastAPI]:
    with portal_app(temp_database) as a:
        yield a


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    from app.core.runner import RunnerManager
    from app.core.state import InMemoryStateStore

    app.state.runner = RunnerManager(InMemoryStateStore())  # lifespan doesn't run under ASGITransport
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://liveops.test") as c:
        yield c
    await app.state.runner.stop_all()


def _found(root: Path, pattern: str) -> list[Path]:
    return list(root.rglob(pattern))


async def new_source(client: httpx.AsyncClient, type_: str = "csv_file") -> str:
    r = await client.post("/api/sources", json={"name": "f", "type": type_, "settings": {"key_field": "id"}})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def upload(client: httpx.AsyncClient, sid: str, name: str, data: bytes) -> httpx.Response:
    return await client.post(f"/api/sources/{sid}/upload", files={"file": (name, data, "application/octet-stream")})


@requires_pg
async def test_upload_then_test_and_preview(client: httpx.AsyncClient, data_dir: Path) -> None:
    sid = await new_source(client)
    r = await upload(client, sid, "My Beds (v2).csv", csv_bytes(SEED_ROWS))
    assert r.status_code == 201, r.text
    assert r.json()["rows"] == 3 and r.json()["dataset"] == "My_Beds__v2_.csv"
    assert (data_dir / sid / "My_Beds__v2_.csv").is_file()
    assert (await client.get(f"/api/sources/{sid}")).json()["settings"]["folder"] == sid
    assert (await client.post(f"/api/sources/{sid}/test")).json()["ok"] is True
    rows = (await client.get(f"/api/sources/{sid}/preview", params={"dataset": "My_Beds__v2_.csv"})).json()
    assert [x["id"] for x in rows] == ["A1", "A2", "A3"]
    assert not list((data_dir / sid).glob(".upload-*")), "temp files must be cleaned up"


@requires_pg
@pytest.mark.parametrize("name", ["../../evil.csv", "..\\..\\evil.csv", "/etc/cron.d/evil.csv", "a/../evil.csv", ".."])
async def test_upload_path_traversal_is_refused(client: httpx.AsyncClient, data_dir: Path, name: str) -> None:
    sid = await new_source(client)
    r = await upload(client, sid, name, b"id\n1\n")
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["hint"]
    written = [p for p in data_dir.parent.rglob("evil.csv")]
    assert written == []


@requires_pg
async def test_upload_extension_allowlist(client: httpx.AsyncClient) -> None:
    sid = await new_source(client)
    r = await upload(client, sid, "run.sh", b"#!/bin/sh\n")
    assert r.status_code == 415
    assert ".csv or .xlsx" in r.json()["detail"]["hint"]


@requires_pg
async def test_upload_size_cap(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, data_dir: Path) -> None:
    monkeypatch.setenv("LIVEOPS_MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    sid = await new_source(client)
    r = await upload(client, sid, "big.csv", b"id\n" + b"1234567\n" * (1024 * 1024 // 8 + 10))
    assert r.status_code == 413
    assert not _found(data_dir, "big.csv") and not _found(data_dir, ".upload-*")


@requires_pg
async def test_upload_unreadable_file_is_422(client: httpx.AsyncClient) -> None:
    sid = await new_source(client)
    r = await upload(client, sid, "broken.xlsx", b"definitely not excel")
    assert r.status_code == 422
    assert "xlsx" in r.json()["detail"]["message"]


@requires_pg
async def test_upload_only_for_file_sources(client: httpx.AsyncClient) -> None:
    r = await client.post(
        "/api/sources",
        json={"name": "w", "type": "webhook", "settings": {"key_field": "id"}, "secrets": {"signing_secret": "x" * 20}},
    )
    r = await upload(client, r.json()["id"], "a.csv", b"id\n1\n")
    assert r.status_code == 422
