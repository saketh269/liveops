"""Keeps the mock hospital systems busy, like a real day in a busy hospital.

TEST TOOL ONLY. Lives in tools/hospital-sim/ and never ships in product images.

Writes ONLY to the source systems (epic, kronos, evs, gps, rtls). It never
touches the portal. The portal sees each change the way it would in
production: through CDC on the base tables or the unified views.

What happens (one tick = one simulated minute; --pace ticks per real second):
- Patients arrive (walk-in, or by ambulance with an ETA countdown), wait in
  triage, get an ER bed by acuity, then are admitted (ICU / ward / Pediatrics),
  board in the ER when no bed is free, transfer, and are discharged.
- A vacated bed goes occupied -> cleaning: an EVS task is opened, a cleaner is
  assigned, walks there, cleans, and the bed becomes free.
- Nurses round on their unit's beds (kronos.rounds with bed_id), doctors move
  between units, and two crews swap at shift change with a short handover.
- rtls.locations holds one row per person in the building (badge tracking).
  Patients carry synthetic refs only (P-1234), never names.
- Occasional ER rushes make the waiting room and boarding alerts meaningful.
- Deterministic for a given starting database and --seed.

Schema additions are idempotent (ADD COLUMN only when missing, CREATE ... IF
NOT EXISTS) so they are safe to rerun on an existing `sources` database.
"""
from __future__ import annotations

import argparse
import math
import os
import random
import re
import signal
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import psycopg

DEFAULT_DSN = "postgresql://postgres:liveops@localhost:5433/sources"
DEFAULT_UNITS = "ER:8,ICU:6,General:16,Pediatrics:6"
DEFAULT_NURSES = "ER:3,ICU:3,General:4,Pediatrics:2"
DEFAULT_DOCTORS = "ER:2,ICU:1,General:2,Pediatrics:1"

ER, ICU, PEDS = "ER", "ICU", "Pediatrics"
ENTRANCE, WAITING, AMB_BAY, LOBBY, EVS = "Entrance", "Waiting Room", "Ambulance Bay", "Lobby", "EVS"
CREWS = ("A", "B")
START_CLOCK = 16 * 60          # the simulated day starts at 16:00
SHIFT_ANCHOR = 7 * 60          # shifts change at 07:00 (and every --shift-minutes after)
HANDOVER = 15                  # incoming crew arrives this many minutes early

# Length of stay medians in simulated minutes. Inpatient stays are compressed
# (hours, not days) so beds turn over while someone is watching the map.
ER_LOS = {1: 180, 2: 190, 3: 150, 4: 80, 5: 60}
WARD_LOS = {ICU: 900, PEDS: 360}
GENERAL_LOS = 540
ADMIT_P = {1: 0.9, 2: 0.6, 3: 0.35, 4: 0.05, 5: 0.01}       # ER -> inpatient
ICU_SHARE = {1: 0.7, 2: 0.25, 3: 0.05, 4: 0.0, 5: 0.0}       # of those admitted
DIRECT_K = {ICU: 0.5, PEDS: 0.6}                             # direct admissions
GENERAL_DIRECT_K = 0.45

SURNAMES = [
    "Okafor", "Lindqvist", "Rao", "Patel", "Kim", "Alvarez", "Nguyen", "Haddad", "Moreau", "Silva",
    "Kowalski", "Mensah", "Tanaka", "O'Brien", "Fischer", "Costa", "Ibrahim", "Larsen", "Chen", "Dubois",
    "Novak", "Rossi", "Adeyemi", "Sato", "Murphy", "Schmidt", "Reyes", "Andersen", "Ahmed", "Bianchi",
    "Walsh", "Yilmaz", "Petrov", "Mwangi", "Hughes", "Santos", "Becker", "Iyer", "Kaur", "Mendes",
    "Eriksen", "Duarte", "Osei", "Varga", "Lopez", "Brennan", "Nakamura", "Popescu", "Ferreira", "Quinn",
    "Abara", "Holm", "Castillo", "Dimitrov", "Gallo", "Jensen", "Kariuki", "Lund", "Marsh", "Oduya",
]
FIRST_NAMES = ["Sam", "Ana", "Joe", "Mei", "Raj", "Lea", "Tom", "Ife", "Kai", "Eva", "Ben", "Noor", "Luis", "Ada"]


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------
def parse_counts(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for part in filter(None, (p.strip() for p in text.split(","))):
        name, _, n = part.partition(":")
        if not name.strip() or not n.strip().isdigit():
            raise ValueError(f"expected Unit:count, got {part!r}")
        out[name.strip()] = int(n)
    return out


@dataclass
class Config:
    dsn: str = DEFAULT_DSN
    units: dict[str, int] = field(default_factory=lambda: parse_counts(DEFAULT_UNITS))
    nurses: dict[str, int] = field(default_factory=lambda: parse_counts(DEFAULT_NURSES))
    doctors: dict[str, int] = field(default_factory=lambda: parse_counts(DEFAULT_DOCTORS))
    cleaners: int = 3
    ambulances: int = 3
    pace: float = 1.0
    seed: int | None = None
    shift_minutes: int = 720
    retention_minutes: int = 30
    surge_every: int = 240
    arrival_scale: float = 1.0
    publication: str = "liveops"
    reader_role: str = "liveops_reader"
    verbose: bool = True

    def __post_init__(self):
        if ER not in self.units or self.units[ER] < 1:
            raise ValueError("units must include ER with at least one bed")
        self.retention_minutes = max(10, self.retention_minutes)  # views look back 10 minutes
        self.shift_minutes = max(60, self.shift_minutes)


def config_from_args(argv=None) -> tuple[Config, argparse.Namespace]:
    env = os.environ.get
    p = argparse.ArgumentParser(description="Live Ops hospital simulator (test tool)")
    p.add_argument("--dsn", default=env("SOURCES_DSN", DEFAULT_DSN))
    p.add_argument("--pace", type=float, default=float(env("SIM_PACE", "1")),
                   help="simulated minutes per real second (default 1)")
    p.add_argument("--seed", type=int, default=int(env("SIM_SEED")) if env("SIM_SEED") else None)
    p.add_argument("--units", default=env("SIM_UNITS", DEFAULT_UNITS), help="beds per unit, e.g. ER:8,ICU:6")
    p.add_argument("--nurses", default=env("SIM_NURSES", DEFAULT_NURSES), help="nurses per unit per crew")
    p.add_argument("--doctors", default=env("SIM_DOCTORS", DEFAULT_DOCTORS), help="doctors per unit per crew")
    p.add_argument("--cleaners", type=int, default=int(env("SIM_CLEANERS", "3")), help="EVS cleaners per crew")
    p.add_argument("--ambulances", type=int, default=int(env("SIM_AMBULANCES", "3")))
    p.add_argument("--shift-minutes", type=int, default=int(env("SIM_SHIFT_MINUTES", "720")))
    p.add_argument("--retention-minutes", type=int, default=int(env("SIM_RETENTION_MINUTES", "30")),
                   help="closed rows older than this (real minutes) are deleted; minimum 10")
    p.add_argument("--surge-every", type=int, default=int(env("SIM_SURGE_EVERY", "240")),
                   help="mean simulated minutes between ER rushes (0 = never)")
    p.add_argument("--arrival-scale", type=float, default=float(env("SIM_ARRIVAL_SCALE", "1")))
    p.add_argument("--publication", default=env("SIM_PUBLICATION", "liveops"))
    p.add_argument("--reader-role", default=env("SIM_READER_ROLE", "liveops_reader"))
    p.add_argument("--ticks", type=int, default=0, help="stop after N simulated minutes (0 = run forever)")
    p.add_argument("--fast", action="store_true", help="do not sleep between ticks (tests, warm-up)")
    p.add_argument("--setup-only", action="store_true", help="apply schema additions and grants, then exit")
    p.add_argument("--check", action="store_true", help="check invariants on the database and exit")
    p.add_argument("--quiet", action="store_true")
    a = p.parse_args(argv)
    cfg = Config(
        dsn=a.dsn, units=parse_counts(a.units), nurses=parse_counts(a.nurses), doctors=parse_counts(a.doctors),
        cleaners=a.cleaners, ambulances=a.ambulances, pace=a.pace, seed=a.seed, shift_minutes=a.shift_minutes,
        retention_minutes=a.retention_minutes, surge_every=a.surge_every, arrival_scale=a.arrival_scale,
        publication=a.publication, reader_role=a.reader_role, verbose=not a.quiet,
    )
    return cfg, a


# ---------------------------------------------------------------------------
# schema additions (idempotent)
# ---------------------------------------------------------------------------
NEW_COLUMNS = {
    ("epic", "adt_beds"): [("room", "text"), ("in_service", "boolean NOT NULL DEFAULT true")],
    ("epic", "encounters"): [("current_unit", "text"), ("status", "text"), ("arrival_mode", "text"),
                             ("acuity", "smallint"), ("updated_at", "timestamptz NOT NULL DEFAULT now()")],
    ("epic", "triage_queue"): [("patient_ref", "text"), ("arrival_mode", "text"), ("acuity", "smallint"),
                               ("updated_at", "timestamptz NOT NULL DEFAULT now()")],
    ("kronos", "roster"): [("crew", "text"), ("updated_at", "timestamptz NOT NULL DEFAULT now()")],
    ("kronos", "rounds"): [("staff_id", "text"), ("role", "text"), ("unit", "text"), ("ended_at", "timestamptz")],
    ("evs", "tasks"): [("unit", "text"), ("phase", "text"), ("assigned_to", "text"), ("cleaner_name", "text"),
                       ("started_at", "timestamptz")],
    ("gps", "ambulances"): [("patient_ref", "text"), ("priority", "smallint")],
}

RTLS_DDL = [
    "CREATE SCHEMA IF NOT EXISTS rtls",
    """CREATE TABLE IF NOT EXISTS rtls.locations (
         tag_id      text PRIMARY KEY,
         person_id   text NOT NULL,
         person_type text NOT NULL CHECK (person_type IN ('patient', 'staff')),
         role        text,
         name        text,
         unit        text,
         room        text,
         bed_id      text,
         status      text,
         updated_at  timestamptz NOT NULL DEFAULT now()
       )""",
]
PEOPLE_VIEW = """CREATE OR REPLACE VIEW zetaris.people_live AS
SELECT tag_id, person_id, person_type, role, name, unit, room, bed_id, status, updated_at FROM rtls.locations"""

NEW_TABLES = ["rtls.locations"]


def migrate(conn, cfg: Config, log=print) -> list[str]:
    """Add missing columns/tables. Returns the DDL it ran (empty on a rerun)."""
    ran: list[str] = []
    with conn.cursor() as cur:
        cur.execute("SELECT table_schema, table_name, column_name FROM information_schema.columns "
                    "WHERE table_schema IN ('epic','kronos','evs','gps','rtls')")
        have = {(s, t, c) for s, t, c in cur.fetchall()}
        cur.execute("SELECT 1 FROM information_schema.tables WHERE table_schema='rtls' AND table_name='locations'")
        rtls_exists = cur.fetchone() is not None
        cur.execute("SELECT 1 FROM information_schema.views WHERE table_schema='zetaris' AND table_name='people_live'")
        view_exists = cur.fetchone() is not None
        cur.execute("SELECT 1 FROM information_schema.schemata WHERE schema_name='zetaris'")
        zetaris_exists = cur.fetchone() is not None
    stmts = []
    for (schema, table), cols in NEW_COLUMNS.items():
        for col, typ in cols:
            if (schema, table, col) not in have:
                stmts.append(f"ALTER TABLE {schema}.{table} ADD COLUMN IF NOT EXISTS {col} {typ}")
    if not rtls_exists:
        stmts += RTLS_DDL
    if zetaris_exists and not view_exists:
        stmts.append(PEOPLE_VIEW)
    if stmts:
        with conn.transaction(), conn.cursor() as cur:
            for s in stmts:
                cur.execute(s)
                ran.append(s)
        log(f"simulator: schema: applied {len(stmts)} addition(s)")
    return ran


def ensure_access(conn, cfg: Config, log=print) -> list[str]:
    """Grant the reader role and add new tables to the publication. Returns lines still needed."""
    role, pub = cfg.reader_role, cfg.publication
    needed: list[tuple[str, str]] = []   # (sql, why)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,))
        role_exists = cur.fetchone() is not None
        cur.execute("SELECT 1 FROM pg_publication WHERE pubname = %s", (pub,))
        pub_exists = cur.fetchone() is not None
        if role_exists:
            cur.execute("SELECT has_schema_privilege(%s, 'rtls', 'USAGE')", (role,))
            if not cur.fetchone()[0]:
                needed.append((f'GRANT USAGE ON SCHEMA rtls TO "{role}";', "schema"))
            for t in NEW_TABLES:
                cur.execute("SELECT has_table_privilege(%s, %s, 'SELECT')", (role, t))
                if not cur.fetchone()[0]:
                    needed.append((f'GRANT SELECT ON {t} TO "{role}";', "table"))
            cur.execute("SELECT to_regclass('zetaris.people_live') IS NOT NULL")
            if cur.fetchone()[0]:
                cur.execute("SELECT has_table_privilege(%s, 'zetaris.people_live', 'SELECT')", (role,))
                if not cur.fetchone()[0]:
                    needed.append((f'GRANT SELECT ON zetaris.people_live TO "{role}";', "view"))
        if pub_exists:
            cur.execute("SELECT schemaname || '.' || tablename FROM pg_publication_tables WHERE pubname = %s", (pub,))
            published = {r[0] for r in cur.fetchall()}
            cur.execute("SELECT puballtables FROM pg_publication WHERE pubname = %s", (pub,))
            if not cur.fetchone()[0]:
                for t in NEW_TABLES:
                    if t not in published:
                        needed.append((f'ALTER PUBLICATION "{pub}" ADD TABLE {t};', "publication"))
    missing = []
    for stmt, _ in needed:
        try:
            with conn.transaction(), conn.cursor() as cur:
                cur.execute(stmt)
            log(f"simulator: access: {stmt}")
        except psycopg.Error as exc:
            missing.append(stmt)
            log(f"simulator: access: could not run ({exc.__class__.__name__}): {stmt}")
    if not role_exists:
        log(f"simulator: access: role {role!r} not found; skipped grants")
    if not pub_exists:
        log(f"simulator: access: publication {pub!r} not found; to stream rtls.locations too, run as an admin:\n"
            f"  ALTER PUBLICATION {pub} ADD TABLE rtls.locations;   (or CREATE PUBLICATION ... FOR TABLE ...)")
    if missing:
        log("simulator: access: run these as the database owner / a superuser:\n  " + "\n  ".join(missing))
    return missing


# ---------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------
@dataclass
class Bed:
    bed_id: str
    unit: str
    room: str
    status: str
    in_service: bool = True
    patient: str | None = None


@dataclass
class Patient:
    ref: str
    acuity: int
    mode: str                  # walk-in | ambulance | direct
    peds: bool
    stage: str                 # arriving | waiting | transit | in_bed | boarding | leaving
    unit: str
    arrived: int = 0
    bed_id: str | None = None
    due: int = 0
    target: str | None = None  # unit a boarding patient waits for
    since: int = 0             # start of the current stage
    patience: int = 10 ** 9
    triage_id: int | None = None
    encounter_id: int | None = None


@dataclass
class Staff:
    staff_id: str
    name: str
    role: str                  # nurse | doctor | cleaner
    home: str
    crew: str
    present: bool = False
    unit: str | None = None
    room: str | None = None
    bed_id: str | None = None
    status: str = "off"
    due: int = 0
    leaving: bool = False
    task: int | None = None
    round_id: int | None = None
    idle_since: int = 0


@dataclass
class Task:
    task_id: int
    bed_id: str
    unit: str
    phase: str = "queued"
    cleaner: str | None = None


@dataclass
class Ambulance:
    unit_id: str
    status: str = "idle"
    eta: float | None = None
    patient: Patient | None = None
    due: int = 0


def room_name(unit: str, n: int) -> str:
    if unit == ER:
        return f"ER Bay {n}"
    if unit == ICU:
        return f"ICU {n}"
    if unit == PEDS:
        return f"Peds {300 + n}"
    if unit == "General":
        return f"Room {200 + (n + 1) // 2}"
    return f"{unit} {n}"


def station(unit: str) -> str:
    return EVS + " Hub" if unit == EVS else f"{unit} Station"


class Hospital:
    def __init__(self, conn, cfg: Config, log=None, t0: int = 0):
        self.c = conn
        self.cfg = cfg
        self.rng = random.Random(cfg.seed)
        self.log = log or ((lambda m: print(m, flush=True)) if cfg.verbose else (lambda m: None))
        self.t = t0
        self.writes: Counter = Counter()
        self.events: list[str] = []
        self.beds: dict[str, Bed] = {}
        self.patients: dict[str, Patient] = {}
        self.staff: dict[str, Staff] = {}
        self.tasks: dict[int, Task] = {}
        self.ambulances: dict[str, Ambulance] = {}
        self.rtls_written: dict[str, tuple] = {}
        self.last_round: dict[str, int] = {}
        self.surge_until = -1
        self.next_surge = 10 ** 9
        self.next_pid = 1040
        self.next_census = 5
        self.cur = None
        self.load()

    # --- db helpers ----------------------------------------------------------
    def x(self, table: str, q: str, *args):
        self.cur.execute(q, args)
        self.writes[table] += max(self.cur.rowcount, 0)
        return self.cur

    def q(self, q: str, *args) -> list[tuple]:
        with self.c.cursor() as cur:
            cur.execute(q, args)
            return cur.fetchall()

    def note(self, msg: str):
        self.events.append(f"{self.t}:{msg}")
        self.log(f"[{self.clock()}] {msg}")

    def clock(self) -> str:
        m = (START_CLOCK + self.t) % 1440
        return f"{m // 60:02d}:{m % 60:02d}"

    # --- random helpers ------------------------------------------------------
    def lognorm(self, median: float, sigma: float = 0.5) -> int:
        return max(1, int(round(self.rng.lognormvariate(math.log(median), sigma))))

    def poisson(self, lam: float) -> int:
        if lam <= 0:
            return 0
        limit, k, prod = math.exp(-lam), 0, self.rng.random()
        while prod > limit:
            k += 1
            prod *= self.rng.random()
        return k

    def new_ref(self) -> str:
        ref = f"P-{self.next_pid}"
        self.next_pid += 1
        return ref

    def draw_acuity(self, mode: str) -> int:
        weights = [0.08, 0.35, 0.45, 0.1, 0.02] if mode == "ambulance" else [0.02, 0.15, 0.45, 0.3, 0.08]
        return self.rng.choices([1, 2, 3, 4, 5], weights)[0]

    # --- topology --------------------------------------------------------------
    def wards(self) -> list[str]:
        return [u for u in self.cfg.units if u not in (ER, ICU, PEDS)]

    def los(self, unit: str, p: Patient) -> int:
        if unit == ER:
            return self.lognorm(ER_LOS[p.acuity])
        return self.lognorm(WARD_LOS.get(unit, GENERAL_LOS))

    def pick_ward(self) -> str | None:
        ws = self.wards()
        if not ws:
            return None
        return self.rng.choices(ws, [self.cfg.units[w] for w in ws])[0]

    def free_beds(self, unit: str) -> list[Bed]:
        return [b for b in self.beds.values() if b.unit == unit and b.in_service and b.status == "free"]

    # =========================================================================
    # startup: bring the database in line with the config, then load the model
    # =========================================================================
    def load(self):
        migrate(self.c, self.cfg, self.log)
        ensure_access(self.c, self.cfg, self.log)
        with self.c.transaction(), self.c.cursor() as self.cur:
            self.sync_beds()
            self.sync_census()
            self.sync_roster()
            self.sync_ambulances()
            self.load_patients()
            self.load_tasks()
            self.x("kronos.rounds", "UPDATE kronos.rounds SET ended_at = now() WHERE ended_at IS NULL")
            self.place_staff()
            self.flush_rtls(initial=True)
        self.cur = None
        if self.cfg.surge_every > 0:
            self.next_surge = self.t + self.rng.randint(30, 90)
        occ = sum(b.status == "occupied" for b in self.beds.values())
        self.log(f"simulator: ready: {len(self.beds)} beds ({occ} occupied), {len(self.staff)} staff on roster, "
                 f"{len(self.ambulances)} ambulances, seed={self.cfg.seed}")

    def sync_beds(self):
        rows = self.q("SELECT bed_id, unit, status, room, in_service FROM epic.adt_beds ORDER BY bed_id")
        by_unit: dict[str, list[list]] = defaultdict(list)
        top = 0
        for bed_id, unit, status, room, ins in rows:
            by_unit[unit].append([bed_id, status, room, ins])
            m = re.fullmatch(r"B(\d+)", bed_id)
            if m:
                top = max(top, int(m.group(1)))
        for unit, want in self.cfg.units.items():
            have = by_unit[unit]
            while len(have) < want:
                top += 1
                bed_id = f"B{top:02d}"
                self.x("epic.adt_beds", "INSERT INTO epic.adt_beds (bed_id, unit, status) VALUES (%s, %s, 'free')",
                       bed_id, unit)
                have.append([bed_id, "free", None, True])
        for unit, beds in by_unit.items():
            want = self.cfg.units.get(unit, 0)
            for i, (bed_id, status, room, ins) in enumerate(sorted(beds)):
                in_service = i < want
                new_room = room_name(unit, i + 1) if in_service else (room or f"{unit} (closed)")
                if room != new_room or ins != in_service:
                    self.x("epic.adt_beds", "UPDATE epic.adt_beds SET room = %s, in_service = %s WHERE bed_id = %s",
                           new_room, in_service, bed_id)
                self.beds[bed_id] = Bed(bed_id, unit, new_room, status, in_service)

    def unit_bed_count(self, unit: str) -> int:
        return sum(b.unit == unit for b in self.beds.values())

    def sync_census(self):
        rows = {u: (cap, other) for u, cap, other in self.q("SELECT unit, capacity, occupied_other FROM epic.unit_census")}
        for unit in self.cfg.units:
            n = self.unit_bed_count(unit)
            if unit not in rows:
                self.x("epic.unit_census", "INSERT INTO epic.unit_census (unit, capacity, occupied_other) VALUES (%s, %s, 0)",
                       unit, n)
                continue
            cap, other = rows[unit]
            new_cap = max(cap, n)
            new_other = max(0, min(other, new_cap - n))
            if (new_cap, new_other) != (cap, other):
                self.x("epic.unit_census", "UPDATE epic.unit_census SET capacity = %s, occupied_other = %s WHERE unit = %s",
                       new_cap, new_other, unit)

    def sync_roster(self):
        rows = self.q("SELECT staff_id, name, role, unit, crew FROM kronos.roster ORDER BY staff_id")
        slots: list[tuple[str, str, str]] = []
        for crew in CREWS:
            for unit in self.cfg.units:
                slots += [(crew, "doctor", unit)] * self.cfg.doctors.get(unit, 0)
                slots += [(crew, "nurse", unit)] * self.cfg.nurses.get(unit, 0)
            slots += [(crew, "cleaner", EVS)] * self.cfg.cleaners
        open_slots = Counter(slots)
        assigned: dict[str, tuple[str, str, str]] = {}
        for staff_id, _, role, unit, crew in rows:                      # rows that already have a crew
            if crew in CREWS and open_slots[(crew, role, unit)] > 0:
                open_slots[(crew, role, unit)] -= 1
                assigned[staff_id] = (crew, role, unit)
        for staff_id, _, role, unit, crew in rows:                      # legacy rows (no crew yet)
            if staff_id in assigned or crew not in (None, ""):
                continue
            for c in CREWS:
                if open_slots[(c, role, unit)] > 0:
                    open_slots[(c, role, unit)] -= 1
                    assigned[staff_id] = (c, role, unit)
                    break
        names = {r[1] for r in rows}
        top = max([int(m.group(1)) for r in rows if (m := re.fullmatch(r"S(\d+)", r[0]))] or [0])
        k = 0

        def make_name(role: str) -> str:
            nonlocal k
            while True:
                last = SURNAMES[(k * 7) % len(SURNAMES)]
                first = FIRST_NAMES[k % len(FIRST_NAMES)]
                k += 1
                name = {"doctor": f"Dr. {last}", "nurse": f"Nurse {last}"}.get(role, f"{first} {last}")
                if name not in names:
                    names.add(name)
                    return name

        for slot in slots:
            if open_slots[slot] <= 0:
                continue
            open_slots[slot] -= 1
            crew, role, unit = slot
            top += 1
            staff_id = f"S{top:02d}"
            self.x("kronos.roster", "INSERT INTO kronos.roster (staff_id, name, role, unit, on_shift, crew) "
                   "VALUES (%s, %s, %s, %s, false, %s)", staff_id, make_name(role), role, unit, crew)
            assigned[staff_id] = slot
        info = {r[0]: r[1] for r in self.q("SELECT staff_id, name FROM kronos.roster")}
        for staff_id, _, role, unit, crew in rows:
            if staff_id not in assigned and crew != "inactive":
                self.x("kronos.roster", "UPDATE kronos.roster SET crew = 'inactive', on_shift = false, updated_at = now() "
                       "WHERE staff_id = %s", staff_id)
            elif staff_id in assigned and crew != assigned[staff_id][0]:
                self.x("kronos.roster", "UPDATE kronos.roster SET crew = %s, updated_at = now() WHERE staff_id = %s",
                       assigned[staff_id][0], staff_id)
        for staff_id in sorted(assigned):
            crew, role, unit = assigned[staff_id]
            self.staff[staff_id] = Staff(staff_id, info[staff_id], role, unit, crew)

    def sync_ambulances(self):
        ids = [r[0] for r in self.q("SELECT unit_id FROM gps.ambulances ORDER BY unit_id")]
        n = 1
        while len(ids) < self.cfg.ambulances:
            cand = f"A-{n}"
            n += 1
            if cand not in ids:
                self.x("gps.ambulances", "INSERT INTO gps.ambulances (unit_id, status, dest_unit) VALUES (%s, 'idle', %s)",
                       cand, ER)
                ids.append(cand)
        self.x("gps.ambulances", "UPDATE gps.ambulances SET status = 'idle', eta_min = NULL, patient_ref = NULL, "
               "priority = NULL, updated_at = now() WHERE status <> 'idle' OR patient_ref IS NOT NULL OR eta_min IS NOT NULL")
        for unit_id in sorted(ids)[: self.cfg.ambulances]:
            self.ambulances[unit_id] = Ambulance(unit_id)

    def load_patients(self):
        refs = self.q("SELECT patient_ref FROM epic.encounters UNION ALL "
                      "SELECT patient_ref FROM epic.triage_queue WHERE patient_ref IS NOT NULL")
        nums = [int(m.group(1)) for (r,) in refs if r and (m := re.fullmatch(r"P-(\d+)", r))]
        self.next_pid = max(nums + [1039]) + 1
        # patients in beds
        for enc_id, ref, bed_id, acuity, mode in self.q(
                "SELECT encounter_id, patient_ref, bed_id, acuity, arrival_mode FROM epic.encounters "
                "WHERE discharged_at IS NULL ORDER BY encounter_id"):
            bed = self.beds[bed_id]
            if ref in self.patients:   # same ref open twice: close the older stay
                self.x("epic.encounters", "UPDATE epic.encounters SET discharged_at = now(), status = 'discharged' "
                       "WHERE encounter_id = %s", enc_id)
                continue
            mode = mode or ("walk-in" if bed.unit == ER else "direct")
            acuity = acuity or self.draw_acuity(mode)
            p = Patient(ref, acuity, mode, bed.unit == PEDS, "in_bed", bed.unit, bed_id=bed_id, encounter_id=enc_id)
            p.due = self.rng.randint(1, self.los(bed.unit, p))
            self.patients[ref] = p
            bed.patient = ref
            self.x("epic.encounters", "UPDATE epic.encounters SET current_unit = %s, status = 'in_bed', acuity = %s, "
                   "arrival_mode = %s, updated_at = now() WHERE encounter_id = %s AND (current_unit IS DISTINCT FROM %s "
                   "OR status IS DISTINCT FROM 'in_bed' OR acuity IS NULL OR arrival_mode IS NULL)",
                   bed.unit, acuity, mode, enc_id, bed.unit)
            if bed.status != "occupied":
                bed.status = "occupied"
                self.x("epic.adt_beds", "UPDATE epic.adt_beds SET status = 'occupied', updated_at = now() WHERE bed_id = %s",
                       bed_id)
        # occupied beds with nobody in them get a patient (warm data from an older run)
        for bed in sorted(self.beds.values(), key=lambda b: b.bed_id):
            if bed.status == "occupied" and bed.patient is None:
                self.admit_warm(bed)
        # warm start: fill units that are mostly empty (first run with more beds)
        targets = {ER: 0.75, ICU: 0.7, PEDS: 0.5}
        for unit in self.cfg.units:
            beds = [b for b in self.beds.values() if b.unit == unit and b.in_service]
            occ = sum(b.status == "occupied" for b in beds)
            if beds and occ / len(beds) < 0.5:
                want = round(targets.get(unit, 0.75) * len(beds))
                for bed in sorted(self.free_beds(unit), key=lambda b: b.bed_id):
                    if occ >= want:
                        break
                    if self.rng.random() < 0.8:
                        self.admit_warm(bed)
                        occ += 1
        # patients waiting in triage
        for tid, ref, mode, acuity in self.q(
                "SELECT id, patient_ref, arrival_mode, acuity FROM epic.triage_queue WHERE status = 'waiting' ORDER BY id"):
            mode = mode or "walk-in"
            if ref is None or ref in self.patients:
                ref = self.new_ref()
            acuity = acuity or self.draw_acuity(mode)
            p = Patient(ref, acuity, mode, self.rng.random() < 0.15 and PEDS in self.cfg.units, "waiting",
                        AMB_BAY if mode == "ambulance" else WAITING, triage_id=tid)
            p.patience = self.patience(acuity)
            self.patients[ref] = p
            self.x("epic.triage_queue", "UPDATE epic.triage_queue SET patient_ref = %s, arrival_mode = %s, acuity = %s, "
                   "updated_at = now() WHERE id = %s AND (patient_ref IS DISTINCT FROM %s OR arrival_mode IS NULL "
                   "OR acuity IS NULL)", ref, mode, acuity, tid, ref)

    def admit_warm(self, bed: Bed):
        mode = "walk-in" if bed.unit == ER else "direct"
        p = Patient(self.new_ref(), 0, mode, bed.unit == PEDS, "in_bed", bed.unit, bed_id=bed.bed_id)
        p.acuity = self.draw_acuity(mode)
        los = self.los(bed.unit, p)
        stay = self.rng.randint(0, los)
        p.due = max(1, los - stay)
        p.encounter_id = self.x(
            "epic.encounters", "INSERT INTO epic.encounters (patient_ref, bed_id, admitted_at, current_unit, status, "
            "arrival_mode, acuity) VALUES (%s, %s, now() - make_interval(mins => %s), %s, 'in_bed', %s, %s) "
            "RETURNING encounter_id", p.ref, bed.bed_id, stay, bed.unit, mode, p.acuity).fetchone()[0]
        if bed.status != "occupied":
            self.x("epic.adt_beds", "UPDATE epic.adt_beds SET status = 'occupied', updated_at = now() WHERE bed_id = %s",
                   bed.bed_id)
        bed.status, bed.patient = "occupied", p.ref
        self.patients[p.ref] = p

    def load_tasks(self):
        open_tasks = self.q("SELECT task_id, bed_id FROM evs.tasks WHERE status = 'open' ORDER BY task_id")
        seen = set()
        for task_id, bed_id in open_tasks:
            bed = self.beds.get(bed_id)
            if bed is None or bed.status != "cleaning" or bed_id in seen:
                self.x("evs.tasks", "UPDATE evs.tasks SET status = 'done', phase = 'done', done_at = now() WHERE task_id = %s",
                       task_id)
                continue
            seen.add(bed_id)
            self.tasks[task_id] = Task(task_id, bed_id, bed.unit)
            self.x("evs.tasks", "UPDATE evs.tasks SET unit = %s, phase = 'queued', assigned_to = NULL, cleaner_name = NULL, "
                   "started_at = NULL WHERE task_id = %s AND (phase IS DISTINCT FROM 'queued' OR unit IS NULL "
                   "OR assigned_to IS NOT NULL)", bed.unit, task_id)
        for bed in sorted(self.beds.values(), key=lambda b: b.bed_id):
            if bed.status == "cleaning" and bed.bed_id not in seen:
                self.open_task(bed)

    def place_staff(self):
        crew = self.crew_on_duty(self.t)
        for s in self.staff.values():
            on = s.crew == crew
            if on:
                s.present, s.unit, s.room = True, s.home, station(s.home)
                s.status = "available" if s.role == "cleaner" else "station"
                s.due = self.rng.randint(0, 5)
        on_ids = [s.staff_id for s in self.staff.values() if s.present]
        self.x("kronos.roster", "UPDATE kronos.roster SET on_shift = (staff_id = ANY(%s)), updated_at = now() "
               "WHERE crew IN ('A', 'B') AND on_shift IS DISTINCT FROM (staff_id = ANY(%s))", on_ids, on_ids)

    # =========================================================================
    # one simulated minute
    # =========================================================================
    def tick(self):
        self.t += 1
        with self.c.transaction(), self.c.cursor() as self.cur:
            self.surges()
            self.shifts()
            self.ambulance_step()
            self.arrivals()
            self.patient_step()
            self.room_waiting()
            self.resolve_boarding()
            self.direct_admissions()
            self.evs_step()
            self.staff_step()
            self.census_step()
            self.flush_rtls()
            if self.t % 30 == 0:
                self.prune()
        self.cur = None
        if self.t % 60 == 0:
            self.log(self.summary())

    def summary(self) -> str:
        parts = []
        for u in self.cfg.units:
            beds = [b for b in self.beds.values() if b.unit == u and b.in_service]
            parts.append(f"{u} {sum(b.status == 'occupied' for b in beds)}/{len(beds)}")
        waiting = sum(p.stage == "waiting" for p in self.patients.values())
        boarding = sum(p.stage == "boarding" for p in self.patients.values())
        cleaning = sum(b.status == "cleaning" for b in self.beds.values())
        inbound = sum(a.status == "inbound" for a in self.ambulances.values())
        surge = " SURGE" if self.t < self.surge_until else ""
        return (f"[{self.clock()}] " + " ".join(parts) + f" | waiting {waiting} boarding {boarding} "
                f"cleaning {cleaning} ambulances inbound {inbound}{surge}")

    # --- surges ----------------------------------------------------------------
    def surges(self):
        if self.t == self.next_surge:
            self.surge_until = self.t + self.rng.randint(40, 90)
            self.next_surge = self.surge_until + 60 + int(self.rng.expovariate(1 / max(1, self.cfg.surge_every)))
            self.note(f"ER rush begins (until +{self.surge_until - self.t} min)")
        elif self.t == self.surge_until:
            self.note("ER rush ends")

    def arrival_rate(self) -> float:
        mean_los = sum(ER_LOS[a] * w for a, w in zip(range(1, 6), [0.02, 0.15, 0.45, 0.3, 0.08])) * 1.13
        base = 0.7 * self.cfg.units[ER] / mean_los * self.cfg.arrival_scale
        hour = ((START_CLOCK + self.t) % 1440) / 60
        diurnal = 1 + 0.3 * math.sin(2 * math.pi * (hour - 10) / 24)
        return base * diurnal * (2.5 if self.t < self.surge_until else 1.0)

    # --- shifts ----------------------------------------------------------------
    def crew_on_duty(self, t: int) -> str:
        return CREWS[((START_CLOCK + t - SHIFT_ANCHOR) // self.cfg.shift_minutes) % len(CREWS)]

    def shifts(self):
        L = self.cfg.shift_minutes
        if (START_CLOCK + self.t + HANDOVER - SHIFT_ANCHOR) % L == 0:
            incoming = self.crew_on_duty(self.t + HANDOVER)
            self.note(f"crew {incoming} arrives for handover")
            for s in self.staff.values():
                if s.crew == incoming and not s.present:
                    s.present, s.leaving, s.unit, s.room, s.bed_id = True, False, ENTRANCE, None, None
                    s.status, s.due = "arriving", self.t + self.rng.randint(2, 5)
                    self.set_on_shift(s, True)
        if (START_CLOCK + self.t - SHIFT_ANCHOR) % L == 0:
            outgoing = self.crew_on_duty(self.t - 1)
            self.note(f"shift change: crew {self.crew_on_duty(self.t)} takes over, crew {outgoing} leaves")
            for s in self.staff.values():
                if s.crew == outgoing and s.present:
                    s.leaving = True

    def set_on_shift(self, s: Staff, on: bool):
        self.x("kronos.roster", "UPDATE kronos.roster SET on_shift = %s, updated_at = now() WHERE staff_id = %s",
               on, s.staff_id)

    # --- ambulances --------------------------------------------------------------
    def ambulance_step(self):
        for a in self.ambulances.values():
            if a.status == "inbound":
                a.eta -= 1
                if a.eta > 0:
                    self.x("gps.ambulances", "UPDATE gps.ambulances SET eta_min = %s, updated_at = now() WHERE unit_id = %s",
                           a.eta, a.unit_id)
                else:
                    p, a.patient = a.patient, None
                    a.status, a.eta, a.due = "arrived", 0, self.t + self.rng.randint(6, 12)
                    self.x("gps.ambulances", "UPDATE gps.ambulances SET status = 'arrived', eta_min = 0, updated_at = now() "
                           "WHERE unit_id = %s", a.unit_id)
                    self.arrive(p, AMB_BAY, "waiting")
                    self.note(f"ambulance {a.unit_id} arrived with {p.ref} (ESI {p.acuity})")
            elif a.status == "arrived" and self.t >= a.due:
                a.status, a.eta = "idle", None
                self.x("gps.ambulances", "UPDATE gps.ambulances SET status = 'idle', eta_min = NULL, patient_ref = NULL, "
                       "priority = NULL, updated_at = now() WHERE unit_id = %s", a.unit_id)

    # --- arrivals ------------------------------------------------------------------
    def patience(self, acuity: int) -> int:
        if acuity <= 2:
            return 10 ** 9
        return self.lognorm(300 if acuity == 3 else 150, 0.4)

    def arrivals(self):
        rate = self.arrival_rate()
        peds_ok = PEDS in self.cfg.units
        for _ in range(self.poisson(rate * 0.78)):
            p = Patient(self.new_ref(), self.draw_acuity("walk-in"), "walk-in",
                        peds_ok and self.rng.random() < 0.15, "arriving", ENTRANCE)
            self.arrive(p, ENTRANCE, "arriving")
        amb_rate = rate * 0.22 * (0.7 if self.t < self.surge_until else 1.0)
        if self.rng.random() < amb_rate:
            idle = [a for a in self.ambulances.values() if a.status == "idle"]
            if idle:
                a = self.rng.choice(idle)
                p = Patient(self.new_ref(), self.draw_acuity("ambulance"), "ambulance",
                            peds_ok and self.rng.random() < 0.1, "waiting", AMB_BAY)
                a.status, a.eta, a.patient = "inbound", float(self.rng.randint(6, 18)), p
                self.x("gps.ambulances", "UPDATE gps.ambulances SET status = 'inbound', eta_min = %s, dest_unit = %s, "
                       "patient_ref = %s, priority = %s, updated_at = now() WHERE unit_id = %s",
                       a.eta, ER, p.ref, p.acuity, a.unit_id)
                self.note(f"ambulance {a.unit_id} inbound, ETA {a.eta:.0f} min")

    def arrive(self, p: Patient, unit: str, stage: str):
        p.unit, p.stage, p.arrived, p.since = unit, stage, self.t, self.t
        p.due = self.t + self.rng.randint(1, 3)
        p.patience = self.patience(p.acuity)
        p.triage_id = self.x("epic.triage_queue", "INSERT INTO epic.triage_queue (patient_ref, arrival_mode, acuity) "
                             "VALUES (%s, %s, %s) RETURNING id", p.ref, p.mode, p.acuity).fetchone()[0]
        self.patients[p.ref] = p

    # --- per-patient timers -------------------------------------------------------
    def patient_step(self):
        for p in list(self.patients.values()):
            if p.stage == "arriving" and self.t >= p.due:
                p.stage, p.unit, p.since = "waiting", WAITING, self.t
            elif p.stage == "waiting" and self.t - p.arrived >= p.patience:
                self.x("epic.triage_queue", "UPDATE epic.triage_queue SET status = 'left', updated_at = now() WHERE id = %s",
                       p.triage_id)
                self.leave(p)
                self.note(f"{p.ref} left without being seen after {self.t - p.arrived} min")
            elif p.stage == "transit" and self.t >= p.due:
                p.stage, p.since = "in_bed", self.t
                p.due = self.t + self.los(p.unit, p)
                self.enc_status(p, "in_bed")
            elif p.stage == "in_bed" and self.t >= p.due:
                self.disposition(p)
            elif p.stage == "boarding" and self.t - p.since > 600:
                self.discharge(p)       # transferred out to another facility
            elif p.stage == "leaving" and self.t >= p.due:
                del self.patients[p.ref]

    def enc_status(self, p: Patient, status: str):
        self.x("epic.encounters", "UPDATE epic.encounters SET status = %s, current_unit = %s, updated_at = now() "
               "WHERE encounter_id = %s", status, p.unit, p.encounter_id)

    def disposition(self, p: Patient):
        u = p.unit
        target = None
        if u == ER:
            if self.rng.random() < ADMIT_P[p.acuity]:
                if p.peds and PEDS in self.cfg.units and p.acuity > 1:
                    target = PEDS
                elif ICU in self.cfg.units and self.rng.random() < ICU_SHARE[p.acuity]:
                    target = ICU
                else:
                    target = self.pick_ward() or (PEDS if p.peds and PEDS in self.cfg.units else None)
        elif u == ICU:
            if self.rng.random() < 0.75:
                target = PEDS if p.peds and PEDS in self.cfg.units else self.pick_ward()
        elif u != PEDS and ICU in self.cfg.units and self.rng.random() < 0.04:
            target = ICU
        if target is None or target == u:
            self.discharge(p)
            return
        p.stage, p.target, p.since = "boarding", target, self.t
        self.enc_status(p, "boarding")

    def leave(self, p: Patient):
        p.stage, p.unit, p.bed_id, p.since = "leaving", LOBBY, None, self.t
        p.due = self.t + self.rng.randint(2, 4)

    def discharge(self, p: Patient):
        self.vacate(self.beds[p.bed_id])
        self.x("epic.encounters", "UPDATE epic.encounters SET discharged_at = now(), status = 'discharged', "
               "updated_at = now() WHERE encounter_id = %s", p.encounter_id)
        self.leave(p)

    def vacate(self, bed: Bed):
        bed.status, bed.patient = "cleaning", None
        self.x("epic.adt_beds", "UPDATE epic.adt_beds SET status = 'cleaning', updated_at = now() WHERE bed_id = %s",
               bed.bed_id)
        self.open_task(bed)

    def open_task(self, bed: Bed):
        task_id = self.x("evs.tasks", "INSERT INTO evs.tasks (bed_id, unit, phase) VALUES (%s, %s, 'queued') "
                         "RETURNING task_id", bed.bed_id, bed.unit).fetchone()[0]
        self.tasks[task_id] = Task(task_id, bed.bed_id, bed.unit)

    def occupy(self, bed: Bed, p: Patient):
        bed.status, bed.patient = "occupied", p.ref
        self.x("epic.adt_beds", "UPDATE epic.adt_beds SET status = 'occupied', updated_at = now() WHERE bed_id = %s",
               bed.bed_id)
        p.stage, p.unit, p.bed_id, p.target, p.since = "transit", bed.unit, bed.bed_id, None, self.t
        p.due = self.t + self.rng.randint(1, 3 if bed.unit == ER else 6)

    def transfer(self, p: Patient, bed: Bed):
        self.vacate(self.beds[p.bed_id])
        self.occupy(bed, p)
        self.x("epic.encounters", "UPDATE epic.encounters SET bed_id = %s, current_unit = %s, status = 'in_transit', "
               "updated_at = now() WHERE encounter_id = %s", bed.bed_id, bed.unit, p.encounter_id)

    def new_encounter(self, p: Patient, bed: Bed):
        self.occupy(bed, p)
        p.encounter_id = self.x(
            "epic.encounters", "INSERT INTO epic.encounters (patient_ref, bed_id, current_unit, status, arrival_mode, "
            "acuity) VALUES (%s, %s, %s, 'in_transit', %s, %s) RETURNING encounter_id",
            p.ref, bed.bed_id, bed.unit, p.mode, p.acuity).fetchone()[0]

    # --- bed assignment --------------------------------------------------------------
    def room_waiting(self):
        free = sorted(self.free_beds(ER), key=lambda b: b.bed_id)
        if not free:
            return
        queue = sorted((p for p in self.patients.values() if p.stage == "waiting"),
                       key=lambda p: (p.acuity, p.arrived, p.ref))
        for p, bed in zip(queue, self.rng.sample(free, len(free))):
            self.x("epic.triage_queue", "UPDATE epic.triage_queue SET status = 'admitted', updated_at = now() WHERE id = %s",
                   p.triage_id)
            self.new_encounter(p, bed)

    def resolve_boarding(self):
        boarders = sorted((p for p in self.patients.values() if p.stage == "boarding"), key=lambda p: (p.since, p.ref))
        for p in boarders:
            free = self.free_beds(p.target)
            if free:
                bed = self.rng.choice(sorted(free, key=lambda b: b.bed_id))
                old = p.unit
                self.transfer(p, bed)
                self.note(f"{p.ref} transferred {old} -> {bed.unit} ({bed.room})")

    def direct_admissions(self):
        waiting_for = {p.target for p in self.patients.values() if p.stage == "boarding"}
        for unit, beds in self.cfg.units.items():
            if unit == ER or unit in waiting_for or beds == 0:
                continue
            k = DIRECT_K.get(unit, GENERAL_DIRECT_K)
            rate = k * beds / (WARD_LOS.get(unit, GENERAL_LOS) * 1.13)
            if self.rng.random() < rate:
                free = sorted(self.free_beds(unit), key=lambda b: b.bed_id)
                if free:
                    p = Patient(self.new_ref(), self.rng.choice([2, 3, 3, 4]), "direct", unit == PEDS, "transit", ENTRANCE,
                                arrived=self.t)
                    self.patients[p.ref] = p
                    self.new_encounter(p, self.rng.choice(free))

    # --- EVS -----------------------------------------------------------------------
    def evs_step(self):
        for task in sorted(self.tasks.values(), key=lambda t: t.task_id):
            if task.phase != "queued":
                continue
            idle = [s for s in self.staff.values() if s.role == "cleaner" and s.present and not s.leaving
                    and s.status == "available" and s.task is None]
            if not idle:
                break
            near = [s for s in idle if s.unit == task.unit]
            s = (near or idle)[0]
            travel = 1 if s.unit == task.unit else self.rng.randint(2, 6)
            task.phase, task.cleaner = "travelling", s.staff_id
            s.task, s.status, s.unit, s.room, s.bed_id, s.due = task.task_id, "travelling", task.unit, None, None, self.t + travel
            self.x("evs.tasks", "UPDATE evs.tasks SET phase = 'travelling', assigned_to = %s, cleaner_name = %s "
                   "WHERE task_id = %s", s.staff_id, s.name, task.task_id)

    # --- staff ----------------------------------------------------------------------
    def staff_step(self):
        crew = self.crew_on_duty(self.t)
        for s in self.staff.values():
            if not s.present or self.t < s.due:
                continue
            if s.status == "leaving":
                s.present, s.status, s.unit, s.room, s.bed_id, s.leaving = False, "off", None, None, None, False
                self.set_on_shift(s, False)
                continue
            if s.status == "arriving":
                s.unit, s.room = s.home, station(s.home)
                s.status = "handover" if s.crew != crew else ("available" if s.role == "cleaner" else "station")
                s.due = self.t + 1
                continue
            if s.status == "handover":
                if s.crew == crew:
                    s.status = "available" if s.role == "cleaner" else "station"
                s.due = self.t + 1
                continue
            if s.role == "cleaner":
                self.cleaner_step(s)
            elif s.role == "nurse":
                self.nurse_step(s)
            else:
                self.doctor_step(s)

    def go_home(self, s: Staff):
        s.status, s.unit, s.room, s.bed_id = "leaving", LOBBY, None, None
        s.due = self.t + self.rng.randint(2, 3)

    def start_round(self, s: Staff, p: Patient, status: str, minutes: int):
        bed = self.beds[p.bed_id]
        s.status, s.unit, s.room, s.bed_id, s.due = status, bed.unit, bed.room, bed.bed_id, self.t + minutes
        self.last_round[bed.bed_id] = self.t
        s.round_id = self.x("kronos.rounds", "INSERT INTO kronos.rounds (staff_name, bed_id, staff_id, role, unit) "
                            "VALUES (%s, %s, %s, %s, %s) RETURNING id", s.name, bed.bed_id, s.staff_id, s.role,
                            bed.unit).fetchone()[0]

    def end_round(self, s: Staff):
        if s.round_id is not None:
            self.x("kronos.rounds", "UPDATE kronos.rounds SET ended_at = now() WHERE id = %s", s.round_id)
            s.round_id = None

    def bedded(self, unit: str) -> list[Patient]:
        return [p for p in self.patients.values() if p.unit == unit and p.stage in ("in_bed", "boarding")]

    def nurse_step(self, s: Staff):
        if s.status == "rounds":
            self.end_round(s)
            s.status, s.room, s.bed_id = "station", station(s.unit), None
            s.due = self.t + self.rng.randint(5, 20)
            return
        if s.leaving:
            self.go_home(s)
            return
        patients = self.bedded(s.home)
        if not patients:
            s.unit, s.room, s.bed_id, s.due = s.home, station(s.home), None, self.t + 5
            return
        p = min(patients, key=lambda p: (self.last_round.get(p.bed_id, -1), p.bed_id))
        self.start_round(s, p, "rounds", self.rng.randint(4, 12))

    def doctor_step(self, s: Staff):
        if s.status == "seeing_patient":
            self.end_round(s)
            s.status, s.room, s.bed_id = "charting", station(s.unit), None
            s.due = self.t + self.rng.randint(5, 15)
            return
        if s.leaving:
            self.go_home(s)
            return
        if s.status == "walking":
            patients = self.bedded(s.unit)
            if patients:
                self.start_round(s, self.rng.choice(patients), "seeing_patient", self.rng.randint(6, 15))
            else:
                s.status, s.room, s.due = "charting", station(s.unit), self.t + 5
            return
        units = [u for u in self.cfg.units]
        weights = [len(self.bedded(u)) + (6 if u == s.home else 0) for u in units]
        dest = self.rng.choices(units, weights)[0] if sum(weights) else s.home
        if dest != s.unit:
            s.status, s.unit, s.room, s.bed_id, s.due = "walking", dest, None, None, self.t + self.rng.randint(2, 5)
            return
        patients = self.bedded(dest)
        if patients:
            self.start_round(s, self.rng.choice(patients), "seeing_patient", self.rng.randint(6, 15))
        else:
            s.status, s.room, s.due = "charting", station(s.unit), self.t + 5

    def cleaner_step(self, s: Staff):
        task = self.tasks.get(s.task) if s.task is not None else None
        if s.status == "travelling" and task:
            bed = self.beds[task.bed_id]
            s.status, s.room, s.bed_id = "cleaning", bed.room, bed.bed_id
            s.due = self.t + self.lognorm(35 if bed.unit == ICU else 25, 0.3)
            task.phase = "cleaning"
            self.x("evs.tasks", "UPDATE evs.tasks SET phase = 'cleaning', started_at = now() WHERE task_id = %s", task.task_id)
            return
        if s.status == "cleaning" and task:
            bed = self.beds[task.bed_id]
            self.x("evs.tasks", "UPDATE evs.tasks SET status = 'done', phase = 'done', done_at = now() WHERE task_id = %s",
                   task.task_id)
            del self.tasks[task.task_id]
            bed.status = "free"
            self.x("epic.adt_beds", "UPDATE epic.adt_beds SET status = 'free', updated_at = now() WHERE bed_id = %s",
                   bed.bed_id)
            s.task, s.status, s.room, s.bed_id, s.idle_since, s.due = None, "available", station(s.unit), None, self.t, self.t + 1
            return
        if s.leaving:
            self.go_home(s)
            return
        if s.status == "available" and s.unit != EVS and self.t - s.idle_since >= 10:
            s.status, s.unit, s.room, s.due = "walking", EVS, None, self.t + self.rng.randint(2, 4)
            return
        if s.status == "walking":
            s.status, s.room = "available", station(EVS)
        s.due = self.t + 1

    # --- census of beds not on the map --------------------------------------------
    def census_step(self):
        if self.t < self.next_census:
            return
        self.next_census = self.t + self.rng.randint(5, 15)
        unit = self.rng.choice(list(self.cfg.units))
        row = self.q("SELECT capacity, occupied_other FROM epic.unit_census WHERE unit = %s", unit)
        if not row:
            return
        cap, other = row[0]
        room = cap - self.unit_bed_count(unit)
        up = 0.65 if (unit == ER and self.t < self.surge_until) else 0.5
        delta = 1 if self.rng.random() < up else -1
        if 0 <= other + delta <= room:
            self.x("epic.unit_census", "UPDATE epic.unit_census SET occupied_other = occupied_other + %s WHERE unit = %s",
                   delta, unit)

    # --- rtls: one row per person in the building ---------------------------------
    def rtls_rows(self) -> dict[str, tuple]:
        rows = {}
        for p in self.patients.values():
            bed = self.beds.get(p.bed_id) if p.bed_id else None
            room = bed.room if bed and p.stage in ("in_bed", "boarding") else None
            status = {"boarding": "boarding" if p.unit == ER else "awaiting_transfer"}.get(p.stage, p.stage)
            rows["TAG-" + p.ref] = (p.ref, "patient", "patient", p.ref, p.unit, room, p.bed_id, status)
        for s in self.staff.values():
            if s.present:
                rows["TAG-" + s.staff_id] = (s.staff_id, "staff", s.role, s.name, s.unit, s.room, s.bed_id, s.status)
        return rows

    def flush_rtls(self, initial: bool = False):
        want = self.rtls_rows()
        if initial:
            self.rtls_written = {r[0]: tuple(r[1:]) for r in self.q(
                "SELECT tag_id, person_id, person_type, role, name, unit, room, bed_id, status FROM rtls.locations")}
        gone = [tag for tag in self.rtls_written if tag not in want]
        changed = [(tag, *row) for tag, row in want.items() if self.rtls_written.get(tag) != row]
        if gone:
            self.x("rtls.locations", "DELETE FROM rtls.locations WHERE tag_id = ANY(%s)", gone)
        if changed:
            self.cur.executemany(
                "INSERT INTO rtls.locations (tag_id, person_id, person_type, role, name, unit, room, bed_id, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (tag_id) DO UPDATE SET "
                "person_id = EXCLUDED.person_id, person_type = EXCLUDED.person_type, role = EXCLUDED.role, "
                "name = EXCLUDED.name, unit = EXCLUDED.unit, room = EXCLUDED.room, bed_id = EXCLUDED.bed_id, "
                "status = EXCLUDED.status, updated_at = now()", changed)
            self.writes["rtls.locations"] += len(changed)
        self.rtls_written = want

    # --- keep tables bounded --------------------------------------------------------
    def prune(self, retention_minutes: int | None = None):
        r = self.cfg.retention_minutes if retention_minutes is None else retention_minutes
        open_round_ids = [s.round_id for s in self.staff.values() if s.round_id is not None]
        self.x("kronos.rounds", "DELETE FROM kronos.rounds WHERE started_at < now() - make_interval(mins => %s) "
               "AND (ended_at IS NOT NULL OR NOT (id = ANY(%s)))", r, open_round_ids)
        self.x("epic.encounters", "DELETE FROM epic.encounters WHERE discharged_at < now() - make_interval(mins => %s)", r)
        self.x("epic.triage_queue", "DELETE FROM epic.triage_queue WHERE status <> 'waiting' "
               "AND updated_at < now() - make_interval(mins => %s)", r)
        self.x("evs.tasks", "DELETE FROM evs.tasks WHERE status = 'done' AND done_at < now() - make_interval(mins => %s)", r)

    def prune_now(self, retention_minutes: int = 0):
        with self.c.transaction(), self.c.cursor() as self.cur:
            self.prune(retention_minutes)
        self.cur = None


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def connect(dsn: str):
    while True:
        try:
            conn = psycopg.connect(dsn, autocommit=True, client_encoding="utf8", application_name="hospital-sim")
            print("simulator: connected", flush=True)
            return conn
        except psycopg.OperationalError as exc:
            print(f"simulator: waiting for database ({exc.__class__.__name__})", flush=True)
            time.sleep(2)


def main(argv=None) -> int:
    cfg, args = config_from_args(argv)
    if args.check:
        from invariants import check
        with psycopg.connect(cfg.dsn, autocommit=True) as conn:
            problems = check(conn, retention_minutes=cfg.retention_minutes)
        print("\n".join(problems) if problems else "invariants: all good")
        return 1 if problems else 0
    conn = connect(cfg.dsn)
    if args.setup_only:
        migrate(conn, cfg)
        ensure_access(conn, cfg)
        return 0
    stop = {"now": False}

    def _stop(*_):
        stop["now"] = True
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    hosp = Hospital(conn, cfg)
    started = time.time()
    next_at = time.monotonic()
    while not stop["now"] and (args.ticks == 0 or hosp.t < args.ticks):
        try:
            hosp.tick()
        except psycopg.OperationalError:
            conn = connect(cfg.dsn)
            hosp = Hospital(conn, cfg, t0=hosp.t)
        except psycopg.Error as exc:   # a conflicting edit by hand: reload the model from the database
            print(f"simulator: reloading after {exc.__class__.__name__}: {exc}", flush=True)
            hosp = Hospital(conn, cfg, t0=hosp.t)
        if not args.fast:
            next_at += 1 / cfg.pace
            time.sleep(max(0.0, next_at - time.monotonic()))
    secs = max(1e-9, time.time() - started)
    print(f"simulator: stopped after {hosp.t} simulated minutes ({secs:.0f} s). Row changes per table:", flush=True)
    for table, n in sorted(hosp.writes.items()):
        print(f"  {table:22s} {n:7d}  ({n / secs * 60:.0f}/min)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
