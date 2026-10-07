"""Row filters (MappingConfig.filter, ADR 0006): matching, coercion, validation,
and how the runner applies them to snapshots, polls and CDC changes."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
from pydantic import ValidationError

from app.connectors.base import (
    Category,
    Change,
    ChangeOp,
    Connector,
    ConnectorSpec,
    Dataset,
    Mode,
    PollingConnector,
    Record,
    snapshot_end,
)
from app.connectors.base import TestReport as Report
from app.core.events import AssetOp
from app.core.mapping import MappingConfig, apply_mapping, validate_against_columns
from app.core.rowfilter import RowFilter, describe, filter_problems, matches, type_family
from app.core.runner import MappingSpec, RunnerManager
from app.core.state import InMemoryStateStore, StateStore


def F(column: str, op: str, value: Any = None) -> RowFilter:  # noqa: N802 - reads like a literal
    return RowFilter.model_validate({"column": column, "op": op, "value": value})


# -- matching and coercion -----------------------------------------------------


@pytest.mark.parametrize(
    ("record", "flt", "expected"),
    [
        ({"status": "open"}, F("status", "eq", "open"), True),
        ({"status": "done"}, F("status", "eq", "open"), False),
        ({"status": "done"}, F("status", "ne", "open"), True),
        ({"status": None}, F("status", "ne", "done"), True),  # empty is "not done"
        ({}, F("status", "ne", "done"), True),  # missing column behaves like empty
        ({"n": 5}, F("n", "eq", "5"), True),  # text value coerced to the number
        ({"n": 5.0}, F("n", "eq", 5), True),
        ({"n": 5}, F("n", "gt", "4.5"), True),
        ({"n": 5}, F("n", "lte", 4), False),
        ({"n": None}, F("n", "lt", 10), False),  # ordering never matches empty
        ({"n": 5}, F("n", "eq", "five"), False),  # not comparable: no match, no crash
        ({"code": "007"}, F("code", "eq", "7"), False),  # codes stay text for equality
        ({"code": "9"}, F("code", "lt", "10"), True),  # numeric text orders as numbers
        ({"on_shift": True}, F("on_shift", "eq", "true"), True),
        ({"on_shift": False}, F("on_shift", "eq", "yes"), False),
        ({"on_shift": True}, F("on_shift", "eq", True), True),
        ({"flag": "Y"}, F("flag", "eq", True), True),
        ({"t": "2026-10-07T10:00:00+00:00"}, F("t", "gt", "2026-10-07T09:00:00Z"), True),
        ({"t": "2026-10-07T10:00:00+02:00"}, F("t", "gt", "2026-10-07T09:00:00Z"), False),  # 08:00 UTC
        ({"t": "2026-10-07T10:00:00"}, F("t", "gte", "2026-10-07"), True),  # naive read as UTC
        ({"t": "2026-10-07"}, F("t", "eq", "2026-10-07T00:00:00Z"), True),
        ({"t": None}, F("t", "is_null"), True),
        ({"t": ""}, F("t", "is_null"), True),
        ({"t": "2026-10-07"}, F("t", "not_null"), True),
        ({"unit": "ICU"}, F("unit", "in", ["ER", "ICU"]), True),
        ({"unit": "ICU"}, F("unit", "in", "ER, ICU"), True),  # one comma-separated box
        ({"unit": "ICU"}, F("unit", "not_in", ["ER"]), True),
        ({"unit": None}, F("unit", "not_in", ["ER"]), True),
        ({"n": 3}, F("n", "in", ["1", "3"]), True),
        ({"name": "Dr. Okafor"}, F("name", "contains", "okaf"), True),  # case-insensitive
        ({"tags": ["a", "b"]}, F("tags", "contains", "b"), True),
        ({"name": None}, F("name", "contains", "x"), False),
        ({"name": "Zoë"}, F("name", "eq", "Zoë"), True),
        ({"big": 10**30}, F("big", "gt", "1e29"), True),
        ({"obj": {"a": 1}}, F("obj", "eq", "x"), False),
    ],
)
def test_matches(record: dict[str, Any], flt: RowFilter, expected: bool) -> None:
    assert matches(record, [flt]) is expected


def test_all_conditions_must_hold() -> None:
    fs = [F("status", "eq", "open"), F("done_at", "is_null")]
    assert matches({"status": "open", "done_at": None}, fs)
    assert not matches({"status": "open", "done_at": "2026-10-07T10:00:00Z"}, fs)
    assert matches({"anything": 1}, [])


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"column": "", "op": "eq", "value": 1}, "choose the column"),
        ({"column": "a", "op": "like", "value": 1}, "Input should be"),
        ({"column": "a", "op": "eq"}, "eq needs a value"),
        ({"column": "a", "op": "gt", "value": " "}, "gt needs a value"),
        ({"column": "a", "op": "eq", "value": [1, 2]}, "use in for several values"),
        ({"column": "a", "op": "in", "value": []}, "in needs a list"),
        ({"column": "a", "op": "in", "value": 3}, "in needs a list"),
        ({"column": "a", "op": "in", "value": [[1]]}, "plain values"),
        ({"column": "a", "op": "is_null", "value": "x"}, "doesn't take a value"),
        ({"column": "a", "op": "gt", "value": True}, "not true/false"),
    ],
)
def test_invalid_filters_say_what_is_wrong(body: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError) as e:
        RowFilter.model_validate(body)
    assert message in str(e.value)


def test_filter_problems_check_columns_and_types() -> None:
    types = {"n": "integer", "t": "timestamp with time zone", "b": "boolean", "s": "text", "x": "geometry"}
    assert filter_problems([F("n", "gt", "4"), F("t", "lt", "2026-10-07"), F("b", "eq", "no")], types) == []
    assert filter_problems([F("missing", "is_null")], types) == ["Filter column 'missing' isn't in this table"]
    assert "isn't a number" in filter_problems([F("n", "eq", "ten")], types)[0]
    assert "isn't a date" in filter_problems([F("t", "gt", "yesterday")], types)[0]
    assert "true or false" in filter_problems([F("b", "eq", "maybe")], types)[0]
    assert filter_problems([F("s", "eq", "anything"), F("x", "eq", "anything")], types) == []
    assert filter_problems([F("n", "in", ["1", "x"])], types) != []


def test_type_family() -> None:
    assert type_family("integer") == "number"
    assert type_family("numeric(5,1)") == "number"
    assert type_family("NUMBER") == "number"
    assert type_family("timestamp with time zone") == "time"
    assert type_family("DATETIME2") == "time"
    assert type_family("boolean") == "bool"
    assert type_family("tinyint") == "number"
    assert type_family("character varying") == "text"
    assert type_family("interval") is None
    assert type_family("") is None


def test_describe_in_plain_words() -> None:
    assert describe([]) == "All rows"
    assert describe([F("discharged_at", "is_null")]) == "Only rows where discharged_at is empty"
    assert (
        describe([F("status", "ne", "done"), F("on_shift", "eq", True), F("unit", "in", ["ER", "ICU"])])
        == 'Only rows where status is not "done" and on_shift is true and unit is one of "ER", "ICU"'
    )


def test_mapping_validation_includes_filter_columns() -> None:
    cfg = MappingConfig(id_field="id", filter=[F("gone", "is_null")])
    assert validate_against_columns(cfg, {"id"}) == ["Filter column 'gone' isn't in this table"]
    assert validate_against_columns(cfg, {"id": "int", "gone": "timestamp"}) == []
    # Old configs without a filter still load.
    assert MappingConfig.model_validate({"id_field": "id"}).filter == []


def test_apply_mapping_turns_a_non_matching_row_into_a_remove() -> None:
    cfg = MappingConfig(
        id_field="task_id", match_key="bed_id", fields={"state": "status"}, filter=[F("done_at", "is_null")]
    )
    up = Change(op=ChangeOp.UPSERT, dataset="t", key="B1", record={"task_id": 1, "bed_id": "B1", "status": "open"})
    out = Change(
        op=ChangeOp.UPSERT, dataset="t", key="B1", record={"task_id": 1, "bed_id": "B1", "done_at": "2026-10-07"}
    )
    kw = {"site_id": "s", "source_id": "src", "mapping_id": "m"}
    assert apply_mapping(up, cfg, **kw).op == AssetOp.UPSERT
    ev = apply_mapping(out, cfg, **kw)
    assert ev.op == AssetOp.REMOVE and ev.asset_id == "B1"


# -- runner: snapshots, polls and CDC ------------------------------------------

POLL_ROWS: dict[str, list[Record]] = {}
CDC_SCRIPTS: dict[str, asyncio.Queue[Change | None]] = {}


class FakePoll(PollingConnector):
    spec = ConnectorSpec(
        type="test_filter_poll", display_name="Fake poll", category=Category.DATABASE, modes=[Mode.POLL],
        settings_schema={"type": "object"},
    )  # fmt: skip

    async def test(self) -> Report:
        return Report.from_steps([], time.monotonic())

    async def discover(self) -> list[Dataset]:
        return []

    async def snapshot(self, dataset: str) -> list[Record]:
        return [dict(r) for r in POLL_ROWS[self.settings["table"]]]


class FakeCdc(Connector):
    """Initial rows, the marker, then whatever the test puts on its queue."""

    spec = ConnectorSpec(
        type="test_filter_cdc", display_name="Fake CDC", category=Category.DATABASE, modes=[Mode.CDC],
        settings_schema={"type": "object"},
    )  # fmt: skip

    async def test(self) -> Report:
        return Report.from_steps([], time.monotonic())

    async def discover(self) -> list[Dataset]:
        return []

    async def preview(self, dataset: str, limit: int = 20) -> list[Record]:
        return []

    async def stream(
        self, dataset: str, key_fields: list[str], options: dict[str, Any] | None = None
    ) -> AsyncIterator[Change]:
        # Deliberately ignores self.row_filter: the runner must still filter.
        for r in self.settings["initial"]:
            yield Change(op=ChangeOp.UPSERT, dataset=dataset, key=str(r[key_fields[0]]), record=r)
        yield snapshot_end(dataset)
        q = CDC_SCRIPTS[self.settings["script"]]
        while True:
            ch = await q.get()
            if ch is None:
                return
            yield ch


@pytest.fixture(autouse=True)
def fake_build(monkeypatch: pytest.MonkeyPatch) -> None:
    def build(type_: str, settings: dict[str, Any], secrets: dict[str, Any], source_id: str | None = None) -> Connector:
        cls = FakePoll if type_ == "test_filter_poll" else FakeCdc
        return cls(settings, secrets, source_id=source_id)

    monkeypatch.setattr("app.core.runner.build", build)


def mspec(type_: str, settings: dict[str, Any], config: MappingConfig, mapping_id: str = "m1") -> MappingSpec:
    return MappingSpec(
        mapping_id=mapping_id, site_id="s", source_id="src", source_type=type_, settings=settings, secrets={},
        dataset="t", config=config, options={"poll_interval_s": 0.5},
    )  # fmt: skip


async def eventually(store: StateStore, expected: dict[str, Any], field: str = "state", within: float = 6.0) -> None:
    started = time.monotonic()
    got: dict[str, Any] = {}
    while time.monotonic() - started < within:
        got = {a.asset_id: a.flat().get(field) for a in await store.site_assets("s")}
        if got == expected:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"expected {expected}, got {got}")


VISITS = MappingConfig(
    id_field="visit_id", match_key="bed_id", fields={"label": "patient"}, filter=[F("discharged_at", "is_null")]
)


async def test_poll_filter_keeps_the_open_row_when_a_closed_one_shares_its_key() -> None:
    # Two visits for bed B1: the closed one comes last. Without filtering before
    # keying, the closed row would hide the open one.
    POLL_ROWS["visits"] = [
        {"visit_id": 2, "bed_id": "B1", "patient": "P-2", "discharged_at": None},
        {"visit_id": 1, "bed_id": "B1", "patient": "P-1", "discharged_at": "2026-10-06T10:00:00Z"},
        {"visit_id": 3, "bed_id": "B2", "patient": "P-3", "discharged_at": "2026-10-06T11:00:00Z"},
        {"visit_id": 4, "bed_id": None, "patient": "P-4", "discharged_at": "2026-10-06T11:00:00Z"},
    ]
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    await rm.start(mspec("test_filter_poll", {"table": "visits"}, VISITS))
    await eventually(store, {"B1": "P-2"}, "label")
    # A keyless row that the filter excludes isn't counted as skipped.
    assert rm.health["m1"].as_dict()["skipped_records"] == 0

    # Discharge P-2 (stops matching -> removed), admit P-5 to B2 (starts matching -> added).
    POLL_ROWS["visits"] = [
        {"visit_id": 2, "bed_id": "B1", "patient": "P-2", "discharged_at": "2026-10-07T09:00:00Z"},
        {"visit_id": 1, "bed_id": "B1", "patient": "P-1", "discharged_at": "2026-10-06T10:00:00Z"},
        {"visit_id": 3, "bed_id": "B2", "patient": "P-3", "discharged_at": "2026-10-06T11:00:00Z"},
        {"visit_id": 5, "bed_id": "B2", "patient": "P-5", "discharged_at": None},
    ]
    await eventually(store, {"B2": "P-5"}, "label")
    await rm.stop_all()


def cdc_change(rec: Record, op: ChangeOp = ChangeOp.UPSERT) -> Change:
    return Change(op=op, dataset="t", key=str(rec["bed_id"]), record=rec if op == ChangeOp.UPSERT else {})


async def test_cdc_updates_move_rows_into_and_out_of_the_filter() -> None:
    tasks = MappingConfig(
        id_field="task_id", match_key="bed_id", fields={"state": "status"}, state_map={"open": "cleaning"},
        filter=[F("status", "ne", "done")],
    )  # fmt: skip
    q: asyncio.Queue[Change | None] = asyncio.Queue()
    CDC_SCRIPTS["tasks"] = q
    initial = [
        {"task_id": 1, "bed_id": "B1", "status": "open"},
        {"task_id": 2, "bed_id": "B2", "status": "done"},
    ]
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    await rm.start(mspec("test_filter_cdc", {"initial": initial, "script": "tasks"}, tasks))
    await eventually(store, {"B1": "cleaning"})

    await q.put(cdc_change({"task_id": 1, "bed_id": "B1", "status": "done"}))  # update out of the filter
    await eventually(store, {})
    await q.put(cdc_change({"task_id": 3, "bed_id": "B3", "status": "open"}))  # insert into the filter
    await q.put(cdc_change({"task_id": 2, "bed_id": "B2", "status": "open"}))  # update into the filter
    await eventually(store, {"B2": "cleaning", "B3": "cleaning"})
    await q.put(cdc_change({"task_id": 2, "bed_id": "B2", "status": "done"}))
    await q.put(cdc_change({"bed_id": "B3"}, ChangeOp.DELETE))
    await eventually(store, {})
    # Not-matching changes for rows that were never shown are harmless.
    await q.put(cdc_change({"task_id": 9, "bed_id": "B9", "status": "done"}))
    await q.put(cdc_change({"task_id": 4, "bed_id": "B4", "status": "open"}))
    await eventually(store, {"B4": "cleaning"})
    assert rm.health["m1"].skipped_records == 0
    await q.put(None)
    await rm.stop_all()


async def test_attached_filter_only_removes_its_own_fields_and_reconcile_respects_it() -> None:
    """An attached mapping (cleaning tasks on beds) that stops matching drops its
    own fields; the bed from the other mapping stays. On restart, the snapshot
    reconcile removes contributions whose rows no longer match."""
    POLL_ROWS["beds"] = [{"bed_id": "B1", "status": "free"}, {"bed_id": "B2", "status": "free"}]
    beds = MappingConfig(id_field="bed_id", fields={"state": "status"}, kind="bed")
    tasks = MappingConfig(
        id_field="task_id", match_key="bed_id", fields={"cleaning": "status"}, filter=[F("done_at", "is_null")]
    )
    q: asyncio.Queue[Change | None] = asyncio.Queue()
    CDC_SCRIPTS["evs"] = q
    initial = [{"task_id": 1, "bed_id": "B1", "status": "open", "done_at": None}]
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    await rm.start(mspec("test_filter_poll", {"table": "beds"}, beds, "beds"))
    await rm.start(mspec("test_filter_cdc", {"initial": initial, "script": "evs"}, tasks, "tasks"))
    await eventually(store, {"B1": "open", "B2": None}, "cleaning")

    # Restart the task mapping: task 1 was finished while it was down.
    await rm.stop("tasks", clear=False)
    q2: asyncio.Queue[Change | None] = asyncio.Queue()
    CDC_SCRIPTS["evs"] = q2
    finished = [{"task_id": 1, "bed_id": "B1", "status": "done", "done_at": "2026-10-07T10:00:00Z"}]
    await rm.start(mspec("test_filter_cdc", {"initial": finished, "script": "evs"}, tasks, "tasks"))
    await eventually(store, {"B1": None, "B2": None}, "cleaning")
    await eventually(store, {"B1": "free", "B2": "free"})  # the beds are untouched
    await q.put(None)
    await q2.put(None)
    await rm.stop_all()


async def test_snapshot_skips_non_matching_rows_without_removing_matching_ones() -> None:
    """CDC initial state with a closed row *after* the open row of the same key."""
    q: asyncio.Queue[Change | None] = asyncio.Queue()
    CDC_SCRIPTS["visits"] = q
    initial = [
        {"visit_id": 2, "bed_id": "B1", "patient": "P-2", "discharged_at": None},
        {"visit_id": 1, "bed_id": "B1", "patient": "P-1", "discharged_at": "2026-10-06T10:00:00Z"},
    ]
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    await rm.start(mspec("test_filter_cdc", {"initial": initial, "script": "visits"}, VISITS))
    await eventually(store, {"B1": "P-2"}, "label")
    await asyncio.sleep(0.2)
    await eventually(store, {"B1": "P-2"}, "label")
    assert rm.health["m1"].status == "running"
    await q.put(None)
    await rm.stop_all()


async def test_an_update_to_an_old_closed_row_keeps_the_current_rows_details() -> None:
    """Two visits share bed B1: an update to the old, already-closed one must not
    wipe what the open one shows; closing the open one does remove it."""
    q: asyncio.Queue[Change | None] = asyncio.Queue()
    CDC_SCRIPTS["visits-old"] = q
    initial = [
        {"visit_id": 1, "bed_id": "B1", "patient": "P-1", "discharged_at": "2026-10-06T10:00:00Z"},
        {"visit_id": 2, "bed_id": "B1", "patient": "P-2", "discharged_at": None},
    ]
    store = InMemoryStateStore()
    rm = RunnerManager(store)
    await rm.start(mspec("test_filter_cdc", {"initial": initial, "script": "visits-old"}, VISITS))
    await eventually(store, {"B1": "P-2"}, "label")

    # Someone corrects the old visit's discharge time: still closed, still hidden.
    await q.put(cdc_change({"visit_id": 1, "bed_id": "B1", "patient": "P-1", "discharged_at": "2026-10-06T11:00:00Z"}))
    # A marker change after it, so we know the old-row update was processed.
    await q.put(cdc_change({"visit_id": 3, "bed_id": "B9", "patient": "P-9", "discharged_at": None}))
    await eventually(store, {"B1": "P-2", "B9": "P-9"}, "label")

    # A second open visit for B1 takes over; closing the first one no longer matters.
    await q.put(cdc_change({"visit_id": 4, "bed_id": "B1", "patient": "P-4", "discharged_at": None}))
    await eventually(store, {"B1": "P-4", "B9": "P-9"}, "label")
    await q.put(cdc_change({"visit_id": 2, "bed_id": "B1", "patient": "P-2", "discharged_at": "2026-10-07T09:00:00Z"}))
    await q.put(cdc_change({"visit_id": 5, "bed_id": "B8", "patient": "P-8", "discharged_at": None}))
    await eventually(store, {"B1": "P-4", "B8": "P-8", "B9": "P-9"}, "label")

    # Closing the row that is shown removes it.
    await q.put(cdc_change({"visit_id": 4, "bed_id": "B1", "patient": "P-4", "discharged_at": "2026-10-07T10:00:00Z"}))
    await eventually(store, {"B8": "P-8", "B9": "P-9"}, "label")
    await q.put(None)
    await rm.stop_all()
