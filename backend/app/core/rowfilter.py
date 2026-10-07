"""Row filters for mappings (``MappingConfig.filter``, ADR 0006).

A filter is a list of conditions that must all hold (AND)::

    [{"column": "discharged_at", "op": "is_null"},
     {"column": "status", "op": "in", "value": ["open", "in_progress"]}]

Records are the JSON-safe values connectors produce (``normalize_record``):
numbers, strings (timestamps arrive as ISO 8601 text), booleans and null. The
user's value is coerced to the record value's type before comparing, so
``"5"`` matches ``5``, ``"true"`` matches ``True`` and two ISO timestamps
compare as instants, not as text.

Null handling follows plain language rather than SQL: a row whose ``status``
is empty *is* "not done" (``ne``/``not_in`` match it); ordering and
``contains`` never match an empty value.

Pure module: no connector or I/O imports, so the runner and the connector SDK
can both use it.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from collections.abc import Callable, Iterable, Sequence
from typing import Any, Literal

from pydantic import BaseModel, field_validator, model_validator

FilterOp = Literal["eq", "ne", "in", "not_in", "is_null", "not_null", "gt", "gte", "lt", "lte", "contains"]

NO_VALUE_OPS = {"is_null", "not_null"}
LIST_OPS = {"in", "not_in"}
ORDER_OPS = {"gt", "gte", "lt", "lte"}

MAX_LIST = 500

_TRUE = {"true", "t", "yes", "y", "1", "on"}
_FALSE = {"false", "f", "no", "n", "0", "off"}
# ISO 8601 date or date-time (what normalize_value produces for dates/timestamps).
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$")

Scalar = str | int | float | bool | None


class RowFilter(BaseModel):
    column: str
    op: FilterOp
    value: Any = None

    @field_validator("column")
    @classmethod
    def _column(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("choose the column to filter on")
        return v

    @model_validator(mode="after")
    def _value_fits_op(self) -> RowFilter:
        op, v = self.op, self.value
        if op in NO_VALUE_OPS:
            if v not in (None, "", []):
                raise ValueError(f"{op} doesn't take a value; remove it")
            self.value = None
        elif op in LIST_OPS:
            if isinstance(v, str):
                # "a, b, c" typed in one box is a list of three values.
                v = [p.strip() for p in v.split(",") if p.strip()]
            if not isinstance(v, list) or not v:
                raise ValueError(f"{op} needs a list of one or more values")
            if len(v) > MAX_LIST:
                raise ValueError(f"{op} takes at most {MAX_LIST} values")
            if any(isinstance(x, (list, dict)) for x in v):
                raise ValueError(f"{op} values must be plain values (text, numbers, true/false)")
            self.value = v
        else:
            if v is None or (isinstance(v, str) and v.strip() == ""):
                raise ValueError(f"{op} needs a value; use is_null to match empty values")
            if isinstance(v, (list, dict)):
                raise ValueError(f"{op} needs a single value, not a list; use in for several values")
            if op in ORDER_OPS and isinstance(v, bool):
                raise ValueError(f"{op} compares numbers, dates or text, not true/false")
        return self


# --------------------------------------------------------------------------
# Coercion
# --------------------------------------------------------------------------


def _as_bool(v: Any) -> bool | None:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in _TRUE:
            return True
        if s in _FALSE:
            return False
    return None


def _as_number(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, str):
        try:
            f = float(v.strip())
        except ValueError:
            return None
        return f if math.isfinite(f) else None
    return None


def _as_time(v: Any) -> dt.datetime | None:
    if not isinstance(v, str) or not _ISO.match(v.strip()):
        return None
    s = v.strip().replace("Z", "+00:00")
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    # Naive values (timestamp without time zone, plain dates) are read as UTC so
    # they can be compared with zone-aware ones.
    return t if t.tzinfo else t.replace(tzinfo=dt.UTC)


def _pair(rec: Any, want: Any, *, ordering: bool = False) -> tuple[Any, Any] | None:
    """Coerce the filter value to the record value's type. None: not comparable."""
    if isinstance(rec, bool):
        b = _as_bool(want)
        return None if b is None else (rec, b)
    if isinstance(rec, (int, float)):
        n = _as_number(want)
        return None if n is None else (float(rec), n)
    if not isinstance(rec, str):
        return None  # lists and objects only support contains
    if isinstance(want, bool):
        rb = _as_bool(rec)
        return None if rb is None else (rb, want)
    if isinstance(want, (int, float)):
        rn = _as_number(rec)
        return None if rn is None else (rn, float(want))
    w = str(want)
    rt, wt = _as_time(rec), _as_time(w)
    if rt is not None and wt is not None:
        return rt, wt
    if ordering:
        # Numbers stored as text order as numbers ("9" < "10"); codes like "007"
        # still compare as text for equality.
        rn, wn = _as_number(rec), _as_number(w)
        if rn is not None and wn is not None:
            return rn, wn
    return rec, w


def _equal(rec: Any, want: Any) -> bool:
    if rec is None:
        return want is None
    p = _pair(rec, want)
    return p is not None and p[0] == p[1]


def _order(rec: Any, want: Any, op: str) -> bool:
    if rec is None:
        return False
    p = _pair(rec, want, ordering=True)
    if p is None:
        return False
    a, b = p
    try:
        if op == "gt":
            return bool(a > b)
        if op == "gte":
            return bool(a >= b)
        if op == "lt":
            return bool(a < b)
        return bool(a <= b)
    except TypeError:
        return False


def _contains(rec: Any, want: Any) -> bool:
    if rec is None:
        return False
    if isinstance(rec, list):
        return any(_equal(x, want) for x in rec)
    return str(want).casefold() in str(rec).casefold()


def _is_empty(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def matches_one(rec: dict[str, Any], f: RowFilter) -> bool:
    v = rec.get(f.column)
    if f.op == "is_null":
        return _is_empty(v)
    if f.op == "not_null":
        return not _is_empty(v)
    if f.op == "eq":
        return _equal(v, f.value)
    if f.op == "ne":
        return not _equal(v, f.value)
    if f.op == "in":
        return any(_equal(v, x) for x in f.value)
    if f.op == "not_in":
        return not any(_equal(v, x) for x in f.value)
    if f.op == "contains":
        return _contains(v, f.value)
    return _order(v, f.value, f.op)


def matches(rec: dict[str, Any], filters: Sequence[RowFilter]) -> bool:
    """True when the record passes every condition (an empty filter passes all)."""
    return all(matches_one(rec, f) for f in filters)


def predicate(filters: Sequence[RowFilter]) -> Callable[[dict[str, Any]], bool] | None:
    """A ``record -> bool`` function, or None when there is nothing to filter."""
    if not filters:
        return None
    fs = list(filters)
    return lambda rec: matches(rec, fs)


# --------------------------------------------------------------------------
# Validation against a dataset's columns, and plain-language summaries
# --------------------------------------------------------------------------

TypeFamily = Literal["number", "time", "bool", "text"]

_NUMBER_T = re.compile(r"int|numeric|decimal|float|double|real|number|money|serial", re.I)
_TIME_T = re.compile(r"date|time", re.I)
_BOOL_T = re.compile(r"^bool|^bit$", re.I)


def type_family(type_name: str) -> TypeFamily | None:
    """Rough type family from a source's type name (any connector). None: unknown."""
    t = type_name.strip()
    if not t:
        return None
    if _BOOL_T.search(t):
        return "bool"
    if _TIME_T.search(t) and not re.search(r"interval", t, re.I):
        return "time"
    if _NUMBER_T.search(t) and not re.search(r"point|interval", t, re.I):
        return "number"
    if re.search(r"char|text|string|uuid|enum|varchar|clob", t, re.I):
        return "text"
    return None


def _value_problem(f: RowFilter, family: TypeFamily | None) -> str | None:
    if f.op in NO_VALUE_OPS or family is None or family == "text":
        return None
    values: Iterable[Any] = f.value if isinstance(f.value, list) else [f.value]
    for v in values:
        if family == "number" and _as_number(v) is None:
            return f"Filter on {f.column!r}: {v!r} isn't a number"
        if family == "bool" and _as_bool(v) is None:
            return f"Filter on {f.column!r}: use true or false, not {v!r}"
        if family == "time" and f.op != "contains" and _as_time(v) is None:
            return f"Filter on {f.column!r}: {v!r} isn't a date; use the form 2026-10-07 or 2026-10-07T14:30:00Z"
    return None


def filter_problems(filters: Sequence[RowFilter], column_types: dict[str, str]) -> list[str]:
    """Human-readable problems with a filter for a dataset with these columns."""
    out: list[str] = []
    for f in filters:
        if f.column not in column_types:
            out.append(f"Filter column {f.column!r} isn't in this table")
            continue
        p = _value_problem(f, type_family(column_types[f.column]))
        if p:
            out.append(p)
    return out


def _show(v: Any) -> str:
    return f'"{v}"' if isinstance(v, str) else str(v).lower() if isinstance(v, bool) else str(v)


def describe_one(f: RowFilter) -> str:
    c = f.column
    v = f.value
    if f.op == "is_null":
        return f"{c} is empty"
    if f.op == "not_null":
        return f"{c} is not empty"
    if f.op in LIST_OPS:
        joined = ", ".join(_show(x) for x in v)
        return f"{c} is one of {joined}" if f.op == "in" else f"{c} is not any of {joined}"
    word = {
        "eq": "is",
        "ne": "is not",
        "gt": "is greater than",
        "gte": "is at least",
        "lt": "is less than",
        "lte": "is at most",
        "contains": "contains",
    }[f.op]
    return f"{c} {word} {_show(v)}"


def describe(filters: Sequence[RowFilter]) -> str:
    """'Only rows where discharged_at is empty and status is "open"'."""
    if not filters:
        return "All rows"
    return "Only rows where " + " and ".join(describe_one(f) for f in filters)
