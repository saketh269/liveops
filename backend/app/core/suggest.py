"""Suggested mappings for a source (ADR 0006).

Looks only at what every connector provides: ``discover()`` (datasets, column
names and types, primary keys) and a small ``preview()`` sample per dataset.
No source-specific SQL, so it works for databases, files and APIs alike.

What it proposes, per dataset:

- **Things on the map**: rows that have a location (a unit, ward, zone, room,
  ``dest_*`` column...) and an identifier. Proposes zone, state (with a
  ``state_map`` built from the sample values), label, role and a kind guessed
  from the table and column names.
- **Details for another mapping** (``attach_to``): rows that refer to a thing by
  its id (``bed_id``) but have no location of their own, such as visits,
  cleaning tasks or rounds. They merge into that thing through ``match_key``.
- **Current rows only** (``filter``): history tables (an end time such as
  ``discharged_at``/``done_at``, a status such as ``done``, or an ``on_shift``
  flag) get a filter that keeps only current rows.
- **Skipped**, with a reason: one-row-per-area totals, queues and event logs
  without a location (counts, not things), tables without an identifier, and
  tables already mapped on the site. Skipped suggestions have ``config=None``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

from app.connectors.base import Dataset, Record
from app.core.mapping import MappingConfig
from app.core.rowfilter import RowFilter, describe, type_family


class AttachTarget(BaseModel):
    """The mapping a suggestion adds details to: an existing mapping on the site
    (``mapping_id``) or another suggestion in the same list (``dataset`` only)."""

    dataset: str
    mapping_id: str | None = None
    match_key: str


class Suggestion(BaseModel):
    dataset: str
    config: MappingConfig | None  # None: skipped (see reason)
    filter: list[RowFilter] | None = None  # same as config.filter, for display
    reason: str
    confidence: float
    attach_to: AttachTarget | None = None


@dataclass
class ExistingMapping:
    """A mapping already on the site (any source)."""

    mapping_id: str
    source_id: str
    dataset: str
    key_field: str
    kind: str | None = None
    attached: bool = False  # adds details to another mapping (match_key differs from id_field)


# --------------------------------------------------------------------------
# Name heuristics
# --------------------------------------------------------------------------

_ZONE_EXACT = re.compile(
    r"^(unit|ward|zone|location|loc|room|dept|department|area|bay|floor|site|dock|aisle|field|"
    r"current_(unit|ward|zone|location|room|area|dept)|station|depot|building)$",
    re.I,
)
_ZONE_SUFFIX = re.compile(r"_(unit|ward|zone|location|room|dept|department|area|bay|station)$", re.I)
_ZONE_DEST = re.compile(r"^(dest|destination|to|target)_", re.I)
_STATUS_EXACT = re.compile(r"^(status|state)$", re.I)
_STATUS_LIKE = re.compile(r"^(.+_status|.+_state|availability|condition)$", re.I)
_LABEL_EXACT = re.compile(r"^(name|label|title|display_name|full_name)$", re.I)
_LABEL_LIKE = re.compile(r"^.+_(name|label|title)$", re.I)
_ROLE = re.compile(r"^(role|job|job_title|position|discipline|profession|staff_type|grade)$", re.I)
_HOUSEKEEPING = re.compile(
    r"^(updated|modified|created|inserted|last_modified|last_updated|changed)(_at|_on|_ts|_time|_date)?$", re.I
)
_END_TIME = re.compile(
    r"^(discharged|discharge|done|closed|ended|end|completed|finished|resolved|cancell?ed|departed|left|"
    r"checked_out|checkout|released|returned|stopped|expired|deleted|archived|removed|valid_to|effective_to)"
    r"(_at|_time|_ts|_on|_date|_datetime)?$",
    re.I,
)
_ACTIVE_FLAG = re.compile(
    r"^(is_)?(active|current|on_shift|onshift|on_duty|present|enabled|in_service|on_site|checked_in)$", re.I
)
_EVENTISH = re.compile(r"(queue|log|event|history|audit|message|notification|journal|arrival|request)", re.I)
_TOTALS = re.compile(r"(census|count|total|summary|capacity|stats?|aggregate|kpi|metric)", re.I)

CLOSED_VALUES = {
    "done", "closed", "complete", "completed", "finished", "resolved", "cancelled", "canceled", "discharged",
    "inactive", "archived", "ended", "expired", "deleted", "removed",
}  # fmt: skip

STATE_VOCAB: dict[str, str] = {
    **dict.fromkeys(
        ["free", "available", "vacant", "idle", "ready", "empty", "clean", "unoccupied", "standby", "at_station"],
        "free",
    ),
    **dict.fromkeys(
        [
            "occupied",
            "busy",
            "in_use",
            "inuse",
            "inbound",
            "en_route",
            "enroute",
            "dispatched",
            "responding",
            "transporting",
            "on_scene",
            "arrived",
            "assigned",
            "engaged",
            "active",
            "in_progress",
            "outbound",
        ],
        "in_use",
    ),  # fmt: skip
    **dict.fromkeys(
        ["cleaning", "dirty", "maintenance", "turnover", "housekeeping", "being_cleaned", "needs_cleaning", "repair"],
        "cleaning",
    ),
    **dict.fromkeys(
        ["alert", "error", "blocked", "alarm", "fault", "offline", "out_of_service", "down", "critical", "broken"],
        "alert",
    ),
}

KINDS: list[tuple[str, tuple[str, ...]]] = [
    ("bed", ("bed", "cot", "stretcher", "gurney")),
    ("patient", ("patient", "encounter", "admission", "visit", "inpatient")),
    ("ambulance", ("ambulance", "ems", "paramedic")),
    ("vehicle", ("vehicle", "truck", "van", "fleet", "car", "trailer", "forklift", "lorry", "tractor")),
    ("staff", ("staff", "roster", "employee", "nurse", "doctor", "clinician", "worker", "personnel", "crew",
               "driver", "technician", "porter", "cleaner", "physician", "people", "person", "shift")),
    ("equipment", ("equipment", "device", "pump", "monitor", "ventilator", "wheelchair", "asset", "tool",
                   "machine", "scanner", "infusion")),
]  # fmt: skip


NOUNS = {"staff": "staff member", "equipment": "piece of equipment"}
PLURALS = {"staff": "staff members", "equipment": "equipment"}


def _tokens(name: str) -> list[str]:
    base = name.rsplit(".", 1)[-1] if "." in name and not name.lower().endswith((".csv", ".json", ".xlsx")) else name
    base = re.sub(r"\.(csv|json|xlsx|xls|parquet|txt)$", "", base, flags=re.I)
    return [t for t in re.split(r"[^a-z0-9]+", base.lower()) if t]


def _singular(word: str) -> str:
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith(("ses", "xes", "ches", "shes")):
        return word[:-2]
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        return word[:-1]
    return word


def table_base(name: str) -> str:
    """'epic.adt_beds' -> 'adt_beds'; 'files/beds.csv' -> 'beds'."""
    return "_".join(_tokens(name.split("/")[-1]))


def guess_kind(dataset: str, extra: Sequence[str] = ()) -> str | None:
    words = [_singular(t) for t in _tokens(dataset.split("/")[-1])]
    for n in extra:
        words += [_singular(t) for t in re.split(r"[^a-z0-9]+", n.lower()) if t]
    for w in words:
        for kind, keys in KINDS:
            if any(w == k or w.startswith(k) for k in keys):
                return kind
    return None


def _norm_value(v: Any) -> str:
    return re.sub(r"[\s\-]+", "_", str(v).strip().lower())


def propose_state_map(values: Sequence[Any]) -> tuple[dict[str, str], int]:
    """``{raw: map state}`` for sample values we recognise (identity entries
    left out), and how many distinct values were not recognised."""
    out: dict[str, str] = {}
    unknown = 0
    for raw in dict.fromkeys(str(v) for v in values if v is not None and str(v).strip() != ""):
        to = STATE_VOCAB.get(_norm_value(raw))
        if to is None:
            unknown += 1
        elif to != raw:
            out[raw] = to
    return out, unknown


def _a(word: str) -> str:
    return f"an {word}" if word[:1] in "aeiou" else f"a {word}"


# --------------------------------------------------------------------------
# Per-dataset analysis
# --------------------------------------------------------------------------


@dataclass
class _Info:
    ds: Dataset
    rows: list[Record]
    types: dict[str, str]
    id_col: str | None
    zone: str | None
    zone_rank: int
    state: str | None
    label: str | None
    filters: list[RowFilter] = field(default_factory=list)
    filter_note: str = ""

    @property
    def name(self) -> str:
        return self.ds.name


def _values(rows: list[Record], col: str) -> list[Any]:
    return [r.get(col) for r in rows if isinstance(r, dict)]


def _first(cols: Sequence[str], *patterns: re.Pattern[str], skip: Sequence[str | None] = ()) -> str | None:
    for p in patterns:
        for c in cols:
            if c not in skip and p.search(c):
                return c
    return None


def _zone(cols: Sequence[str], skip: Sequence[str | None]) -> tuple[str | None, int]:
    for rank, test in enumerate(
        (
            lambda c: bool(_ZONE_EXACT.search(c)),
            lambda c: bool(_ZONE_SUFFIX.search(c)) and not _ZONE_DEST.search(c),
            lambda c: bool(_ZONE_DEST.search(c)) and bool(_ZONE_SUFFIX.search(c)),
        )
    ):
        for c in cols:
            if c not in skip and test(c):
                return c, rank
    return None, -1


def _id_column(ds: Dataset, rows: list[Record]) -> str | None:
    if len(ds.primary_key) == 1:
        return ds.primary_key[0]
    if ds.primary_key:
        return None  # composite keys: the mapping needs one ID column, let the user choose
    cols = [c.name for c in ds.columns]
    base = _singular(table_base(ds.name).split("_")[-1]) if table_base(ds.name) else ""
    candidates = [c for c in cols if c.lower() == "id"] + [c for c in cols if base and c.lower() == f"{base}_id"]
    candidates += [c for c in cols if re.search(r"(_id|_no|_number|_code|_ref)$", c, re.I) and c not in candidates]
    for c in candidates:
        vals = _values(rows, c)
        if not rows or (all(v not in (None, "") for v in vals) and len(set(map(str, vals))) == len(vals)):
            return c
    return None


def _current_filter(info: _Info) -> None:
    """Filters that keep only current rows of a history table."""
    cols = [c.name for c in info.ds.columns]
    nullable = {c.name: c.nullable for c in info.ds.columns}
    for c in cols:
        fam = type_family(info.types[c])
        if _END_TIME.search(c) and nullable[c] and fam in ("time", None):
            info.filters = [RowFilter(column=c, op="is_null")]
            info.filter_note = "older rows are history"
            return
    if info.state:
        seen = {str(v) for v in _values(info.rows, info.state) if v is not None}
        closed = sorted(v for v in seen if _norm_value(v) in CLOSED_VALUES)
        if closed and len(closed) < len(seen):
            info.filters = [
                RowFilter(column=info.state, op="ne", value=closed[0])
                if len(closed) == 1
                else RowFilter(column=info.state, op="not_in", value=closed)
            ]
            info.filter_note = "finished rows are history"
            return
    for c in cols:
        vals = [v for v in _values(info.rows, c) if v is not None]
        is_bool = type_family(info.types[c]) == "bool" or (vals and all(isinstance(v, bool) for v in vals))
        if _ACTIVE_FLAG.search(c) and is_bool:
            info.filters = [RowFilter(column=c, op="eq", value=True)]
            info.filter_note = "inactive rows are hidden"
            return


def _analyse(ds: Dataset, rows: list[Record]) -> _Info:
    cols = [c.name for c in ds.columns]
    id_col = _id_column(ds, rows)
    zone, zone_rank = _zone(cols, skip=[])
    state = _first(cols, _STATUS_EXACT, _STATUS_LIKE, skip=[id_col, zone])
    label = _first(cols, _LABEL_EXACT, _LABEL_LIKE, skip=[id_col, zone, state])
    info = _Info(ds, rows, {c.name: c.type for c in ds.columns}, id_col, zone, zone_rank, state, label)
    _current_filter(info)
    return info


# --------------------------------------------------------------------------
# Building suggestions
# --------------------------------------------------------------------------


def _skip(ds: Dataset, reason: str) -> Suggestion:
    return Suggestion(dataset=ds.name, config=None, reason=reason, confidence=0.0)


def _attributes(info: _Info, used: set[str], limit: int) -> list[str]:
    filtered = {f.column for f in info.filters}
    out = [
        c.name
        for c in info.ds.columns
        if c.name not in used and c.name not in filtered and not _HOUSEKEEPING.search(c.name)
    ]
    return out[:limit]


def _thing(info: _Info) -> Suggestion:
    assert info.id_col and info.zone
    cols = [c.name for c in info.ds.columns]
    kind = guess_kind(info.name, [info.id_col])
    fields: dict[str, str] = {"zone": info.zone}
    state_map: dict[str, str] = {}
    confidence = 0.45 + (0.2 if info.zone_rank == 0 else 0.1)
    unknown = 0
    if info.state:
        fields["state"] = info.state
        state_map, unknown = propose_state_map(_values(info.rows, info.state))
        confidence += 0.15 if unknown == 0 else 0.05
    if info.label:
        fields["label"] = info.label
        confidence += 0.05
    if kind in ("staff", "patient"):
        role = _first(cols, _ROLE, skip=list(fields.values()) + [info.id_col])
        if role:
            fields["role"] = role
    if kind:
        confidence += 0.1
    used = {info.id_col, *fields.values()}
    config = MappingConfig(
        id_field=info.id_col,
        fields=fields,
        state_map=state_map,
        attributes=_attributes(info, used, 4),
        kind=kind,
        filter=info.filters,
    )
    what = NOUNS.get(kind or "", kind or "record")
    reason = f"Each row is {_a(what)} with a place on the map ({info.zone})"
    if info.state:
        reason += f" and a status ({info.state})"
        if unknown:
            reason += "; 1 status value needs a color" if unknown == 1 else f"; {unknown} status values need a color"
    reason += "."
    if info.filters:
        reason += f" {describe(info.filters)} ({info.filter_note})."
    return Suggestion(
        dataset=info.name,
        config=config,
        filter=info.filters or None,
        reason=reason,
        confidence=round(min(confidence, 0.95), 2),
    )


@dataclass
class _Target:
    dataset: str
    key: str  # the thing's id column, which becomes the match key
    kind: str | None
    mapping_id: str | None = None


def _reference(info: _Info, targets: list[_Target]) -> tuple[str, _Target] | None:
    """A column of this dataset that holds the id of a thing on the map."""
    cols = [c.name for c in info.ds.columns if c.name != info.zone]
    for t in targets:
        if t.dataset == info.name:
            continue
        names = {t.key.lower()}
        if t.key.lower() == "id":
            names.add(f"{_singular(table_base(t.dataset).split('_')[-1])}_id")
        for c in cols:
            if c.lower() in names:
                return c, t
    return None


def _attach(info: _Info, ref: str, target: _Target) -> Suggestion:
    id_col = info.id_col or ref
    config = MappingConfig(
        id_field=id_col,
        match_key=ref,
        attributes=_attributes(info, {id_col, ref}, 6),
        filter=info.filters,
    )
    things = PLURALS.get(target.kind or "", f"{target.kind}s" if target.kind else "records")
    reason = f"Rows refer to {things} in {target.dataset} by {ref}, so they add details to those {things}"
    reason += " instead of new things on the map."
    if info.filters:
        reason += f" {describe(info.filters)} ({info.filter_note})."
    confidence = 0.6 + (0.15 if info.filters else 0.05) + (0.1 if target.mapping_id or target.kind else 0.0)
    return Suggestion(
        dataset=info.name,
        config=config,
        filter=info.filters or None,
        reason=reason,
        confidence=round(min(confidence, 0.9), 2),
        attach_to=AttachTarget(dataset=target.dataset, mapping_id=target.mapping_id, match_key=ref),
    )


def _skip_reason(info: _Info) -> str:
    base = table_base(info.name)
    if info.zone and info.ds.primary_key == [info.zone]:
        return (
            f"One row per {info.zone} with totals: counts for an area, not things on the map. Use live counts instead."
        )
    if _EVENTISH.search(base) or _TOTALS.search(base):
        return "A queue or log with no location: counts, not things on the map. Use live counts instead."
    return "No column says where each record is, so it can't be placed on the map. Map it by hand if one does."


def preview_priority(ds: Dataset) -> int:
    """Sort key: tables most likely to be suggested first, so a limited sample
    budget is spent on them."""
    names = [c.name for c in ds.columns]
    return -sum(
        (
            any(_ZONE_EXACT.search(n) or _ZONE_SUFFIX.search(n) for n in names),
            any(_STATUS_EXACT.search(n) or _STATUS_LIKE.search(n) for n in names),
            any(n.lower().endswith("_id") for n in names),
        )
    )


def suggest(
    datasets: Sequence[Dataset],
    samples: dict[str, list[Record]],
    *,
    source_id: str | None = None,
    existing: Sequence[ExistingMapping] = (),
) -> list[Suggestion]:
    """Suggestions for every dataset, best first; skipped datasets last."""
    infos = [_analyse(ds, samples.get(ds.name, [])) for ds in datasets]
    mapped_here = {m.dataset for m in existing if m.source_id == source_id}

    things: dict[str, Suggestion] = {}
    for info in infos:
        if info.name in mapped_here or not info.zone or not info.id_col:
            continue
        if info.ds.primary_key == [info.zone]:
            continue  # one row per area: totals, not things
        things[info.name] = _thing(info)

    # Anything already on the site can be attached to, whichever source feeds it.
    targets = [_Target(m.dataset, m.key_field, m.kind, m.mapping_id) for m in existing if not m.attached]
    targets += [_Target(name, s.config.id_field, s.config.kind) for name, s in things.items() if s.config is not None]

    out: list[Suggestion] = []
    skipped: list[Suggestion] = []
    for info in infos:
        if info.name in mapped_here:
            skipped.append(_skip(info.ds, "Already mapped on this site."))
        elif info.name in things:
            out.append(things[info.name])
        elif (ref := _reference(info, targets)) is not None:
            out.append(_attach(info, *ref))
        elif info.zone and not info.id_col and info.ds.primary_key != [info.zone]:
            skipped.append(_skip(info.ds, "No column identifies each record. Map it by hand and choose an ID column."))
        else:
            skipped.append(_skip(info.ds, _skip_reason(info)))
    # Things before the details that attach to them; then by confidence.
    out.sort(key=lambda s: (s.attach_to is not None, -s.confidence, s.dataset))
    return out + sorted(skipped, key=lambda s: s.dataset)
