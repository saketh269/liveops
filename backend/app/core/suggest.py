"""Suggested mappings for a source (ADR 0006).

Looks only at what every connector provides: ``discover()`` (datasets, column
names and types, primary keys) and a small ``preview()`` sample per dataset.
No source-specific SQL, so it works for databases, files and APIs alike.

What it proposes, per dataset:

- **Things on the map**: rows that have a location (a unit, ward, zone, room,
  ``dest_*`` column...) and an identifier. Proposes zone, state (a ``state_map``
  only for sample values with a clear meaning; the rest are named in the reason),
  label, role, and a kind guessed from the names or read from a column whose
  values are kinds (``person_type`` = patient | staff). People that point at a
  thing (a patient's ``bed_id``) get ``anchor``.
- **Details for another mapping** (``attach_to``): rows that refer to a thing
  through ``match_key``. A reference is confirmed by values, not names: at least
  half of the column's sampled values must be key values of the other table
  (a shared specific name such as ``bed_id`` counts only when one side has no
  sample; a bare ``id`` never does). Tasks and history about a thing (an end time
  such as ``done_at``, a finished status) and tables of the same things joined
  by their own key (a roster of the tracked staff) attach even when they have a
  location, so nothing is drawn twice. References through a person column
  (``patient_ref``, ``staff_id``) prefer a table of people.
- **Current rows only** (``filter``): history tables get a filter that keeps
  only current rows (``discharged_at`` empty, status not done, ``on_shift``).
- **Skipped**, with a reason: one-row-per-area totals, queues and logs (counts,
  not things), tables without an identifier or a location, and tables already
  mapped on the site. Skipped suggestions have ``config=None``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

from app.connectors.base import Dataset, Record
from app.core.mapping import MappingConfig
from app.core.rowfilter import RowFilter, describe, matches, type_family


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
# Whole words of a table name (``triage_queue``, ``unit_census``), never parts of words (``encounters``).
_EVENTISH = {"queue", "log", "event", "history", "audit", "message", "notification", "journal", "arrival", "request"}
_TOTALS = {"census", "count", "total", "summary", "capacity", "stat", "aggregate", "kpi", "metric"}


def _counts_name(name: str) -> bool:
    words = {_singular(t) for t in _tokens(name.split("/")[-1])}
    return bool(words & (_EVENTISH | _TOTALS))


CLOSED_VALUES = {
    "done", "closed", "complete", "completed", "finished", "resolved", "cancelled", "canceled", "discharged",
    "inactive", "archived", "ended", "expired", "deleted", "removed",
}  # fmt: skip

STATE_VOCAB: dict[str, str] = {
    **dict.fromkeys(
        [
            "free",
            "available",
            "vacant",
            "idle",
            "ready",
            "empty",
            "clean",
            "unoccupied",
            "standby",
            "station",
            "at_station",
            "on_station",
        ],
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
            "assigned",
            "engaged",
            "active",
            "in_progress",
            "outbound",
            "in_bed",
            "seeing_patient",
            "with_patient",
            "rounds",
            "on_rounds",
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


def propose_state_map(values: Sequence[Any]) -> tuple[dict[str, str], list[str]]:
    """``{raw: map state}`` for sample values with a clear meaning (identity
    entries left out), and the distinct values left for the user to choose."""
    out: dict[str, str] = {}
    unknown: list[str] = []
    for raw in dict.fromkeys(str(v) for v in values if v is not None and str(v).strip() != ""):
        to = STATE_VOCAB.get(_norm_value(raw))
        if to is None:
            unknown.append(raw)
        elif to != raw:
            out[raw] = to
    return out, unknown


def _a(word: str) -> str:
    return f"an {word}" if word[:1] in "aeiou" else f"a {word}"


# --------------------------------------------------------------------------
# Per-dataset analysis
# --------------------------------------------------------------------------

# Column names that may hold an identifier (and so may refer to another table).
_IDLIKE = re.compile(r"(^|_)(id|ref|key|code|no|number|num|tag|uuid|guid|mrn)$", re.I)
# Names too generic to be a reference by name alone (``id`` is in every table).
_GENERIC = {"id", "key", "code", "no", "number", "num", "ref", "uuid", "guid", "tag"}
# A column naming a person: references through it prefer a table of people.
_PERSONISH = re.compile(r"(patient|person|people|staff|employee|member|user|resident|worker|nurse|doctor)", re.I)
_KINDCOL_NAME = re.compile(r"(^|_)(type|kind|category|class|group)$", re.I)
PERSON_KINDS = {"patient", "staff", "person"}
# Values that name a kind of thing (``person_type`` = patient | staff).
KIND_WORDS: dict[str, str] = {w: kind for kind, words in KINDS for w in (*words, kind)}
KIND_WORDS.update({"person": "person", "people": "person", "visitor": "person", "guest": "person"})

MIN_OVERLAP = 0.5  # share of a column's sampled values that must be keys of the other table


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
    kind_col: str | None = None
    filters: list[RowFilter] = field(default_factory=list)
    filter_note: str = ""
    history: bool = False  # an end time or a finished status: rows are tasks/visits, not standing things
    identity: list[str] = field(default_factory=list)  # columns whose values identify a row

    @property
    def name(self) -> str:
        return self.ds.name

    @property
    def current_rows(self) -> list[Record]:
        """Sample rows the filter keeps (all rows if it keeps none: still useful for overlap)."""
        if not self.filters:
            return self.rows
        kept = [r for r in self.rows if matches(r, self.filters)]
        return kept or self.rows

    @property
    def kind(self) -> str | None:
        return guess_kind(self.name, [self.id_col] if self.id_col else [])

    @property
    def person_like(self) -> bool:
        if self.kind_col:
            kinds = {KIND_WORDS.get(_norm_value(v)) for v in _values(self.rows, self.kind_col) if v is not None}
            return bool(kinds) and kinds <= {*PERSON_KINDS, "staff"}
        return self.kind in PERSON_KINDS


def _values(rows: list[Record], col: str) -> list[Any]:
    return [r.get(col) for r in rows if isinstance(r, dict)]


def _keyset(rows: list[Record], col: str) -> set[str]:
    return {str(v) for v in _values(rows, col) if v is not None and str(v).strip() != ""}


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


def _unique(rows: list[Record], col: str) -> bool:
    vals = [v for v in _values(rows, col) if v not in (None, "")]
    return bool(vals) and len(vals) >= 0.9 * len(rows) and len(set(map(str, vals))) == len(vals)


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
        if not rows or _unique(rows, c):
            return c
    return None


def _kind_column(info: _Info, cols: Sequence[str]) -> str | None:
    """A column whose values are kinds of things (patient, staff, vehicle...)."""
    skip = {info.id_col, info.zone, info.state, info.label}
    ordered = sorted(cols, key=lambda c: not _KINDCOL_NAME.search(c))
    for c in ordered:
        if c in skip or _ROLE.search(c) or type_family(info.types[c]) not in ("text", None):
            continue
        vals = [_norm_value(v) for v in _values(info.rows, c) if v not in (None, "")]
        distinct = set(vals)
        if not vals or len(distinct) > 8:
            continue
        if sum(v in KIND_WORDS for v in vals) >= 0.8 * len(vals) and len({KIND_WORDS.get(v) for v in distinct}) >= 1:
            # A single repeated value is a constant kind, not a kind column, unless the name says so.
            if len(distinct) > 1 or _KINDCOL_NAME.search(c):
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
            info.history = True
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
            info.history = True
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
    info.kind_col = _kind_column(info, cols)
    current = info.current_rows
    info.identity = [
        c
        for c in cols
        if (c in ds.primary_key and len(ds.primary_key) == 1) or (_IDLIKE.search(c) and current and _unique(current, c))
    ]
    if id_col and id_col not in info.identity:
        info.identity.insert(0, id_col)
    return info


# --------------------------------------------------------------------------
# References between tables, confirmed by sample values
# --------------------------------------------------------------------------


@dataclass
class _Target:
    """A thing on the map that other rows can add details to."""

    dataset: str
    keys: dict[str, set[str] | None]  # identifying column -> sampled values (None: no sample)
    kind: str | None
    person_like: bool = False
    mapping_id: str | None = None  # an existing mapping on the site
    info: _Info | None = None
    match_col: str | None = None  # the identifying column others join on (becomes the asset id)


@dataclass
class _Edge:
    col: str  # column in the referring table
    target: _Target
    key: str  # identifying column of the target
    overlap: float  # share of sampled values found among the target's keys (1.0 for a name match)
    by_name: bool = False

    def rank(self, specific: set[str]) -> tuple[bool, bool, float, bool]:
        return (
            bool(_PERSONISH.search(self.col)) and self.target.person_like,
            self.col.lower() == self.key.lower(),
            self.overlap,
            self.target.dataset in specific,
        )


def _ref_columns(info: _Info) -> list[str]:
    out = []
    for c in (c.name for c in info.ds.columns):
        if c.lower() in _GENERIC or c in (info.zone, info.state, info.label, info.kind_col):
            continue
        fam = type_family(info.types[c])
        if fam in ("time", "bool") or _HOUSEKEEPING.search(c):
            continue
        if fam == "number" and not _IDLIKE.search(c):
            continue  # small numbers (acuity, counts) overlap with any integer key by chance
        out.append(c)
    return out


def _edges(info: _Info, targets: Sequence[_Target]) -> list[_Edge]:
    out: list[_Edge] = []
    rows = info.current_rows
    for c in _ref_columns(info):
        vals = _keyset(rows, c) if rows else set()
        for t in targets:
            if t.dataset == info.name:
                continue
            for k, keys in t.keys.items():
                if vals and keys:
                    hit = len(vals & keys)
                    share = hit / len(vals)
                    if share >= MIN_OVERLAP and hit >= min(2, len(vals)):
                        out.append(_Edge(c, t, k, share))
                elif c.lower() == k.lower() and c.lower() not in _GENERIC and _IDLIKE.search(c):
                    # No sample on one side: a specific shared name (bed_id = bed_id) is the only hint.
                    out.append(_Edge(c, t, k, 1.0, by_name=True))
    return out


def _target(info: _Info) -> _Target:
    keys = {c: (_keyset(info.rows, c) if info.rows else None) for c in info.identity}
    return _Target(info.name, keys, info.kind, info.person_like, info=info)


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


def _unmapped_note(unknown: list[str]) -> str:
    shown = ", ".join(unknown[:6]) + (f" and {len(unknown) - 6} more" if len(unknown) > 6 else "")
    one = len(unknown) == 1
    which = "value" if one else "values"
    return f" Status {which} without a color yet: {shown}; choose {'it' if one else 'them'} in the mapping."


def _thing(info: _Info, id_col: str, anchor: _Edge | None) -> Suggestion:
    assert info.zone
    cols = [c.name for c in info.ds.columns]
    kind = None if info.kind_col else info.kind
    fields: dict[str, str] = {"zone": info.zone}
    if info.kind_col:
        fields["kind"] = info.kind_col
    state_map: dict[str, str] = {}
    confidence = 0.45 + (0.2 if info.zone_rank == 0 else 0.1)
    unknown: list[str] = []
    if info.state:
        fields["state"] = info.state
        state_map, unknown = propose_state_map(_values(info.rows, info.state))
        confidence += 0.15 if not unknown else 0.05
    label = info.label or (id_col if info.kind_col else None)
    if label:
        fields["label"] = label
        confidence += 0.05
    if info.person_like or kind in ("staff", "patient"):
        role = _first(cols, _ROLE, skip=[*fields.values(), id_col])
        if role:
            fields["role"] = role
    if anchor is not None:
        fields["anchor"] = anchor.col
    if kind or info.kind_col:
        confidence += 0.1
    used = {id_col, info.id_col or id_col, *fields.values()}
    config = MappingConfig(
        id_field=id_col,
        fields=fields,
        state_map=state_map,
        attributes=_attributes(info, used, 4),
        kind=kind,
        filter=info.filters,
    )
    if info.kind_col:
        kinds = sorted({str(v) for v in _values(info.rows, info.kind_col) if v not in (None, "")})
        what = f"{'person' if info.person_like else 'thing'} ({' or '.join(kinds)}, from {info.kind_col})"
        reason = f"Each row is {_a(what)} with a place on the map ({info.zone})"
    else:
        what = NOUNS.get(kind or "", kind or "record")
        reason = f"Each row is {_a(what)} with a place on the map ({info.zone})"
    if info.state:
        reason += f" and a status ({info.state})"
    reason += "."
    if anchor is not None:
        reason += f" Drawn next to its {anchor.target.kind or 'record'} ({anchor.col})."
    if info.filters:
        reason += f" {describe(info.filters)} ({info.filter_note})."
    if unknown:
        reason += _unmapped_note(unknown)
    return Suggestion(
        dataset=info.name,
        config=config,
        filter=info.filters or None,
        reason=reason,
        confidence=round(min(confidence, 0.95), 2),
    )


def _attach(info: _Info, edge: _Edge) -> Suggestion:
    target = edge.target
    ref = edge.col
    id_col = info.id_col or ref
    config = MappingConfig(
        id_field=id_col,
        match_key=ref,
        attributes=_attributes(info, {id_col, ref, info.zone or ""}, 6),
        filter=info.filters,
    )
    if target.person_like:
        things = "people"
    else:
        things = PLURALS.get(target.kind or "", f"{target.kind}s" if target.kind else "records")
    how = (
        f"{ref} matches {target.dataset}.{edge.key}"
        if edge.by_name
        else f"{round(edge.overlap * 100)}% of sampled {ref} values are {target.dataset}.{edge.key} values"
    )
    if ref == info.id_col and not info.history:
        reason = (
            f"Describes the same {things} as {target.dataset} ({how}), "
            "so it adds details to them instead of drawing them twice."
        )
    elif info.history:
        reason = (
            f"Tasks or history about {things} in {target.dataset} ({how}), "
            f"so they add details to those {things} instead of separate figures."
        )
    else:
        reason = (
            f"Rows refer to {things} in {target.dataset} ({how}), "
            f"so they add details to those {things} instead of new things on the map."
        )
    if info.filters:
        reason += f" {describe(info.filters)} ({info.filter_note})."
    confidence = 0.55 + (0.15 if info.filters else 0.05) + (0.15 if not edge.by_name else 0.05) * edge.overlap
    return Suggestion(
        dataset=info.name,
        config=config,
        filter=info.filters or None,
        reason=reason,
        confidence=round(min(confidence, 0.9), 2),
        attach_to=AttachTarget(dataset=target.dataset, mapping_id=target.mapping_id, match_key=ref),
    )


def _skip_reason(info: _Info) -> str:
    if info.zone and info.ds.primary_key == [info.zone]:
        return (
            f"One row per {info.zone} with totals: counts for an area, not things on the map. Use live counts instead."
        )
    if _counts_name(info.name):
        return "A queue or log: counts, not things on the map. Use live counts instead."
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


def _best(edges: list[_Edge], specific: set[str]) -> _Edge | None:
    return max(edges, key=lambda e: e.rank(specific)) if edges else None


def _merges(info: _Info, edge: _Edge) -> bool:
    """Should a table that could be drawn on its own add details to ``edge.target`` instead?
    Yes for tasks/history about it, and for rows that are the same things (joined by the table's own key)."""
    return info.history or edge.col == info.id_col


def suggest(
    datasets: Sequence[Dataset],
    samples: dict[str, list[Record]],
    *,
    source_id: str | None = None,
    existing: Sequence[ExistingMapping] = (),
) -> list[Suggestion]:
    """Suggestions for every dataset, best first; skipped datasets last."""
    infos = {ds.name: _analyse(ds, samples.get(ds.name, [])) for ds in datasets}
    mapped_here = {m.dataset for m in existing if m.source_id == source_id}

    def counts_only(i: _Info) -> bool:
        return (bool(i.zone) and i.ds.primary_key == [i.zone]) or _counts_name(i.name)

    # Tables that could be drawn on their own.
    candidates = {n: i for n, i in infos.items() if n not in mapped_here and i.zone and i.id_col and not counts_only(i)}
    # Anything already on the site can be added to, whichever source feeds it.
    existing_targets: list[_Target] = []
    for m in existing:
        if m.attached:
            continue
        same = infos.get(m.dataset) if m.source_id == source_id else None
        keys = {m.key_field: (_keyset(same.rows, m.key_field) if same and same.rows else None)}
        person = same.person_like if same else m.kind in PERSON_KINDS
        existing_targets.append(
            _Target(m.dataset, keys, m.kind, person, mapping_id=m.mapping_id, match_col=m.key_field)
        )
    targets = {n: _target(i) for n, i in candidates.items()}

    # 1. Candidates that are tasks/history about another thing, or the same things as another
    #    table, add details to it instead of being drawn twice.
    merged: dict[str, _Edge] = {}
    changed = True
    while changed:
        changed = False
        # Only standing things take details: tasks and visits are never the thing others add to.
        live = [t for n, t in targets.items() if n not in merged and not candidates[n].history] + existing_targets
        for n, info in candidates.items():
            if n in merged:
                continue
            options = [e for e in _edges(info, live) if _merges(info, e)]
            for e in options:
                back = e.target.info
                # Two tables of the same things: the one with fewer rows adds to the bigger one.
                if back is not None and e.col == info.id_col and back.name not in merged:
                    if any(b.target.dataset == n and b.key == back.id_col for b in _edges(back, [targets[n]])):
                        if len(_keyset(back.rows, e.key)) < len(_keyset(info.rows, e.col)):
                            options = [o for o in options if o is not e]
            if options:
                merged[n] = _best(options, set()) or options[0]
                changed = True
    things = {n: t for n, t in targets.items() if n not in merged}
    final_targets = list(things.values()) + existing_targets

    # 2. Which of a thing's identifying columns others join on: it becomes the asset id.
    all_edges: dict[str, list[_Edge]] = {}
    for n, info in infos.items():
        if n in things or n in mapped_here or counts_only(info):
            continue
        all_edges[n] = _edges(info, final_targets)
    for t in things.values():
        votes: dict[str, int] = {}
        for edges in all_edges.values():
            for e in edges:
                if e.target is t:
                    votes[e.key] = votes.get(e.key, 0) + 1
        t.match_col = max(votes, key=lambda k: (votes[k], k == (t.info.id_col if t.info else ""))) if votes else None
        if t.match_col is None and t.info is not None:
            t.match_col = t.info.id_col

    # Things that point at another thing (a person's bed) are more specific than it.
    thing_edges = {n: _edges(things[n].info, final_targets) for n in things if things[n].info is not None}  # type: ignore[arg-type]
    specific = {n for n, es in thing_edges.items() if es}

    out: list[Suggestion] = []
    skipped: list[Suggestion] = []
    for n, info in infos.items():
        if n in mapped_here:
            skipped.append(_skip(info.ds, "Already mapped on this site."))
            continue
        if n in things:
            t = things[n]
            anchor = None
            if info.person_like:
                anchor = _best(
                    [e for e in thing_edges.get(n, []) if not e.target.person_like and e.key == e.target.match_col],
                    specific,
                )
            out.append(_thing(info, t.match_col or info.id_col or "", anchor))
            continue
        if counts_only(info):
            skipped.append(_skip(info.ds, _skip_reason(info)))
            continue
        edges = [e for e in all_edges.get(n, []) if e.key == e.target.match_col]
        edge = _best(edges, specific)
        if edge is not None:
            out.append(_attach(info, edge))
        elif info.zone and not info.id_col:
            skipped.append(_skip(info.ds, "No column identifies each record. Map it by hand and choose an ID column."))
        else:
            skipped.append(_skip(info.ds, _skip_reason(info)))
    # Things before the details that attach to them; then by confidence.
    out.sort(key=lambda s: (s.attach_to is not None, -s.confidence, s.dataset))
    return out + sorted(skipped, key=lambda s: s.dataset)
