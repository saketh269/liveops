"""Plain-language feed lines (describe): no field names, no arrows."""

from app.core.eventlog import describe, words


def line(asset: str, removed: bool = False, **changes: list[object]) -> str:
    fixed = {k.replace("__", "."): v for k, v in changes.items()}
    return describe({"asset_id": asset, "removed": removed, "changes": fixed})


def test_codes_read_as_words_and_names_stay() -> None:
    assert words("waiting_for_provider") == "waiting for provider"
    assert words("AT_HOSPITAL_OFFLOADING") == "at hospital · offloading"
    assert words("esi") == "ESI"
    assert words("ED-02") == "ED-02" and words("Radiology – MRI") == "Radiology – MRI"


def test_zone_and_status_change_is_one_sentence() -> None:
    text = line(
        "P7401887", zone=["ED Waiting Room", "ED-02"], attributes__status=["waiting_room", "waiting_for_provider"]
    )
    assert text == "P7401887 moved from ED Waiting Room to ED-02 · now waiting for provider"


def test_status_change() -> None:
    assert (
        line("ED-11", state=["in_use", "cleaning"], attributes__status=["occupied", "dirty"])
        == "ED-11 is dirty (was occupied)"
    )
    assert line("B1", state=[None, "free"]) == "B1 is now free"


def test_fleet_zone_named_by_status_is_not_a_move() -> None:
    text = line(
        "M1",
        zone=["en_route_to_scene", "transporting_to_hospital"],
        attributes__status=["en_route_to_scene", "transporting_to_hospital"],
        attributes__latitude=[1.0, 1.1],
    )
    assert text == "M1 is transporting to hospital"


def test_moves_arrivals_and_removals() -> None:
    assert (
        line("S1", zone=["3W-NS", "3W-305A"], attributes__badge_last_seen=["a", "b"])
        == "S1 moved from 3W-NS to 3W-305A"
    )
    assert line("P2", zone=[None, "ED Waiting Room"]) == "P2 arrived in ED Waiting Room"
    assert (
        line("P3", zone=[None, "ED Waiting Room"], attributes__status=[None, "waiting_room"])
        == "P3 arrived in ED Waiting Room"
    )
    gone = line(
        "P9",
        removed=True,
        label=["P7401859", None],
        attributes__status=["pending_discharge", None],
        zone=["4E-401A", None],
    )
    assert gone == "P7401859 left the map (discharged)"
    assert line("B1", removed=True, state=["free", None]) == "B1 left the map"


def test_other_changes_stay_short_and_plain() -> None:
    assert line("S1", attributes__badge_last_seen=["a", "b"]) == "S1 updated: badge last seen"
    assert line("B1", attributes__patient_count=[0, 2]) == "B1 patient count is now 2"
    assert line("P1", anchor=[None, "ED-02"]) == "P1 is now in bed ED-02"
    for text in (line("M1", attributes__latitude=[1, 2]), line("P1", attributes__status=["a_b", "c_d"])):
        assert "→" not in text and "_" not in text and "attributes" not in text
