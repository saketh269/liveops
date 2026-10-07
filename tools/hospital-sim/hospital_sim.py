"""Keeps the mock hospital systems busy, like a real day on Ward 2.

Writes ONLY to the source systems (epic, kronos, evs, gps). It never touches
the portal. The portal sees each change the same way it would in production:
by reading the unified views through Zetaris (or the stand-in).
"""
import os
import random
import time

import psycopg

DSN = os.environ.get("SOURCES_DSN", "postgresql://postgres:liveops@localhost:5433/sources")
DOCTORS = ["Dr. Okafor", "Dr. Lindqvist", "Dr. Rao"]
AMBULANCE_TRIP_SECONDS = 9       # one simulated "minute" per real second
CLEANING_SECONDS = 10
MAP_BEDS = {"ER": 4, "ICU": 4, "General": 4, "Pediatrics": 0}


def connect():
    while True:
        try:
            conn = psycopg.connect(DSN, autocommit=True, client_encoding="utf8")
            print("simulator: connected", flush=True)
            return conn
        except psycopg.OperationalError as exc:
            print(f"simulator: waiting for database ({exc.__class__.__name__})", flush=True)
            time.sleep(2)


class Ward:
    def __init__(self, conn):
        self.c = conn
        self.amb_started = None
        self.amb_arrived = None
        self.er_admit_due = None
        row = self.one("SELECT COALESCE(MAX(SUBSTRING(patient_ref FROM 3)::int), 1039) FROM epic.encounters")
        self.next_pid = row[0] + 1
        status = self.one("SELECT status FROM gps.ambulances WHERE unit_id = 'A-7'")
        if status and status[0] != "idle":
            self.x("UPDATE gps.ambulances SET status = 'idle', eta_min = NULL, updated_at = now() WHERE unit_id = 'A-7'")

    def x(self, sql, *args):
        with self.c.cursor() as cur:
            cur.execute(sql, args)

    def one(self, sql, *args):
        with self.c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchone()

    def all(self, sql, *args):
        with self.c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def beds(self, status, units=None):
        rows = self.all("SELECT bed_id, unit FROM epic.adt_beds WHERE status = %s ORDER BY bed_id", status)
        return [r for r in rows if units is None or r[1] in units]

    # --- actions -----------------------------------------------------------
    def admit(self, bed_id):
        pid = f"P-{self.next_pid}"
        self.next_pid += 1
        with self.c.transaction():
            self.x("UPDATE epic.adt_beds SET status = 'occupied', updated_at = now() WHERE bed_id = %s AND status = 'free'", bed_id)
            self.x("INSERT INTO epic.encounters (patient_ref, bed_id) VALUES (%s, %s)", pid, bed_id)
        return pid

    def discharge(self, bed_id):
        with self.c.transaction():
            self.x("UPDATE epic.encounters SET discharged_at = now() WHERE bed_id = %s AND discharged_at IS NULL", bed_id)
            self.x("UPDATE epic.adt_beds SET status = 'cleaning', updated_at = now() WHERE bed_id = %s", bed_id)
            self.x("INSERT INTO evs.tasks (bed_id) VALUES (%s)", bed_id)

    def finish_cleaning(self):
        due = self.all("SELECT task_id, bed_id FROM evs.tasks WHERE status = 'open' AND created_at < now() - make_interval(secs => %s)", CLEANING_SECONDS)
        for task_id, bed_id in due:
            with self.c.transaction():
                self.x("UPDATE evs.tasks SET status = 'done', done_at = now() WHERE task_id = %s", task_id)
                self.x("UPDATE epic.adt_beds SET status = 'free', updated_at = now() WHERE bed_id = %s AND status = 'cleaning'", bed_id)

    def census_walk(self):
        unit = random.choice(list(MAP_BEDS))
        cap, other = self.one("SELECT capacity, occupied_other FROM epic.unit_census WHERE unit = %s", unit)
        room = cap - MAP_BEDS[unit]
        delta = 1 if random.random() < 0.5 else -1
        if 1 <= other + delta <= room:
            self.x("UPDATE epic.unit_census SET occupied_other = occupied_other + %s WHERE unit = %s", delta, unit)

    def triage_walk(self):
        waiting = self.one("SELECT COUNT(*) FROM epic.triage_queue WHERE status = 'waiting'")[0]
        down = random.random() < (0.7 if waiting > 6 else 0.45)
        if down and waiting > 1:
            self.x("UPDATE epic.triage_queue SET status = 'left' WHERE id = (SELECT MIN(id) FROM epic.triage_queue WHERE status = 'waiting')")
        elif not down and waiting < 10:
            self.x("INSERT INTO epic.triage_queue DEFAULT VALUES")

    # --- one random event, every 2 to 3.5 seconds -------------------------
    def step(self):
        r = random.random()
        if r < 0.24:
            free = self.beds("free", {"ICU", "General"})
            if free:
                self.admit(random.choice(free)[0])
                return
        elif r < 0.46:
            occupied = self.beds("occupied")
            if len(occupied) >= 5:
                self.discharge(random.choice(occupied)[0])
                return
        elif r < 0.66:
            occupied = self.beds("occupied")
            if occupied:
                self.x("INSERT INTO kronos.rounds (staff_name, bed_id) VALUES (%s, %s)", random.choice(DOCTORS), random.choice(occupied)[0])
                return
        elif r < 0.8 and self.amb_started is None and self.amb_arrived is None:
            self.amb_started = time.time()
            self.x("UPDATE gps.ambulances SET status = 'inbound', eta_min = %s, updated_at = now() WHERE unit_id = 'A-7'", AMBULANCE_TRIP_SECONDS)
            return
        self.census_walk()
        if random.random() < 0.4:
            self.triage_walk()

    # --- every second: ambulance position, cleaning, ER admission ------------
    def tick(self, now):
        if self.amb_started is not None:
            eta = AMBULANCE_TRIP_SECONDS - (now - self.amb_started)
            if eta > 0:
                self.x("UPDATE gps.ambulances SET eta_min = %s, updated_at = now() WHERE unit_id = 'A-7'", round(eta, 1))
            else:
                self.x("UPDATE gps.ambulances SET status = 'arrived', eta_min = 0, updated_at = now() WHERE unit_id = 'A-7'")
                self.x("INSERT INTO epic.triage_queue DEFAULT VALUES")
                self.amb_started, self.amb_arrived, self.er_admit_due = None, now, now + 3
        if self.er_admit_due and now >= self.er_admit_due:
            self.er_admit_due = None
            free = self.beds("free", {"ER"})
            if free:
                self.admit(random.choice(free)[0])
                self.x("UPDATE epic.triage_queue SET status = 'admitted' WHERE id = (SELECT MAX(id) FROM epic.triage_queue WHERE status = 'waiting')")
        if self.amb_arrived and now - self.amb_arrived > 6:
            self.amb_arrived = None
            self.x("UPDATE gps.ambulances SET status = 'idle', eta_min = NULL, updated_at = now() WHERE unit_id = 'A-7'")
        self.finish_cleaning()


def main():
    pace = float(os.environ.get("SIM_PACE", "1"))
    conn = connect()
    ward = Ward(conn)
    next_event = time.time() + 2
    while True:
        now = time.time()
        try:
            ward.tick(now)
            if now >= next_event:
                ward.step()
                next_event = now + random.uniform(2.0, 3.5) / pace
        except psycopg.OperationalError:
            conn = connect()
            ward = Ward(conn)
        except psycopg.Error as exc:  # a rare conflict: log and carry on
            print(f"simulator: skipped one change ({exc.__class__.__name__}: {exc})", flush=True)
        time.sleep(1)


if __name__ == "__main__":
    main()
