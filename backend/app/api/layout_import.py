"""Import a site layout from an API source (ADR 0007, "Layout import").

``POST /api/sites/{site_id}/layout/import`` fetches a JSON floor layout through a
REST source's own connection (base URL, sign-in, network guard, size cap), turns
it into a layout v2 (ADR 0006) and either previews it (``dry_run``) or saves it.

Formats:
- ``riverside``: ``{floors:[{floor, units:[{unit_id, x, y, width, height,
  nurse_station:{x,y}, rooms:[{room_id, x, y, width, height, beds:[{bed_id,x,y}]}]}]}]}``.
  Same result as ``tools/riverside-mock/setup_site.py::build_layout`` for floors
  and zones: one ``room`` zone per bed (named by bed id, door toward the corridor),
  a corridor per unit, a ``<unit>-NS`` waiting zone per nurse station.
- ``geojson-lite``: a GeoJSON FeatureCollection of Polygons in layout units with
  ``properties: {name, kind?, floor?, id?, doors?}``.
- ``auto``: tells the two apart.

Modes: ``replace`` swaps floors and zones for the imported ones; ``merge`` keeps
zones the user added (anything the previous import did not produce), updates
zones with the same id and drops zones the previous import made that the source
no longer has. Which zones came from an import is recorded in ``layout.imported``.

The pure functions (``parse_layout``, ``combine``, ``validate``) do the work; the
endpoint only fetches and stores.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from collections import Counter
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app import secrets as secrets_mod
from app.connectors.base import ConnectorError
from app.connectors.rest import RestConnector, select_path
from app.db import Site, Source, get_session

router = APIRouter(prefix="/api/sites", tags=["layout-import"])

Format = Literal["auto", "riverside", "geojson-lite"]
Mode = Literal["replace", "merge"]
ZONE_KINDS = ("unit", "room", "bay", "corridor", "waiting", "entrance")

DEFAULT_PATH = "/api/floor-layout"
MARGIN = 2.0  # free space around the drawn extent, as setup_site.build_layout
MAX_FLOORS = 100
MAX_ZONES = 5_000
MAX_POINTS = 200  # per polygon
# Same limits as the layout editor (frontend/src/map/geometry.ts).
MIN_FLOOR = 10.0
MAX_FLOOR = 2000.0
EPS = 1e-6


class ImportError_(ValueError):  # noqa: N801 - "ImportError" is a builtin
    """The document can't be turned into a layout. The message is shown to the user."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


class ImportOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root: str = Field(
        default="",
        max_length=200,
        description="Dotted path to the layout inside the response, e.g. data.layout. Empty: the whole response.",
    )


class ImportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(min_length=1, max_length=64)
    path: str | None = Field(default=None, max_length=500)
    format: Format = "auto"
    mode: Mode = "merge"
    dry_run: bool = False
    options: ImportOptions = Field(default_factory=ImportOptions)


class ImportSummary(BaseModel):
    format: Literal["riverside", "geojson-lite"]
    floors: int
    zones: int
    zones_by_kind: dict[str, int]
    beds: int
    kept_zones: int = 0
    removed_zones: int = 0
    warnings: list[str] = Field(default_factory=list)
    problems: list[str] = Field(default_factory=list)


class ImportOut(BaseModel):
    layout: dict[str, Any]
    summary: ImportSummary
    saved: bool


# -- small helpers -------------------------------------------------------------


def _r2(v: float) -> float:
    return round(v, 2)


def _rect(x: float, y: float, w: float, h: float) -> list[list[float]]:
    return [[_r2(x), _r2(y)], [_r2(x + w), _r2(y)], [_r2(x + w), _r2(y + h)], [_r2(x), _r2(y + h)]]


def _num(v: Any, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ImportError_(f"{what} must be a number", hint="Check the layout the source returns.")
    return float(v)


def _text(v: Any, what: str) -> str:
    if isinstance(v, bool) or not isinstance(v, (str, int, float)) or str(v).strip() == "":
        raise ImportError_(f"{what} is missing", hint="Every floor, unit, room and bed needs an id.")
    s = str(v).strip()
    if len(s) > 200:
        raise ImportError_(f"{what} is longer than 200 characters")
    return s


def _list(v: Any, what: str) -> list[Any]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise ImportError_(f"{what} must be a list")
    return v


def _floor_key(raw: Any, what: str) -> tuple[str, int | None]:
    """Floor id as text, and its number when it is one (3, "3")."""
    fid = _text(raw, what)
    if isinstance(raw, int) and not isinstance(raw, bool):
        return fid, raw
    if isinstance(raw, float) and raw.is_integer():
        return str(int(raw)), int(raw)
    return (fid, int(fid)) if re.fullmatch(r"-?\d+", fid) else (fid, None)


def _make_floors(keys: list[tuple[str, int | None]], extents: dict[str, tuple[float, float]]) -> list[dict[str, Any]]:
    """Floors "Floor N" (id "N", level N-1); named floors go above the numbered ones, in order."""
    top = max((n - 1 for _, n in keys if n is not None), default=-1)
    out = []
    for fid, n in keys:
        if n is not None:
            name, level = f"Floor {n}", n - 1
        else:
            top += 1
            name, level = fid, top
        w, d = extents.get(fid, (0.0, 0.0))
        out.append(
            {
                "id": fid,
                "name": name,
                "level": level,
                "width": _r2(max(MIN_FLOOR, w + MARGIN)),
                "depth": _r2(max(MIN_FLOOR, d + MARGIN)),
            }
        )
    return out


# -- formats -------------------------------------------------------------------


def detect(doc: Any) -> Literal["riverside", "geojson-lite"]:
    if isinstance(doc, dict):
        if doc.get("type") == "FeatureCollection" and isinstance(doc.get("features"), list):
            return "geojson-lite"
        fl = doc.get("floors")
        if isinstance(fl, list) and all(isinstance(f, dict) and "units" in f for f in fl):
            return "riverside"
    raise ImportError_(
        "Couldn't tell what kind of layout the source returned",
        hint='Live Ops reads a "floors → units → rooms → beds" layout or a GeoJSON FeatureCollection of polygons. '
        "Check the path, or set Where the layout is if it sits inside the response.",
    )


def parse_riverside(doc: Any, warnings: list[str]) -> dict[str, Any]:
    if not isinstance(doc, dict) or not isinstance(doc.get("floors"), list):
        raise ImportError_('The layout has no "floors" list', hint="Pick the format that matches the source.")
    floors_in = doc["floors"]
    if len(floors_in) > MAX_FLOORS:
        raise ImportError_(f"The layout has more than {MAX_FLOORS} floors")
    zones: list[dict[str, Any]] = []
    keys: list[tuple[str, int | None]] = []
    extents: dict[str, tuple[float, float]] = {}
    seen_ids: set[str] = set()
    seen_floors: set[str] = set()

    def add(z: dict[str, Any]) -> None:
        if z["id"] in seen_ids:
            warnings.append(f"{z['id']} appears more than once in the source; only the first is used.")
            return
        if len(zones) >= MAX_ZONES:
            raise ImportError_(f"The layout has more than {MAX_ZONES} zones", hint="Import fewer floors at a time.")
        seen_ids.add(z["id"])
        zones.append(z)

    for fi, f in enumerate(floors_in):
        if not isinstance(f, dict):
            raise ImportError_(f"Floor {fi + 1} in the layout is not an object")
        fid, n = _floor_key(f.get("floor"), f"The floor number of floor {fi + 1}")
        if fid in seen_floors:
            warnings.append(f"Floor {fid} is listed more than once; its units are combined.")
        else:
            seen_floors.add(fid)
            keys.append((fid, n))
        width, depth = extents.get(fid, (0.0, 0.0))
        for ui, un in enumerate(_list(f.get("units"), f"The units of floor {fid}")):
            if not isinstance(un, dict):
                raise ImportError_(f"Unit {ui + 1} on floor {fid} is not an object")
            uid = _text(un.get("unit_id"), f"The id of unit {ui + 1} on floor {fid}")
            ux, uy = _num(un.get("x"), f"Unit {uid} x"), _num(un.get("y"), f"Unit {uid} y")
            uw, uh = _num(un.get("width"), f"Unit {uid} width"), _num(un.get("height"), f"Unit {uid} height")
            if uw <= 0 or uh <= 0:
                raise ImportError_(f"Unit {uid} has no size", hint="Its width and height must be above 0.")
            width, depth = max(width, ux + uw), max(depth, uy + uh)
            rooms = []
            for ri, room in enumerate(_list(un.get("rooms"), f"The rooms of unit {uid}")):
                if not isinstance(room, dict):
                    raise ImportError_(f"Room {ri + 1} in unit {uid} is not an object")
                rid = _text(room.get("room_id"), f"The id of room {ri + 1} in unit {uid}")
                rx, ry = _num(room.get("x"), f"Room {rid} x"), _num(room.get("y"), f"Room {rid} y")
                rw, rh = _num(room.get("width"), f"Room {rid} width"), _num(room.get("height"), f"Room {rid} height")
                if rw <= 0 or rh <= 0:
                    warnings.append(f"Room {rid} has no size and was skipped.")
                    continue
                if rx < ux - EPS or ry < uy - EPS or rx + rw > ux + uw + EPS or ry + rh > uy + uh + EPS:
                    warnings.append(f"Room {rid} lies partly outside unit {uid}.")
                width, depth = max(width, rx + rw), max(depth, ry + rh)
                beds = [b for b in _list(room.get("beds"), f"The beds of room {rid}") if isinstance(b, dict)]
                if not beds:
                    warnings.append(f"Room {rid} has no beds, so no zone was made for it.")
                rooms.append((rid, rx, ry, rw, rh, beds))
            # Rooms above the unit's middle line form the top row; the corridor runs between the rows.
            mid = uy + uh / 2
            top = [r for r in rooms if r[2] + r[4] / 2 < mid]
            bottom = [r for r in rooms if r[2] + r[4] / 2 >= mid]
            c0 = max((r[2] + r[4] for r in top), default=uy)
            c1 = min((r[2] for r in bottom), default=uy + uh)
            if c1 <= c0:  # rows overlap: fall back to the unit's middle band
                c0, c1 = uy + uh * 0.35, uy + uh * 0.65
            add(
                {
                    "id": f"{uid}-corridor",
                    "name": f"{uid} corridor",
                    "kind": "corridor",
                    "floor_id": fid,
                    "polygon": _rect(ux, c0, uw, c1 - c0),
                }
            )
            ns = un.get("nurse_station")
            if isinstance(ns, dict):
                nx, ny = (
                    _num(ns.get("x"), f"Unit {uid} nurse station x"),
                    _num(ns.get("y"), f"Unit {uid} nurse station y"),
                )
                add(
                    {
                        "id": f"{uid}-NS",
                        "name": f"{uid}-NS",
                        "kind": "waiting",
                        "floor_id": fid,
                        "polygon": _rect(nx - 3, ny, 6, 3),
                        "doors": [[_r2(nx), _r2(ny)]],
                    }
                )
                width, depth = max(width, nx + 3), max(depth, ny + 3)
            for rid, rx, ry, rw, rh, beds in rooms:
                is_top = ry + rh / 2 < mid
                door_y = _r2(ry + rh if is_top else ry)
                w = rw / len(beds) if beds else rw
                for i, bed in enumerate(beds):
                    bid = _text(bed.get("bed_id"), f"The id of bed {i + 1} in room {rid}")
                    x = rx + i * w
                    add(
                        {
                            "id": bid,
                            "name": bid,
                            "kind": "room",
                            "floor_id": fid,
                            "polygon": _rect(x, ry, w, rh),
                            "doors": [[_r2(x + w / 2), door_y]],
                        }
                    )
        extents[fid] = (width, depth)
    if not zones:
        raise ImportError_("The layout has no units or beds", hint="Check the path points at the floor layout.")
    return {"floors": _make_floors(keys, extents), "zones": zones}


def _ring(geom: Any, what: str) -> list[list[float]]:
    if not isinstance(geom, dict) or geom.get("type") != "Polygon":
        kind = geom.get("type") if isinstance(geom, dict) else None
        raise ImportError_(f"{what} is a {kind or 'missing'} shape, not a Polygon")
    coords = geom.get("coordinates")
    if not isinstance(coords, list) or not coords or not isinstance(coords[0], list):
        raise ImportError_(f"{what} has no outline")
    pts = []
    for p in coords[0]:
        if not isinstance(p, list) or len(p) < 2:
            raise ImportError_(f"{what} has a point that isn't [x, y]")
        pts.append([_r2(_num(p[0], f"{what} x")), _r2(_num(p[1], f"{what} y"))])
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()  # GeoJSON repeats the first point to close the ring
    if len({tuple(p) for p in pts}) < 3:
        raise ImportError_(f"{what} has fewer than 3 corners")
    if len(pts) > MAX_POINTS:
        raise ImportError_(f"{what} has more than {MAX_POINTS} corners", hint="Simplify the shape.")
    return pts


def parse_geojson(doc: Any, warnings: list[str]) -> dict[str, Any]:
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection" or not isinstance(doc.get("features"), list):
        raise ImportError_(
            "The layout is not a GeoJSON FeatureCollection", hint="Pick the format that matches the source."
        )
    feats = doc["features"]
    if len(feats) > MAX_ZONES:
        raise ImportError_(f"The layout has more than {MAX_ZONES} shapes", hint="Import fewer floors at a time.")
    zones: list[dict[str, Any]] = []
    keys: list[tuple[str, int | None]] = []
    extents: dict[str, tuple[float, float]] = {}
    seen_ids: set[str] = set()
    for i, ft in enumerate(feats):
        props = ft.get("properties") if isinstance(ft, dict) else None
        props = props if isinstance(props, dict) else {}
        label = str(props.get("name") or props.get("id") or f"shape {i + 1}")[:80]
        try:
            poly = _ring(ft.get("geometry") if isinstance(ft, dict) else None, f'Shape "{label}"')
        except ImportError_ as e:
            warnings.append(f"{e} It was skipped.")
            continue
        name = props.get("name")
        if not isinstance(name, (str, int, float)) or isinstance(name, bool) or not str(name).strip():
            warnings.append(f"Shape {i + 1} has no name and was skipped. Add a name property.")
            continue
        name = str(name).strip()[:200]
        zid = str(props.get("id") if isinstance(props.get("id"), (str, int)) and str(props.get("id")).strip() else name)
        zid = zid.strip()[:200]
        if zid in seen_ids:
            warnings.append(f"{zid} appears more than once in the source; only the first is used.")
            continue
        seen_ids.add(zid)
        fid, n = (
            _floor_key(props["floor"], f'The floor of "{name}"') if props.get("floor") not in (None, "") else ("1", 1)
        )
        if all(k != fid for k, _ in keys):
            keys.append((fid, n))
        z: dict[str, Any] = {"id": zid, "name": name, "floor_id": fid, "polygon": poly}
        kind = props.get("kind")
        if kind not in (None, ""):
            k = str(kind).strip().lower()
            if k in ZONE_KINDS:
                z["kind"] = k
            else:
                warnings.append(
                    f'"{name}" has kind "{str(kind)[:40]}", which Live Ops doesn\'t know; it is a plain zone.'
                )
        doors = props.get("doors")
        if isinstance(doors, list):
            pts = [
                [_r2(float(d[0])), _r2(float(d[1]))]
                for d in doors[:50]
                if isinstance(d, list)
                and len(d) >= 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in d[:2])
            ]
            if pts:
                z["doors"] = pts
        if any(x < -EPS or y < -EPS for x, y in poly):
            warnings.append(f'"{name}" has negative coordinates, so it lies outside the floor.')
        w, d = extents.get(fid, (0.0, 0.0))
        extents[fid] = (max(w, *(p[0] for p in poly)), max(d, *(p[1] for p in poly)))
        zones.append(z)
    if len(keys) > MAX_FLOORS:
        raise ImportError_(f"The layout has more than {MAX_FLOORS} floors")
    if not zones:
        raise ImportError_("The layout has no usable shapes", hint="Each feature needs a Polygon and a name property.")
    return {"floors": _make_floors(keys, extents), "zones": zones}


def parse_layout(doc: Any, fmt: Format, root: str = "") -> tuple[dict[str, Any], str, list[str]]:
    """Parsed ``{floors, zones}``, the format used, and warnings."""
    if root.strip():
        found = select_path(doc, root)
        if found is None:
            raise ImportError_(f"Nothing found at {root!r} in the response", hint="Check Where the layout is.")
        doc = found
    used = detect(doc) if fmt == "auto" else fmt
    warnings: list[str] = []
    parsed = parse_riverside(doc, warnings) if used == "riverside" else parse_geojson(doc, warnings)
    return parsed, used, warnings


# -- merge / replace -----------------------------------------------------------


def _existing_floors(layout: dict[str, Any]) -> list[dict[str, Any]]:
    floors = layout.get("floors")
    if isinstance(floors, list) and floors:
        return [dict(f) for f in floors if isinstance(f, dict) and isinstance(f.get("id"), str)]
    if layout.get("zones"):  # 0.1 layout: one implicit floor (ADR 0006)
        return [
            {
                "id": "main",
                "name": "Main floor",
                "level": 0,
                "width": layout.get("width") or 100,
                "depth": layout.get("depth") or 60,
            }
        ]
    return []


def combine(
    existing: dict[str, Any], parsed: dict[str, Any], mode: Mode, record: dict[str, Any], warnings: list[str]
) -> tuple[dict[str, Any], int, int]:
    """New layout from the stored one and the imported floors/zones. Returns (layout, kept, removed)."""
    old_floors = _existing_floors(existing)
    first_floor = old_floors[0]["id"] if old_floors else None
    old_zones = []
    for z in existing.get("zones") or []:
        if isinstance(z, dict):
            z = dict(z)
            if not z.get("floor_id") and first_floor:
                z["floor_id"] = first_floor  # no floor_id = first floor (ADR 0006)
            old_zones.append(z)
    old_by_id = {f["id"]: f for f in old_floors}
    new_ids = {z["id"] for z in parsed["zones"]}
    prev_raw = existing.get("imported")
    prev: dict[str, Any] = prev_raw if isinstance(prev_raw, dict) else {}
    prev_ids = {str(i) for i in prev.get("zone_ids") or [] if isinstance(i, (str, int))}

    floors: list[dict[str, Any]] = []
    for f in parsed["floors"]:
        old = old_by_id.get(f["id"])
        if old is None:
            floors.append(f)
        elif mode == "merge":
            # The user's name, level and plan win; the floor only grows so their zones stay on it.
            floors.append(
                {**old, "width": max(_size(old, "width"), f["width"]), "depth": max(_size(old, "depth"), f["depth"])}
            )
        else:
            floors.append({**f, **({"plan": old["plan"]} if old.get("plan") else {})})
    imported_floor_ids = {f["id"] for f in floors}

    if mode == "merge":
        kept = [z for z in old_zones if z.get("id") not in new_ids and z.get("id") not in prev_ids]
        removed = sum(1 for z in old_zones if z.get("id") in prev_ids and z.get("id") not in new_ids)
        floors += [f for f in old_floors if f["id"] not in imported_floor_ids]  # the user's own floors stay
        zones = parsed["zones"] + kept
        fids = {f["id"] for f in floors}
        entrances = [
            e for e in existing.get("entrances") or [] if isinstance(e, dict) and e.get("floor_id", first_floor) in fids
        ]
    else:
        kept, removed = [], sum(1 for z in old_zones if z.get("id") not in new_ids)
        zones, entrances = list(parsed["zones"]), []
        if existing.get("entrances"):
            warnings.append(
                f"{_plural(len(existing['entrances']), 'entrance')} will be removed. "
                "Add them again in the layout editor."
            )
        lost = [f for f in old_floors if f["id"] not in imported_floor_ids and f.get("plan")]
        for f in lost:
            warnings.append(
                f"The floor plan image on {f.get('name') or f['id']} won't be shown any more: "
                "that floor isn't in the import."
            )

    floors.sort(key=lambda f: f.get("level", 0) if isinstance(f.get("level"), (int, float)) else 0)
    rest = {
        k: v for k, v in existing.items() if k not in ("floors", "zones", "entrances", "width", "depth", "imported")
    }
    out: dict[str, Any] = {
        **rest,
        "width": floors[0]["width"],
        "depth": floors[0]["depth"],
        "floors": floors,
        "zones": zones,
        "entrances": entrances,
        "imported": {**record, "zone_ids": sorted(new_ids), "floor_ids": [f["id"] for f in parsed["floors"]]},
    }
    return out, len(kept), removed


def _size(f: dict[str, Any], key: str) -> float:
    v = f.get(key)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def _plural(n: int, w: str) -> str:
    return f"{n} {w}{'' if n == 1 else 's'}"


# -- validation (same rules as the layout editor's validateModel) ---------------


def _bounds(poly: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(poly, list) or len(poly) < 3:
        return None
    try:
        xs = [float(p[0]) for p in poly]
        ys = [float(p[1]) for p in poly]
    except (TypeError, ValueError, IndexError):
        return None
    if not all(math.isfinite(v) for v in xs + ys):
        return None
    return min(xs), min(ys), max(xs), max(ys)


def validate(layout: dict[str, Any]) -> list[str]:
    """Problems that block saving, phrased like the layout editor's (frontend layoutModel.validateModel)."""
    out: list[str] = []
    floors = layout.get("floors") or []
    many = len(floors) > 1
    names: Counter[str] = Counter()
    fids = {f.get("id") for f in floors}
    for f in floors:
        name = str(f.get("name") or "").strip()
        if not name:
            out.append("A floor has no name. Give every floor a name, such as Ground floor or Level 2.")
        else:
            names[name.lower()] += 1
        where = f"On {name or 'the unnamed floor'}: " if many else ""
        w, d = _size(f, "width"), _size(f, "depth")
        if not (MIN_FLOOR <= w <= MAX_FLOOR and MIN_FLOOR <= d <= MAX_FLOOR):
            out.append(f"{where}Floor size must be between {MIN_FLOOR:g} and {MAX_FLOOR:g} on each side.")
        zn: Counter[str] = Counter()
        for z in layout.get("zones") or []:
            if z.get("floor_id") != f.get("id"):
                continue
            zname = str(z.get("name") or "").strip()
            if not zname:
                out.append(f"{where}Zone {z.get('id')} has no name. Give it a name so assets can be matched to it.")
            else:
                zn[zname.lower()] += 1
            b = _bounds(z.get("polygon"))
            if b is None:
                out.append(f'{where}Zone "{zname or z.get("id")}" has no valid outline (it needs 3 or more corners).')
            elif b[0] < -EPS or b[1] < -EPS or b[2] > w + EPS or b[3] > d + EPS:
                out.append(
                    f'{where}Zone "{zname or z.get("id")}" extends past the {w:g} × {d:g} floor. '
                    "Move or resize it, or make the floor larger."
                )
        for zname, n in zn.items():
            if n > 1:
                out.append(
                    f'{where}{n} zones are named "{zname}". Zone names must be unique so assets land in the right one.'
                )
        for e in layout.get("entrances") or []:
            if e.get("floor_id") != f.get("id"):
                continue
            pt = e.get("point")
            ename = str(e.get("name") or "").strip()
            ok = isinstance(pt, list) and len(pt) == 2 and all(isinstance(v, (int, float)) for v in pt)
            if not ok or not (0 <= pt[0] <= w and 0 <= pt[1] <= d):
                out.append(
                    f'{where}Entrance "{ename or e.get("id")}" is outside the {w:g} × {d:g} floor. '
                    "Move it onto the floor."
                )
    for z in layout.get("zones") or []:
        if z.get("floor_id") not in fids:
            out.append(f'Zone "{z.get("name") or z.get("id")}" is on a floor that doesn\'t exist.')
    for name, n in names.items():
        if n > 1:
            out.append(f'{n} floors are named "{name}". Floor names must be different so assets can name their floor.')
    return out


def summarize(layout: dict[str, Any], used: str, kept: int, removed: int, warnings: list[str]) -> ImportSummary:
    imported = set(layout["imported"]["zone_ids"])
    zones = [z for z in layout["zones"] if z.get("id") in imported]
    by_kind = Counter(str(z.get("kind") or "other") for z in zones)
    ids = Counter(str(z.get("id")) for z in layout["zones"])
    dup = sorted(i for i, n in ids.items() if n > 1)
    if dup:
        warnings.append(f"Zone ids used more than once: {', '.join(dup[:10])}{'…' if len(dup) > 10 else ''}.")
    return ImportSummary(
        format=used,
        floors=len(layout["imported"]["floor_ids"]),
        zones=len(zones),
        zones_by_kind=dict(sorted(by_kind.items())),
        beds=by_kind.get("room", 0) if used == "riverside" else sum(1 for z in zones if z.get("kind") == "room"),
        kept_zones=kept,
        removed_zones=removed,
        warnings=warnings[:50] + ([f"…and {len(warnings) - 50} more."] if len(warnings) > 50 else []),
        problems=validate(layout),
    )


def build_import(existing: dict[str, Any], doc: Any, body: ImportIn, record: dict[str, Any]) -> ImportOut:
    """Pure: parse the fetched document and combine it with the stored layout."""
    parsed, used, warnings = parse_layout(doc, body.format, body.options.root)
    layout, kept, removed = combine(existing, parsed, body.mode, {**record, "format": used}, warnings)
    return ImportOut(layout=layout, summary=summarize(layout, used, kept, removed, warnings), saved=False)


# -- endpoint ------------------------------------------------------------------


async def fetch_document(src: Source, path: str) -> Any:
    """GET ``path`` through the source's own connection: same base URL, sign-in,
    network guard, timeouts and response size cap as its polls."""
    settings = {**(src.settings or {}), "path": path, "query": {}, "pagination": "none"}
    conn = RestConnector(settings, secrets_mod.decrypt(src.secrets_enc), source_id=src.id)
    try:
        conn.check_settings()
        doc, _ = await conn._get_json(conn._url(), None)  # noqa: SLF001 - reuse the connector's guarded GET
        return doc
    finally:
        await conn.close()


def _bad(message: str, hint: str = "", status: int = 400) -> HTTPException:
    return HTTPException(status, detail={"message": message, "hint": hint})


@router.post("/{site_id}/layout/import", response_model=ImportOut)
async def import_layout(site_id: str, body: ImportIn, session: Session = Depends(get_session)) -> ImportOut:
    site = session.get(Site, site_id)
    if site is None:
        raise HTTPException(404, detail={"message": "Site not found"})
    src = session.get(Source, body.source_id)
    if src is None:
        raise _bad("Source not found", "Pick one of the sources listed on the Sources page.", 404)
    if src.type != "rest":
        raise _bad(
            "Layout import needs an API source",
            "Choose a source of type REST API (JSON); the layout is read from one of its addresses.",
        )
    path = (body.path or "").strip() or str((src.settings or {}).get("path") or "") or DEFAULT_PATH
    try:
        doc = await fetch_document(src, path)
    except ConnectorError as e:
        raise _bad(str(e), e.hint) from e
    record = {"source_id": src.id, "path": path, "ts": time.time()}
    existing = dict(site.layout or {})
    try:
        out = await asyncio.to_thread(build_import, existing, doc, body, record)
    except ImportError_ as e:
        raise HTTPException(422, detail={"message": str(e), "hint": e.hint}) from e
    if body.dry_run:
        return out  # a preview never stores anything
    session.refresh(site)
    if (site.layout or {}) != existing:  # someone saved while we fetched: build on their version
        existing = dict(site.layout or {})
        out = await asyncio.to_thread(build_import, existing, doc, body, record)
    if out.summary.problems:
        raise HTTPException(
            422,
            detail={
                "message": "The imported layout was not saved",
                "hint": "Fix these in the source, or rename or move your own zones in the layout editor, "
                "then import again.",
                "problems": out.summary.problems,
            },
        )
    site.layout = out.layout
    site.updated_ts = time.time()
    session.commit()
    return out.model_copy(update={"saved": True})
