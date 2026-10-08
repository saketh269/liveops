"""Configure a Live Ops site from a Riverside-style hospital API (test tool).

Creates the sources, mappings and floor layout that site "hs" uses on the user's PC:
six REST sources (beds, patients, staff, ambulances, cleaning tasks, transport requests)
with X-API-Key sign-in, polled every 3 s, and a layout built from /api/floor-layout
(floors, one zone per bed, corridors, nurse stations, fleet bay, support areas).

  python tools/riverside-mock/setup_site.py --liveops http://localhost:8000 \
      --api http://127.0.0.1:8500 --site hs [--import-layout]

`--api` is the address Live Ops' backend uses to reach the hospital API.
`--import-layout` lets Live Ops read the floors, beds, corridors and nurse stations itself
(POST /api/sites/{id}/layout/import, ADR 0007) through the beds source; this script then only
adds the Riverside-only areas (fleet bays, support areas, basement, entrances). If that Live Ops
has no import endpoint yet, it falls back to building the whole layout here.

Sign-in (ADR 0008): pass an API token with `--token lo_…` (or env LIVEOPS_TOKEN); create one
under My account → API tokens. For a local dev install, `--email/--password` signs in instead
and uses the session cookie plus its CSRF token.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.request as u
from typing import Any

KEY = "demo-key"

# Sign-in for requests to Live Ops (ADR 0008): set by sign_in_to_liveops().
_jar = http.cookiejar.CookieJar()
_opener = u.build_opener(u.HTTPCookieProcessor(_jar))
_liveops = ""
_auth_headers: dict[str, str] = {}


def req(base: str, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None) -> Any:
    extra = _auth_headers if _liveops and base == _liveops else {}
    r = u.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                  headers={"Content-Type": "application/json", **extra, **(headers or {})})
    with _opener.open(r, timeout=60) as x:
        raw = x.read()
        return json.loads(raw) if raw else None


def rect(x: float, y: float, w: float, h: float) -> list[list[float]]:
    r1 = lambda v: round(v, 2)  # noqa: E731
    return [[r1(x), r1(y)], [r1(x + w), r1(y)], [r1(x + w), r1(y + h)], [r1(x), r1(y + h)]]


def build_layout(fl: dict[str, Any]) -> dict[str, Any]:
    return add_extras(build_base(fl))


def build_base(fl: dict[str, Any]) -> dict[str, Any]:
    """Floors and zones from /api/floor-layout: what Live Ops' layout import produces for this format."""
    floors, zones = [], []
    for f in fl["floors"]:
        fid = str(f["floor"])
        width = depth = 0.0
        for un in f["units"]:
            width, depth = max(width, un["x"] + un["width"]), max(depth, un["y"] + un["height"])
            zones.append({"id": f"{un['unit_id']}-corridor", "name": f"{un['unit_id']} corridor", "kind": "corridor",
                          "floor_id": fid, "polygon": rect(un["x"], un["y"] + 7, un["width"], 9)})
            ns = un["nurse_station"]
            zones.append({"id": f"{un['unit_id']}-NS", "name": f"{un['unit_id']}-NS", "kind": "waiting", "floor_id": fid,
                          "polygon": rect(ns["x"] - 3, ns["y"], 6, 3), "doors": [[ns["x"], ns["y"]]]})
            for room in un["rooms"]:
                top = room["y"] < un["y"] + 7
                door_y = room["y"] + room["height"] if top else room["y"]
                n = len(room["beds"])
                for i, bed in enumerate(room["beds"]):
                    w = room["width"] / n
                    x = room["x"] + i * w
                    zones.append({"id": bed["bed_id"], "name": bed["bed_id"], "kind": "room", "floor_id": fid,
                                  "polygon": rect(x, room["y"], w, room["height"]), "doors": [[round(x + w / 2, 2), door_y]]})
        floors.append({"id": fid, "name": f"Floor {f['floor']}", "level": f["floor"] - 1, "width": width + 2, "depth": depth + 2})
    return {"floors": floors, "zones": zones}


def add_extras(layout: dict[str, Any]) -> dict[str, Any]:
    """Riverside-only areas the floor layout doesn't describe: fleet bays, support areas, basement, entrances."""
    floors, zones = layout["floors"], layout["zones"]
    f1 = next(f for f in floors if f["id"] == "1")
    statuses = ["available", "en_route_to_scene", "transporting_to_hospital", "on_scene", "at_hospital_offloading", "out_of_service"]
    bw = (f1["width"] - 2 * (len(statuses) + 1)) / len(statuses)
    for i, s in enumerate(statuses):
        zones.append({"id": f"fleet-{s}", "name": s, "kind": "bay", "floor_id": "1", "polygon": rect(2 + i * (bw + 2), f1["depth"] + 2, bw, 8)})
    sx = f1["width"] + 2
    for i, n in enumerate(["Command Center 1F", "Radiology – CT 2", "Radiology – MRI", "ED Waiting Room"]):
        zones.append({"id": "area-" + "".join(c if c.isalnum() else "-" for c in n.lower()), "name": n,
                      "kind": "waiting" if "Waiting" in n else "room", "floor_id": "1",
                      "polygon": rect(sx, 2 + i * 7, 14, 5.5), "doors": [[sx, 4.5 + i * 7]]})
    zones.append({"id": "f1-link", "name": "Floor 1 link corridor", "kind": "corridor", "floor_id": "1", "polygon": rect(54, 7, sx - 54, 9)})
    f1["width"], f1["depth"] = sx + 16, f1["depth"] + 12
    floors.insert(0, {"id": "B1", "name": "Basement B1", "level": -1, "width": 40, "depth": 20})
    for i, n in enumerate(["Transport Hub B1", "EVS Office B1"]):
        zones.append({"id": "area-" + "".join(c if c.isalnum() else "-" for c in n.lower()), "name": n, "kind": "room",
                      "floor_id": "B1", "polygon": rect(2 + i * 19, 2, 17, 10), "doors": [[10.5 + i * 19, 12]]})
    zones.append({"id": "B1-corridor", "name": "B1 corridor", "kind": "corridor", "floor_id": "B1", "polygon": rect(0, 12, 40, 6)})
    entrances = [{"id": "main", "name": "Main entrance", "floor_id": "1", "point": [round(f1["width"] / 2, 1), 26], "kind": "walk"},
                 {"id": "amb-bay", "name": "Ambulance bay", "floor_id": "1", "point": [2, 26], "kind": "ambulance"}]
    return {**layout, "width": f1["width"], "depth": f1["depth"], "floors": floors, "zones": zones, "entrances": entrances}


MAPPINGS: list[tuple[str, str, str, dict[str, Any]]] = [
    ("Riverside – Beds (live)", "/api/beds", "beds", {
        "id_field": "bed_id", "fields": {"zone": "bed_id", "state": "status", "label": "bed_id", "floor": "floor"}, "kind": "bed",
        "state_map": {"available": "free", "occupied": "in_use", "reserved": "in_use", "dirty": "cleaning", "cleaning": "cleaning", "blocked": "alert"},
        "attributes": ["unit_id", "room", "bed_type", "status", "status_since", "blocked_reason", "patient_id", "isolation_capable"]}),
    ("Riverside – Patients", "/api/patients", "patients", {
        "id_field": "patient_id", "fields": {"zone": "current_location", "state": "status", "label": "patient_id", "anchor": "bed_id"}, "kind": "patient",
        "state_map": {"admitted": "in_use", "in_treatment": "in_use", "awaiting_results": "in_use", "off_unit": "in_use", "discharge_ordered": "free",
                      "ready_for_discharge": "free", "pending_discharge": "free", "boarding": "alert", "waiting_room": "alert", "waiting_for_provider": "alert"},
        "attributes": ["unit_id", "bed_id", "status", "encounter_class", "esi_acuity", "admit_time", "expected_discharge", "isolation"],
        "filter": [{"column": "status", "op": "ne", "value": "discharged"}]}),
    ("Riverside – Staff", "/api/staff", "staff", {
        "id_field": "staff_id", "fields": {"zone": "current_location", "state": "status", "label": "name", "role": "role"}, "kind": "staff",
        "state_map": {"on_duty": "in_use", "in_procedure": "in_use", "on_break": "free"},
        "attributes": ["role", "department", "shift", "status", "badge_last_seen"]}),
    ("Riverside – Ambulances", "/api/ambulances", "ambulances", {
        "id_field": "call_sign", "fields": {"zone": "status", "state": "status", "label": "unit_id"}, "kind": "ambulance",
        "state_map": {"available": "free", "en_route_to_scene": "in_use", "transporting_to_hospital": "in_use", "on_scene": "in_use",
                      "at_hospital_offloading": "cleaning", "out_of_service": "alert"},
        "attributes": ["type", "status", "latitude", "longitude", "destination", "eta_minutes", "crew", "home_station", "speed_mph"]}),
    ("Riverside – Cleaning tasks", "/api/cleaning-tasks", "cleaning_tasks", {
        "id_field": "task_id", "match_key": "bed_id", "fields": {}, "attributes": ["status", "priority", "clean_type", "assigned_to", "created_at", "started_at", "target_minutes"],
        "filter": [{"column": "status", "op": "ne", "value": "completed"}]}),
    ("Riverside – Transport requests", "/api/transport-requests", "transport_requests", {
        "id_field": "request_id", "match_key": "patient_id", "fields": {}, "attributes": ["status", "from", "to", "mode", "priority"],
        "filter": [{"column": "status", "op": "ne", "value": "completed"}]}),
]


def import_layout(liveops: str, site_id: str, source_id: str) -> dict[str, Any] | None:
    """Layout built by Live Ops from the source (preview only), or None if this Live Ops can't import."""
    try:
        out = req(liveops, "POST", f"/api/sites/{site_id}/layout/import", {
            "source_id": source_id, "path": "/api/floor-layout", "format": "riverside", "mode": "replace", "dry_run": True})
    except u.HTTPError as e:
        if e.code in (404, 405):  # older Live Ops: no import endpoint
            return None
        raise RuntimeError(f"layout import: {e.read()[:300]!r}") from None
    for w in out["summary"]["warnings"]:
        print("layout import:", w)
    layout: dict[str, Any] = out["layout"]
    return layout


def sign_in_to_liveops(liveops: str, token: str | None, email: str | None, password: str | None) -> None:
    """Bearer API token, or (local dev) sign in with email/password and use the session + CSRF cookie."""
    global _liveops
    _liveops = liveops
    if token:
        _auth_headers["Authorization"] = f"Bearer {token}"
        return
    if email and password:
        try:
            req(liveops, "POST", "/api/auth/signin", {"email": email, "password": password, "remember": False})
        except u.HTTPError as e:
            sys.exit(f"Sign-in to Live Ops failed ({e.code}): {e.read()[:300]!r}")
        csrf = next((c.value for c in _jar if c.name == "liveops_csrf"), "")
        _auth_headers["X-CSRF-Token"] = csrf
        return
    print("No --token or --email/--password given; this only works if Live Ops runs with LIVEOPS_AUTH_REQUIRED=false.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--liveops", default="http://localhost:8000")
    ap.add_argument("--api", default="http://127.0.0.1:8500", help="hospital API address as Live Ops' backend sees it")
    ap.add_argument("--fetch", default=None, help="hospital API address as this script sees it (default: --api)")
    ap.add_argument("--site", default="hs")
    ap.add_argument("--import-layout", action="store_true",
                    help="let Live Ops read the floor layout through the beds source (falls back to building it here)")
    ap.add_argument("--token", default=os.environ.get("LIVEOPS_TOKEN"),
                    help="Live Ops API token (lo_…), from My account → API tokens; or env LIVEOPS_TOKEN")
    ap.add_argument("--email", help="local dev: sign in with this account instead of a token")
    ap.add_argument("--password", default=os.environ.get("LIVEOPS_PASSWORD"), help="with --email (or env LIVEOPS_PASSWORD)")
    a = ap.parse_args()
    sign_in_to_liveops(a.liveops, a.token, a.email, a.password)
    fetch = a.fetch or a.api
    sites = req(a.liveops, "GET", "/api/sites")
    site = next((s for s in sites if s["name"].lower() == a.site.lower()), None)
    layout: dict[str, Any] | None = None
    if not a.import_layout:
        layout = build_layout(req(fetch, "GET", "/api/floor-layout", headers={"X-API-Key": KEY}))
        site = req(a.liveops, "PUT", f"/api/sites/{site['id']}", {"layout": layout}) if site else \
            req(a.liveops, "POST", "/api/sites", {"name": a.site, "template": "hospital", "layout": layout})
    elif site is None:
        site = req(a.liveops, "POST", "/api/sites", {"name": a.site, "template": "hospital"})
    base = {"base_url": a.api, "method": "GET", "record_path": "items", "auth": "api_key", "api_key_header": "X-API-Key",
            "pagination": "none", "allow_http": True, "allow_private_network": True, "timeout_s": 15}
    existing = {s["name"]: s for s in req(a.liveops, "GET", "/api/sources")}
    mapped = {(m["source_id"], m["dataset"]) for m in req(a.liveops, "GET", f"/api/mappings?site_id={site['id']}")}
    source_ids: dict[str, str] = {}
    for name, path, ds, cfg in MAPPINGS:
        src = existing.get(name) or req(a.liveops, "POST", "/api/sources", {"name": name, "type": "rest",
                                        "settings": {**base, "path": path, "dataset_name": ds}, "secrets": {"api_key": KEY}})
        source_ids[ds] = src["id"]
        if (src["id"], ds) in mapped:
            continue
        try:
            req(a.liveops, "POST", "/api/mappings", {"site_id": site["id"], "source_id": src["id"], "dataset": ds, "config": cfg,
                                                      "options": {"poll_interval_s": 3}, "active": True})
        except u.HTTPError as e:  # e.g. `anchor` not supported yet: retry without it
            if "anchor" in cfg.get("fields", {}):
                cfg = {**cfg, "fields": {k: v for k, v in cfg["fields"].items() if k != "anchor"}}
                req(a.liveops, "POST", "/api/mappings", {"site_id": site["id"], "source_id": src["id"], "dataset": ds, "config": cfg,
                                                          "options": {"poll_interval_s": 3}, "active": True})
            else:
                raise RuntimeError(f"{name}: {e.read()[:300]!r}") from None
    how = "built here"
    if layout is None:
        imported = import_layout(a.liveops, site["id"], source_ids["beds"])
        if imported is not None:
            layout, how = add_extras(imported), "imported by Live Ops"
        else:
            print("This Live Ops has no layout import; building the layout here instead.")
            layout = build_layout(req(fetch, "GET", "/api/floor-layout", headers={"X-API-Key": KEY}))
        site = req(a.liveops, "PUT", f"/api/sites/{site['id']}", {"layout": layout})
    print(f"site {a.site} ({site['id']}): {len(layout['floors'])} floors, {len(layout['zones'])} zones ({how}), "
          f"{len(MAPPINGS)} mappings")


if __name__ == "__main__":
    main()
