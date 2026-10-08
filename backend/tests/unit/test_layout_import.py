"""Layout import (ADR 0007): formats, detection, merge/replace, validation. Pure functions, no network."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from app.api.layout_import import (
    ImportError_,
    ImportIn,
    build_import,
    combine,
    detect,
    parse_layout,
    validate,
)

TOOLS = Path(__file__).resolve().parents[3] / "tools" / "riverside-mock"


def _load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"riverside_{name}", TOOLS / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def mock_api() -> ModuleType:
    return _load("mock_api")


@pytest.fixture(scope="module")
def setup_site() -> ModuleType:
    return _load("setup_site")


def body(**kw: Any) -> ImportIn:
    return ImportIn(source_id="s1", **kw)


def rec() -> dict[str, Any]:
    return {"source_id": "s1", "path": "/api/floor-layout", "ts": 1.0}


# -- riverside -------------------------------------------------------------------


def test_riverside_matches_setup_site_build_layout(mock_api: ModuleType, setup_site: ModuleType) -> None:
    """Same floors and zones as setup_site.build_layout, before its Riverside-only extras."""
    doc = mock_api.build_layout()
    parsed, used, warnings = parse_layout(doc, "auto")
    assert used == "riverside" and warnings == []
    ref = setup_site.build_layout(copy.deepcopy(doc))
    ids = {z["id"] for z in parsed["zones"]}
    ref_zones = [z for z in ref["zones"] if z["id"] in ids]
    assert parsed["zones"] == ref_zones  # same ids, names, kinds, polygons, doors, order
    # Every corridor, nurse station and bed of the reference is produced.
    extras = {z["id"] for z in ref["zones"]} - ids
    assert all(i.startswith(("fleet-", "area-")) or i in ("f1-link", "B1-corridor") for i in extras)
    beds = [b["bed_id"] for f in doc["floors"] for u in f["units"] for r in u["rooms"] for b in r["beds"]]
    assert sorted(z["id"] for z in parsed["zones"] if z["kind"] == "room") == sorted(beds)
    # Floors "Floor N", id "N", level N-1, sized from extents (setup_site later widens floor 1 for its extras).
    ref_floors = {f["id"]: f for f in ref["floors"]}
    for f in parsed["floors"]:
        assert f["name"] == f"Floor {f['id']}" and f["level"] == int(f["id"]) - 1
        if f["id"] != "1":
            assert f == ref_floors[f["id"]]
    f1 = next(f for f in parsed["floors"] if f["id"] == "1")
    assert (f1["width"], f1["depth"]) == (56, 28)


def test_riverside_doors_face_the_corridor() -> None:
    doc = {
        "floors": [
            {
                "floor": 2,
                "units": [
                    {
                        "unit_id": "U",
                        "x": 0,
                        "y": 0,
                        "width": 20,
                        "height": 20,
                        "nurse_station": {"x": 10, "y": 8},
                        "rooms": [
                            {
                                "room_id": "U-1",
                                "x": 1,
                                "y": 1,
                                "width": 4,
                                "height": 5,
                                "beds": [{"bed_id": "U-1A"}, {"bed_id": "U-1B"}],
                            },
                            {"room_id": "U-2", "x": 1, "y": 14, "width": 4, "height": 5, "beds": [{"bed_id": "U-2"}]},
                        ],
                    }
                ],
            }
        ]
    }
    parsed, _, _ = parse_layout(doc, "riverside")
    z = {x["id"]: x for x in parsed["zones"]}
    assert z["U-1A"]["doors"] == [[2.0, 6]] and z["U-1B"]["doors"] == [[4.0, 6]]  # top row: door on its bottom edge
    assert z["U-2"]["doors"] == [[3.0, 14]]  # bottom row: door on its top edge
    assert z["U-corridor"]["polygon"] == [[0, 6], [20, 6], [20, 14], [0, 14]]
    assert z["U-NS"]["kind"] == "waiting" and z["U-NS"]["doors"] == [[10, 8]]
    assert parsed["floors"] == [{"id": "2", "name": "Floor 2", "level": 1, "width": 22, "depth": 22}]


def test_riverside_warnings_for_duplicates_and_rooms_outside_their_unit() -> None:
    doc = {
        "floors": [
            {
                "floor": "1",
                "units": [
                    {
                        "unit_id": "U",
                        "x": 0,
                        "y": 0,
                        "width": 10,
                        "height": 10,
                        "rooms": [
                            {"room_id": "R1", "x": 0, "y": 0, "width": 4, "height": 4, "beds": [{"bed_id": "B1"}]},
                            {"room_id": "R2", "x": 8, "y": 0, "width": 4, "height": 4, "beds": [{"bed_id": "B1"}]},
                            {"room_id": "R3", "x": 0, "y": 6, "width": 4, "height": 4, "beds": []},
                        ],
                    }
                ],
            }
        ]
    }
    parsed, _, warnings = parse_layout(doc, "riverside")
    assert [z["id"] for z in parsed["zones"] if z["kind"] == "room"] == ["B1"]
    assert any("B1 appears more than once" in w for w in warnings)
    assert any("Room R2 lies partly outside unit U" in w for w in warnings)
    assert any("Room R3 has no beds" in w for w in warnings)
    assert parsed["floors"][0]["width"] == 14  # extent includes the room sticking out


@pytest.mark.parametrize(
    ("doc", "msg"),
    [
        (
            {"floors": [{"floor": 1, "units": [{"unit_id": "U", "x": "a", "y": 0, "width": 1, "height": 1}]}]},
            "x must be a number",
        ),
        ({"floors": [{"floor": 1, "units": [{"x": 0, "y": 0, "width": 1, "height": 1}]}]}, "is missing"),
        ({"floors": [{"floor": None, "units": []}]}, "floor number"),
        ({"floors": []}, "no units or beds"),
        (
            {"floors": [{"floor": 1, "units": [{"unit_id": "U", "x": 0, "y": 0, "width": float("nan"), "height": 1}]}]},
            "number",
        ),
    ],
)
def test_riverside_bad_input_is_a_plain_error(doc: Any, msg: str) -> None:
    with pytest.raises(ImportError_, match=msg):
        parse_layout(doc, "riverside")


# -- geojson-lite ----------------------------------------------------------------


def feat(name: Any, poly: list[list[float]], **props: Any) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": {"name": name, **props},
        "geometry": {"type": "Polygon", "coordinates": [poly]},
    }


SQ = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]


def test_geojson_lite_parses_polygons_floors_and_kinds() -> None:
    doc = {
        "type": "FeatureCollection",
        "features": [
            feat("Ward A", SQ, kind="Room", floor=2, doors=[[5, 8]]),
            feat("Hall", [[0, 10], [30, 10], [30, 14], [0, 14]], kind="corridor", floor=2, id="hall-2"),
            feat("Lobby", [[0, 0], [20, 0], [20, 5]], floor="G"),
            feat("Odd", SQ, kind="spaceship", floor=2),
        ],
    }
    parsed, used, warnings = parse_layout(doc, "auto")
    assert used == "geojson-lite"
    z = {x["id"]: x for x in parsed["zones"]}
    assert z["Ward A"] == {
        "id": "Ward A",
        "name": "Ward A",
        "floor_id": "2",
        "kind": "room",
        "polygon": [[0, 0], [10, 0], [10, 8], [0, 8]],
        "doors": [[5, 8]],
    }
    assert z["hall-2"]["kind"] == "corridor"
    assert "kind" not in z["Odd"] and any("spaceship" in w for w in warnings)
    floors = {f["id"]: f for f in parsed["floors"]}
    assert floors["2"] == {"id": "2", "name": "Floor 2", "level": 1, "width": 32, "depth": 16}
    assert floors["G"]["name"] == "G" and floors["G"]["level"] == 2 and floors["G"]["width"] == 22
    assert floors["G"]["depth"] == 10  # never smaller than the editor's minimum


def test_geojson_lite_skips_bad_shapes_with_warnings() -> None:
    doc = {
        "type": "FeatureCollection",
        "features": [
            feat("Good", SQ),
            feat("", SQ),
            {
                "type": "Feature",
                "properties": {"name": "Multi"},
                "geometry": {"type": "MultiPolygon", "coordinates": []},
            },
            feat("Line", [[0, 0], [1, 1], [0, 0]]),
            feat("Good", SQ),
            "junk",
        ],
    }
    parsed, _, warnings = parse_layout(doc, "geojson-lite")
    assert [z["id"] for z in parsed["zones"]] == ["Good"]
    assert parsed["floors"][0]["id"] == "1"  # no floor property: floor 1
    text = " ".join(warnings)
    assert "no name" in text and "MultiPolygon" in text and "fewer than 3 corners" in text and "more than once" in text


def test_geojson_lite_with_nothing_usable_is_an_error() -> None:
    with pytest.raises(ImportError_, match="no usable shapes"):
        parse_layout({"type": "FeatureCollection", "features": [feat("", SQ)]}, "geojson-lite")


# -- detection and root ----------------------------------------------------------


def test_detect() -> None:
    assert detect({"floors": [{"units": []}]}) == "riverside"
    assert detect({"type": "FeatureCollection", "features": []}) == "geojson-lite"
    for doc in ([], {"items": []}, {"floors": [{"rooms": []}]}, "text", None):
        with pytest.raises(ImportError_, match="Couldn't tell"):
            detect(doc)


def test_wrong_explicit_format_is_a_plain_error() -> None:
    with pytest.raises(ImportError_, match="FeatureCollection"):
        parse_layout({"floors": []}, "geojson-lite")
    with pytest.raises(ImportError_, match='no "floors"'):
        parse_layout({"type": "FeatureCollection", "features": []}, "riverside")


def test_root_option_picks_the_layout_inside_the_response() -> None:
    doc = {"data": {"layout": {"type": "FeatureCollection", "features": [feat("A", SQ)]}}}
    parsed, used, _ = parse_layout(doc, "auto", "data.layout")
    assert used == "geojson-lite" and parsed["zones"][0]["id"] == "A"
    with pytest.raises(ImportError_, match="Nothing found"):
        parse_layout(doc, "auto", "data.nope")


# -- merge / replace -------------------------------------------------------------


def imported(*zones: dict[str, Any], floors: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "floors": floors or [{"id": "1", "name": "Floor 1", "level": 0, "width": 40, "depth": 30}],
        "zones": list(zones),
    }


def zone(
    zid: str, x: float = 0, y: float = 0, w: float = 5, h: float = 5, floor: str = "1", **kw: Any
) -> dict[str, Any]:
    return {
        "id": zid,
        "name": zid,
        "floor_id": floor,
        "polygon": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        **kw,
    }


def test_merge_keeps_user_zones_updates_same_ids_and_drops_stale_imports() -> None:
    first, _, _ = combine({}, imported(zone("bed-1"), zone("bed-2", 10)), "merge", rec(), [])
    assert first["imported"]["zone_ids"] == ["bed-1", "bed-2"]
    # The user adds a zone and an entrance, renames the floor and gives it a plan image.
    first["zones"].append(zone("my-desk", 20, 20))
    first["entrances"] = [{"id": "e1", "name": "Main", "floor_id": "1", "point": [5, 30], "kind": "walk"}]
    first["floors"][0] |= {"name": "Ground", "plan": {"asset_id": "a" * 32, "x": 0, "y": 0, "w": 40, "h": 30}}
    first["theme"] = "dark"
    warnings: list[str] = []
    second, kept, removed = combine(
        first,
        imported(
            zone("bed-1", 1),
            zone("bed-3", 30),
            floors=[{"id": "1", "name": "Floor 1", "level": 0, "width": 35, "depth": 50}],
        ),
        "merge",
        rec(),
        warnings,
    )
    ids = [z["id"] for z in second["zones"]]
    assert ids == ["bed-1", "bed-3", "my-desk"] and kept == 1 and removed == 1  # bed-2 left the source
    assert second["zones"][0]["polygon"][0] == [1, 0]  # updated from the source
    f = second["floors"][0]
    assert f["name"] == "Ground" and f["plan"]["asset_id"] == "a" * 32  # the user's floor details win
    assert (f["width"], f["depth"]) == (40, 50)  # floors only grow, so user zones stay on them
    assert second["entrances"] == first["entrances"] and second["theme"] == "dark"
    assert validate(second) == []


def test_merge_into_an_old_single_floor_layout_keeps_its_zones_on_a_main_floor() -> None:
    old = {"width": 60, "depth": 40, "zones": [zone("desk", floor="")]}
    old["zones"][0].pop("floor_id")
    out, kept, _ = combine(old, imported(zone("bed-1")), "merge", rec(), [])
    assert kept == 1
    assert sorted(f["id"] for f in out["floors"]) == ["1", "main"]
    assert next(z for z in out["zones"] if z["id"] == "desk")["floor_id"] == "main"
    assert validate(out) == []


def test_replace_drops_user_zones_and_entrances_but_keeps_plan_images_of_same_floors() -> None:
    old = {
        "floors": [
            {
                "id": "1",
                "name": "Ground",
                "level": 0,
                "width": 50,
                "depth": 50,
                "plan": {"asset_id": "p" * 32, "x": 0, "y": 0, "w": 50, "h": 50},
            },
            {
                "id": "9",
                "name": "Roof",
                "level": 8,
                "width": 50,
                "depth": 50,
                "plan": {"asset_id": "q" * 32, "x": 0, "y": 0, "w": 50, "h": 50},
            },
        ],
        "zones": [zone("my-desk")],
        "entrances": [{"id": "e1", "name": "Main", "floor_id": "1", "point": [5, 5], "kind": "walk"}],
    }
    warnings: list[str] = []
    out, kept, removed = combine(old, imported(zone("bed-1")), "replace", rec(), warnings)
    assert [z["id"] for z in out["zones"]] == ["bed-1"] and kept == 0 and removed == 1
    assert out["entrances"] == []
    assert out["floors"] == [
        {
            "id": "1",
            "name": "Floor 1",
            "level": 0,
            "width": 40,
            "depth": 30,
            "plan": {"asset_id": "p" * 32, "x": 0, "y": 0, "w": 50, "h": 50},
        }
    ]
    assert any("1 entrance will be removed" in w for w in warnings)
    assert any("Roof" in w for w in warnings)


# -- validation ------------------------------------------------------------------


def test_validation_uses_the_layout_editor_rules() -> None:
    layout = {
        "floors": [
            {"id": "1", "name": "Floor 1", "level": 0, "width": 20, "depth": 20},
            {"id": "2", "name": "floor 1", "level": 1, "width": 5, "depth": 20},
        ],
        "zones": [
            zone("a", 18, 0),
            zone("b"),
            {**zone("c"), "name": "B"},
            {**zone("d"), "name": " "},
            {**zone("e"), "polygon": [[0, 0], [1, 1]]},
            zone("f", floor="9"),
        ],
        "entrances": [{"id": "x", "name": "Gate", "floor_id": "1", "point": [25, 5], "kind": "walk"}],
    }
    problems = validate(layout)
    text = "\n".join(problems)
    assert 'Zone "a" extends past the 20 × 20 floor' in text
    assert '2 zones are named "b"' in text
    assert "Zone d has no name" in text
    assert 'Zone "e" has no valid outline' in text
    assert "Floor size must be between 10 and 2000" in text
    assert 'Entrance "Gate" is outside' in text
    assert 'Zone "f" is on a floor that doesn\'t exist' in text
    assert '2 floors are named "floor 1"' in text


def test_merge_conflicting_names_with_user_zones_are_problems_in_the_summary() -> None:
    existing = {
        "floors": [{"id": "1", "name": "Floor 1", "level": 0, "width": 40, "depth": 30}],
        "zones": [{**zone("mine", 20, 20), "name": "bed-1"}],
    }
    doc = {"type": "FeatureCollection", "features": [feat("bed-1", SQ, floor=1, kind="room")]}
    out = build_import(existing, doc, body(format="auto", mode="merge"), rec())
    assert out.summary.kept_zones == 1
    assert any('2 zones are named "bed-1"' in p for p in out.summary.problems)


def test_summary_counts(mock_api: ModuleType) -> None:
    out = build_import({}, mock_api.build_layout(), body(), rec())
    s = out.summary
    beds = sum(len(r["beds"]) for f in mock_api.LAYOUT["floors"] for u in f["units"] for r in u["rooms"])
    assert s.format == "riverside" and s.floors == 5 and s.beds == beds
    assert s.zones_by_kind == {"corridor": 7, "room": beds, "waiting": 7}
    assert s.zones == beds + 14 and s.problems == [] and s.warnings == []
    assert out.layout["imported"]["format"] == "riverside" and out.layout["imported"]["floor_ids"] == [
        "1",
        "2",
        "3",
        "4",
        "5",
    ]
    assert out.saved is False


def test_options_reject_unknown_keys() -> None:
    with pytest.raises(ValueError):
        ImportIn.model_validate({"source_id": "s", "options": {"evil": 1}})
    with pytest.raises(ValueError):
        ImportIn.model_validate({"source_id": "s", "format": "csv"})
