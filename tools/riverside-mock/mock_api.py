"""Stand-in for the Riverside General hospital API (test tool only, never shipped).

Same endpoints, auth and JSON shapes as the API on the user's PC (http://localhost:8000):
/api/floor-layout, /api/units, /api/beds, /api/patients, /api/staff, /api/ambulances,
/api/cleaning-tasks, /api/transport-requests, plus PATCH /api/beds/{id} and PATCH /api/patients/{id}
(test tool: move a patient, e.g. {"bed_id": "3W-305A", "status": "admitted"}). Lists return
{"count": n, "items": [...]}. Auth: X-API-Key header, Bearer token or ?api_key=.

The floor layout follows the real one: 5 floors, ED (20 rooms), ICU (12), CVU (8 x 2 beds),
3W (12 x 2), 4E (12 x 2), L&D (12), PEDS (10); rooms 4.5 x 5 m in two rows (y 2 and 16) with a
corridor in between. All people are synthetic; patients carry ids only.

Run:  python tools/riverside-mock/mock_api.py --port 8500 [--pace 1] [--seed 1]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

KEY = "demo-key"
LOCK = threading.Lock()


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


UNITS = [
    # unit_id, name, floor, x, width, rooms, beds per room, unit_type
    ("ED", "Emergency Department", 1, 0, 54, 20, 1, "emergency"),
    ("ICU", "Intensive Care Unit", 2, 0, 34, 12, 1, "critical"),
    ("CVU", "Cardiac Telemetry", 2, 40, 24, 8, 2, "telemetry"),
    ("3W", "3 West Med-Surg", 3, 0, 34, 12, 2, "med_surg"),
    ("4E", "4 East Med-Surg", 4, 0, 34, 12, 2, "med_surg"),
    ("L&D", "Labor and Delivery", 5, 0, 34, 12, 1, "obstetrics"),
    ("PEDS", "Pediatrics", 5, 40, 29, 10, 1, "pediatrics"),
]


def build_layout() -> dict[str, Any]:
    floors: dict[int, list[dict[str, Any]]] = {}
    for uid, name, floor, ux, width, nrooms, per, _ in UNITS:
        per_row = nrooms // 2
        rooms = []
        for i in range(nrooms):
            top = i < per_row
            col = i if top else i - per_row
            rx, ry = ux + 2 + 5 * col, 2 if top else 16
            num = (floor * 100 + i + 1) if uid not in ("ED",) else i + 1
            rid = f"{uid}-{num:02d}" if uid == "ED" else f"{uid}-{num}"
            if per == 1:
                beds = [{"bed_id": rid, "x": rx + 1, "y": ry + 2.5}]
            else:
                beds = [{"bed_id": f"{rid}A", "x": rx + 1, "y": ry + 2.5}, {"bed_id": f"{rid}B", "x": rx + 3.2, "y": ry + 2.5}]
            rooms.append({"room_id": rid, "x": rx, "y": ry, "width": 4.5, "height": 5, "beds": beds})
        floors.setdefault(floor, []).append({
            "unit_id": uid, "name": name, "x": ux, "y": 0, "width": width, "height": 26,
            "nurse_station": {"x": ux + width / 2, "y": 9.5}, "rooms": rooms,
        })
    return {
        "hospital": "Riverside General Hospital",
        "floors": [{"floor": f, "units": u} for f, u in sorted(floors.items())],
        "units_note": "Coordinates in meters on a per-floor grid. Corridor runs y=7..9 between room rows.",
    }


LAYOUT = build_layout()
BED_INDEX = {
    b["bed_id"]: (f["floor"], u["unit_id"], r["room_id"])
    for f in LAYOUT["floors"] for u in f["units"] for r in u["rooms"] for b in r["beds"]
}
ROLES = [("Registered Nurse", 0.5), ("Charge Nurse", 0.08), ("Patient Care Tech", 0.14), ("Hospitalist", 0.06),
         ("Emergency Physician", 0.04), ("Intensivist", 0.03), ("Transporter", 0.05), ("EVS Technician", 0.07),
         ("Bed Manager", 0.015), ("House Supervisor", 0.015)]
PATIENT_STATUS_ED = ["waiting_room", "in_treatment", "awaiting_results", "boarding", "waiting_for_provider"]
PATIENT_STATUS_IP = ["admitted", "admitted", "admitted", "discharge_ordered", "pending_discharge", "ready_for_discharge", "off_unit"]
FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Drew", "Rowan"]
LAST = ["Patel", "Kim", "Alvarez", "Okafor", "Rao", "Nguyen", "Lindqvist", "Moore", "Chen", "Garcia", "Brooks", "Silva"]


class Hospital:
    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.beds: dict[str, dict[str, Any]] = {}
        self.patients: dict[str, dict[str, Any]] = {}
        self.staff: dict[str, dict[str, Any]] = {}
        self.ambulances: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, dict[str, Any]] = {}
        self.transports: dict[str, dict[str, Any]] = {}
        self.pid = 7400100
        self.tid = 9000
        self.rid = 500
        self._seed()

    # ---- seed -------------------------------------------------------------
    def _new_patient(self, unit: str, bed: str | None, status: str) -> dict[str, Any]:
        self.pid += 1
        pid = f"P{self.pid}"
        p = {
            "patient_id": pid, "mrn": f"RGH{self.pid}", "encounter_id": f"E{50000 + self.pid % 10000}",
            "encounter_class": "emergency" if unit == "ED" else "inpatient", "unit_id": unit, "bed_id": bed,
            "current_location": bed or ("ED Waiting Room" if unit == "ED" else unit),
            "admit_time": now_iso(), "status": status, "esi_acuity": self.rng.randint(1, 5) if unit == "ED" else None,
            "attending": None, "assigned_nurse": None, "expected_discharge": None, "isolation": self.rng.random() < 0.08,
            "assigned_bed": None, "updated_at": now_iso(),
        }
        self.patients[pid] = p
        return p

    def _seed(self) -> None:
        r = self.rng
        for bed_id, (floor, unit, room) in BED_INDEX.items():
            st = r.choices(["occupied", "available", "dirty", "cleaning", "reserved", "blocked"], [70, 14, 7, 4, 4, 1])[0]
            self.beds[bed_id] = {
                "bed_id": bed_id, "unit_id": unit, "room": room.split("-")[-1], "floor": floor,
                "bed_type": "ED Stretcher" if unit == "ED" else "Med-Surg", "isolation_capable": r.random() < 0.3,
                "status": st, "status_since": now_iso(), "blocked_reason": "Equipment repair" if st == "blocked" else None,
                "patient_id": None, "updated_at": now_iso(),
            }
            if st == "occupied":
                status = r.choice(PATIENT_STATUS_ED if unit == "ED" else PATIENT_STATUS_IP)
                if status == "waiting_room":
                    status = "in_treatment"
                p = self._new_patient(unit, bed_id, status)
                self.beds[bed_id]["patient_id"] = p["patient_id"]
            if st in ("dirty", "cleaning"):
                self._new_task(bed_id, "in_progress" if st == "cleaning" else "queued")
        for _ in range(7):
            self._new_patient("ED", None, "waiting_room")
        n = 0
        for role, share in ROLES:
            for _ in range(max(1, round(74 * share))):
                n += 1
                unit = r.choice([u[0] for u in UNITS])
                beds = [b for b, v in BED_INDEX.items() if v[1] == unit]
                loc = r.choice([f"{unit}-NS", r.choice(beds)])
                if role == "Transporter":
                    loc = "Transport Hub B1"
                if role == "EVS Technician":
                    loc = r.choice(["EVS Office B1", r.choice(beds)])
                self.staff[f"S{1000 + n}"] = {
                    "staff_id": f"S{1000 + n}", "name": f"{r.choice(FIRST)} {r.choice(LAST)}", "role": role,
                    "department": unit, "current_location": loc, "shift": "day", "status": r.choice(["on_duty"] * 6 + ["on_break", "in_procedure"]),
                    "phone_ext": str(4000 + n), "badge_last_seen": now_iso(), "updated_at": now_iso(),
                }
        for p in r.sample([p for p in self.patients.values() if p["bed_id"]], k=8):
            self._new_transport(p)
        for i in range(1, 9):
            self.ambulances[f"M{i:02d}"] = {
                "unit_id": f"Medic {i}", "call_sign": f"M{i:02d}", "type": "ALS" if i % 2 else "BLS", "status": "available",
                "latitude": 40.74 + r.uniform(-0.05, 0.05), "longitude": -73.99 + r.uniform(-0.05, 0.05), "heading_deg": r.randint(0, 359),
                "speed_mph": 0, "home_station": f"Station {1 + i % 4}", "crew": 2, "destination": None, "eta_minutes": None,
                "patient_summary": None, "last_gps_update": now_iso(), "updated_at": now_iso(),
            }

    def _new_task(self, bed_id: str, status: str) -> None:
        self.tid += 1
        self.tasks[f"T{self.tid}"] = {
            "task_id": f"T{self.tid}", "bed_id": bed_id, "unit_id": BED_INDEX[bed_id][1], "clean_type": "discharge",
            "priority": "stat" if BED_INDEX[bed_id][1] == "ED" else "routine", "status": status, "assigned_to": None,
            "created_at": now_iso(), "started_at": now_iso() if status == "in_progress" else None, "target_minutes": 45,
            "updated_at": now_iso(),
        }

    def _new_transport(self, p: dict[str, Any]) -> None:
        self.rid += 1
        self.transports[f"TR{self.rid}"] = {
            "request_id": f"TR{self.rid}", "patient_id": p["patient_id"], "from": p["bed_id"] or p["unit_id"],
            "to": self.rng.choice(["Radiology – CT 2", "Radiology – MRI", "Dialysis", "Echo Lab"]), "mode": self.rng.choice(["wheelchair", "stretcher", "bed"]),
            "priority": self.rng.choice(["routine", "routine", "stat"]), "status": self.rng.choice(["requested", "assigned", "in_progress"]),
            "requested_at": now_iso(), "updated_at": now_iso(),
        }

    # ---- one step of hospital life -------------------------------------------
    def step(self) -> None:
        r = self.rng
        with LOCK:
            t = now_iso()
            beds = list(self.beds.values())
            # discharge one inpatient now and then
            ready = [p for p in self.patients.values() if p["status"] in ("ready_for_discharge", "pending_discharge") and p["bed_id"]]
            if ready and r.random() < 0.35:
                p = r.choice(ready)
                b = self.beds[p["bed_id"]]
                b.update(status="dirty", status_since=t, patient_id=None, updated_at=t)
                self._new_task(b["bed_id"], "queued")
                p.update(status="discharged", bed_id=None, current_location="Discharged", updated_at=t)
            # inpatients move along
            for p in r.sample(list(self.patients.values()), k=min(4, len(self.patients))):
                nxt = {"admitted": "discharge_ordered", "discharge_ordered": "pending_discharge",
                       "pending_discharge": "ready_for_discharge", "in_treatment": "awaiting_results",
                       "awaiting_results": "boarding"}.get(p["status"])
                if nxt and r.random() < 0.25:
                    p.update(status=nxt, updated_at=t)
            # cleaning progresses
            for task in list(self.tasks.values()):
                b = self.beds[task["bed_id"]]
                if task["status"] == "queued" and r.random() < 0.3:
                    evs = [s for s in self.staff.values() if s["role"] == "EVS Technician"]
                    who = r.choice(evs)
                    task.update(status="in_progress", started_at=t, assigned_to=who["staff_id"], updated_at=t)
                    who.update(current_location=b["bed_id"], updated_at=t)
                    b.update(status="cleaning", status_since=t, updated_at=t)
                elif task["status"] == "in_progress" and r.random() < 0.3:
                    task.update(status="completed", updated_at=t)
                    b.update(status="available", status_since=t, updated_at=t)
            # waiting room -> ED bed; boarders -> inpatient bed
            free_ed = [b for b in beds if b["unit_id"] == "ED" and b["status"] == "available"]
            waiting = [p for p in self.patients.values() if p["status"] == "waiting_room"]
            if free_ed and waiting:
                b, p = free_ed[0], waiting[0]
                b.update(status="occupied", status_since=t, patient_id=p["patient_id"], updated_at=t)
                p.update(status="in_treatment", bed_id=b["bed_id"], current_location=b["bed_id"], updated_at=t)
            boarders = [p for p in self.patients.values() if p["status"] == "boarding"]
            free_ip = [b for b in beds if b["unit_id"] not in ("ED",) and b["status"] == "available"]
            if boarders and free_ip and r.random() < 0.3:
                p, b = boarders[0], r.choice(free_ip)
                old = self.beds[p["bed_id"]]
                old.update(status="dirty", status_since=t, patient_id=None, updated_at=t)
                self._new_task(old["bed_id"], "queued")
                b.update(status="occupied", status_since=t, patient_id=p["patient_id"], updated_at=t)
                p.update(status="admitted", unit_id=b["unit_id"], bed_id=b["bed_id"], current_location=b["bed_id"], encounter_class="inpatient", updated_at=t)
            if r.random() < 0.3 and len([p for p in self.patients.values() if p["status"] == "waiting_room"]) < 12:
                self._new_patient("ED", None, "waiting_room")
            # staff move between beds and stations
            for s in r.sample(list(self.staff.values()), k=6):
                unit = s["department"]
                beds_u = [b for b, v in BED_INDEX.items() if v[1] == unit]
                if s["role"] in ("Transporter",):
                    continue
                s.update(current_location=r.choice([f"{unit}-NS", r.choice(beds_u)]), badge_last_seen=t, updated_at=t)
            # ambulances
            for a in self.ambulances.values():
                if a["status"] == "available" and r.random() < 0.04:
                    a.update(status="en_route_to_scene", eta_minutes=None, destination=None, speed_mph=45, updated_at=t)
                elif a["status"] == "en_route_to_scene" and r.random() < 0.2:
                    a.update(status="transporting_to_hospital", destination="Riverside General", eta_minutes=r.randint(5, 14), updated_at=t)
                elif a["status"] == "transporting_to_hospital":
                    eta = max(0, (a["eta_minutes"] or 1) - 1)
                    a.update(eta_minutes=eta, updated_at=t)
                    if eta == 0:
                        a.update(status="at_hospital_offloading", speed_mph=0, updated_at=t)
                        if len([p for p in self.patients.values() if p["status"] == "waiting_room"]) < 14:
                            self._new_patient("ED", None, "waiting_room")
                elif a["status"] == "at_hospital_offloading" and r.random() < 0.15:
                    a.update(status="available", destination=None, eta_minutes=None, updated_at=t)
                if a["speed_mph"]:
                    a["latitude"] += r.uniform(-0.002, 0.002)
                    a["longitude"] += r.uniform(-0.002, 0.002)
                    a["last_gps_update"] = t
            # transports move along
            for tr in list(self.transports.values()):
                if tr["status"] != "completed" and r.random() < 0.15:
                    tr.update(status={"requested": "assigned", "assigned": "in_progress", "in_progress": "completed"}[tr["status"]], updated_at=t)
            if r.random() < 0.2:
                cands = [p for p in self.patients.values() if p["bed_id"]]
                if cands:
                    self._new_transport(r.choice(cands))
            for k in [k for k, v in self.transports.items() if v["status"] == "completed"][:-5]:
                del self.transports[k]
            # drop discharged patients after a while
            for pid in [p for p, v in self.patients.items() if v["status"] == "discharged"][:-5]:
                del self.patients[pid]

    def listing(self, name: str) -> list[dict[str, Any]]:
        with LOCK:
            src = {"beds": self.beds, "patients": self.patients, "staff": self.staff, "ambulances": self.ambulances,
                   "cleaning-tasks": self.tasks, "transport-requests": self.transports}[name]
            return [dict(v) for v in src.values()]


def make_handler(h: Hospital) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _send(self, code: int, body: Any) -> None:
            raw = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(raw)

        def _authed(self) -> bool:
            q = parse_qs(urlparse(self.path).query)
            return (self.headers.get("X-API-Key") == KEY or self.headers.get("Authorization") == f"Bearer {KEY}"
                    or q.get("api_key", [None])[0] == KEY)

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/")
            if path == "/api/health":
                return self._send(200, {"ok": True})
            if not self._authed():
                return self._send(401, {"detail": "Missing or invalid API key"})
            if path == "/api/floor-layout":
                return self._send(200, LAYOUT)
            if path == "/api/units":
                items = [{"unit_id": u[0], "unit_name": u[1], "floor": u[2], "unit_type": u[7], "bed_count": u[5] * u[6],
                          "nurse_station": f"{u[0]}-NS", "updated_at": now_iso()} for u in UNITS]
                return self._send(200, {"count": len(items), "items": items})
            name = path.removeprefix("/api/")
            if name in ("beds", "patients", "staff", "ambulances", "cleaning-tasks", "transport-requests"):
                items = h.listing(name)
                return self._send(200, {"count": len(items), "items": items})
            return self._send(404, {"detail": "Not Found"})

        def do_PATCH(self) -> None:  # noqa: N802
            if not self._authed():
                return self._send(401, {"detail": "Missing or invalid API key"})
            path = urlparse(self.path).path
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if path.startswith("/api/beds/"):
                bed_id = path.removeprefix("/api/beds/")
                with LOCK:
                    b = h.beds.get(bed_id)
                    if not b:
                        return self._send(404, {"detail": "Not Found"})
                    b.update({k: v for k, v in body.items() if k in ("status", "blocked_reason")}, status_since=now_iso(), updated_at=now_iso())
                    return self._send(200, b)
            if path.startswith("/api/patients/"):
                pid = path.removeprefix("/api/patients/")
                with LOCK:
                    p = h.patients.get(pid)
                    if not p:
                        return self._send(404, {"detail": "Not Found"})
                    bed = body.get("bed_id", p["bed_id"])
                    if bed is not None and bed not in h.beds:
                        return self._send(422, {"detail": f"Unknown bed {bed}"})
                    if bed != p["bed_id"]:  # the old bed needs cleaning, the new one is taken
                        if p["bed_id"] in h.beds:
                            h.beds[p["bed_id"]].update(status="dirty", status_since=now_iso(), patient_id=None, updated_at=now_iso())
                        if bed is not None:
                            h.beds[bed].update(status="occupied", status_since=now_iso(), patient_id=pid, updated_at=now_iso())
                            p["unit_id"] = BED_INDEX[bed][1]
                    p.update({k: v for k, v in body.items() if k in ("status", "current_location", "unit_id")}, bed_id=bed,
                             updated_at=now_iso())
                    if "current_location" not in body and "bed_id" in body:
                        p["current_location"] = bed or p["unit_id"]
                    return self._send(200, p)
            return self._send(404, {"detail": "Not Found"})

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8500)
    ap.add_argument("--pace", type=float, default=1.0, help="hospital steps per second")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    h = Hospital(a.seed)

    def loop() -> None:
        while True:
            time.sleep(1 / max(0.05, a.pace))
            h.step()

    threading.Thread(target=loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(h))
    print(f"riverside mock on http://127.0.0.1:{a.port} (key {KEY})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
