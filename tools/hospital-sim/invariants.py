"""Invariants the simulated hospital must hold at every commit.

Used by `python hospital_sim.py --check` and by the tests. Reads one consistent
snapshot (REPEATABLE READ), so it is safe to run while the simulator is running.
"""
from __future__ import annotations

CHECKS: list[tuple[str, str]] = [
    ("bed occupied <=> exactly one open encounter", """
        SELECT b.bed_id || ' status=' || b.status || ' open_encounters=' || count(e.encounter_id)
        FROM epic.adt_beds b
        LEFT JOIN epic.encounters e ON e.bed_id = b.bed_id AND e.discharged_at IS NULL
        GROUP BY b.bed_id, b.status
        HAVING (b.status = 'occupied') <> (count(e.encounter_id) = 1) OR count(e.encounter_id) > 1"""),
    ("bed cleaning <=> exactly one open EVS task", """
        SELECT b.bed_id || ' status=' || b.status || ' open_tasks=' || count(t.task_id)
        FROM epic.adt_beds b
        LEFT JOIN evs.tasks t ON t.bed_id = b.bed_id AND t.status = 'open'
        GROUP BY b.bed_id, b.status
        HAVING (b.status = 'cleaning') <> (count(t.task_id) = 1) OR count(t.task_id) > 1"""),
    ("census within capacity", """
        SELECT c.unit || ' capacity=' || c.capacity || ' other=' || c.occupied_other || ' beds=' || count(b.bed_id)
        FROM epic.unit_census c LEFT JOIN epic.adt_beds b ON b.unit = c.unit
        GROUP BY c.unit, c.capacity, c.occupied_other
        HAVING c.occupied_other < 0 OR c.occupied_other + count(b.bed_id) > c.capacity"""),
    ("open encounter current_unit matches its bed", """
        SELECT e.patient_ref || ' bed=' || e.bed_id || ' current_unit=' || coalesce(e.current_unit, 'NULL')
        FROM epic.encounters e JOIN epic.adt_beds b ON b.bed_id = e.bed_id
        WHERE e.discharged_at IS NULL AND e.current_unit IS DISTINCT FROM b.unit"""),
    ("a patient has at most one open encounter", """
        SELECT patient_ref || ' x' || count(*) FROM epic.encounters WHERE discharged_at IS NULL
        GROUP BY patient_ref HAVING count(*) > 1"""),
    ("a patient is never both waiting in triage and in a bed", """
        SELECT q.patient_ref FROM epic.triage_queue q
        JOIN epic.encounters e ON e.patient_ref = q.patient_ref AND e.discharged_at IS NULL
        WHERE q.status = 'waiting'"""),
    ("every bedded patient has exactly one badge, at that bed", """
        SELECT e.patient_ref || ' bed=' || e.bed_id || ' badges=' || count(l.tag_id)
               || ' badge_bed=' || coalesce(min(l.bed_id), 'NULL')
        FROM epic.encounters e
        LEFT JOIN rtls.locations l ON l.person_id = e.patient_ref AND l.person_type = 'patient'
        WHERE e.discharged_at IS NULL
        GROUP BY e.patient_ref, e.bed_id, e.current_unit
        HAVING count(l.tag_id) <> 1 OR min(l.bed_id) IS DISTINCT FROM e.bed_id
            OR min(l.unit) IS DISTINCT FROM e.current_unit"""),
    ("every waiting patient has exactly one badge, not in a bed", """
        SELECT q.patient_ref || ' badges=' || count(l.tag_id)
        FROM epic.triage_queue q
        LEFT JOIN rtls.locations l ON l.person_id = q.patient_ref AND l.person_type = 'patient'
        WHERE q.status = 'waiting'
        GROUP BY q.patient_ref
        HAVING q.patient_ref IS NULL OR count(l.tag_id) <> 1 OR bool_or(l.bed_id IS NOT NULL)"""),
    ("patient badges without a bed or a triage slot are leaving", """
        SELECT l.person_id || ' status=' || coalesce(l.status, 'NULL') FROM rtls.locations l
        WHERE l.person_type = 'patient' AND l.status <> 'leaving'
          AND NOT EXISTS (SELECT 1 FROM epic.encounters e WHERE e.patient_ref = l.person_id AND e.discharged_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM epic.triage_queue q WHERE q.patient_ref = l.person_id AND q.status = 'waiting')"""),
    ("patients in an ambulance are not also in the building", """
        SELECT a.unit_id || ' ' || a.patient_ref FROM gps.ambulances a
        JOIN rtls.locations l ON l.person_id = a.patient_ref WHERE a.status = 'inbound'"""),
    ("one badge per person", """
        SELECT person_id || ' x' || count(*) FROM rtls.locations GROUP BY person_id HAVING count(*) > 1"""),
    ("staff badge <=> on shift", """
        SELECT r.staff_id || ' on_shift=' || r.on_shift || ' badge=' || (l.tag_id IS NOT NULL)
        FROM kronos.roster r LEFT JOIN rtls.locations l ON l.person_id = r.staff_id AND l.person_type = 'staff'
        WHERE r.on_shift <> (l.tag_id IS NOT NULL)"""),
    ("open EVS tasks: one task per cleaner, cleaner on shift", """
        SELECT t.assigned_to || ' tasks=' || count(*) FROM evs.tasks t
        LEFT JOIN kronos.roster r ON r.staff_id = t.assigned_to
        WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
        GROUP BY t.assigned_to HAVING count(*) > 1 OR NOT bool_and(coalesce(r.on_shift, false))"""),
    ("ambulance status consistent with ETA", """
        SELECT unit_id || ' ' || status || ' eta=' || coalesce(eta_min::text, 'NULL') FROM gps.ambulances
        WHERE (status = 'inbound' AND (eta_min IS NULL OR eta_min <= 0 OR patient_ref IS NULL))
           OR (status = 'idle' AND (eta_min IS NOT NULL OR patient_ref IS NOT NULL))"""),
    ("at most one open round per staff member", """
        SELECT staff_id || ' x' || count(*) FROM kronos.rounds WHERE ended_at IS NULL AND staff_id IS NOT NULL
        GROUP BY staff_id HAVING count(*) > 1"""),
]

# Closed rows older than retention (+ slack for the prune interval) must be gone.
STALE = {
    "kronos.rounds": "SELECT count(*) FROM kronos.rounds WHERE ended_at < now() - make_interval(mins => %s)",
    "epic.encounters": "SELECT count(*) FROM epic.encounters WHERE discharged_at < now() - make_interval(mins => %s)",
    "epic.triage_queue": "SELECT count(*) FROM epic.triage_queue WHERE status <> 'waiting' "
                         "AND updated_at < now() - make_interval(mins => %s)",
    "evs.tasks": "SELECT count(*) FROM evs.tasks WHERE status = 'done' AND done_at < now() - make_interval(mins => %s)",
}

TABLES = ["epic.adt_beds", "epic.encounters", "epic.unit_census", "epic.triage_queue", "kronos.roster",
          "kronos.rounds", "evs.tasks", "gps.ambulances", "rtls.locations"]


def check(conn, retention_minutes: int | None = None, slack_minutes: int = 5) -> list[str]:
    problems: list[str] = []
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        for name, q in CHECKS:
            cur.execute(q)
            bad = [r[0] for r in cur.fetchall()]
            if bad:
                problems.append(f"FAIL {name}: {', '.join(map(str, bad[:8]))}" + (" ..." if len(bad) > 8 else ""))
        if retention_minutes is not None:
            for table, q in STALE.items():
                cur.execute(q, (retention_minutes + slack_minutes,))
                n = cur.fetchone()[0]
                if n:
                    problems.append(f"FAIL {table} keeps {n} closed rows older than retention")
    return problems


def row_counts(conn) -> dict[str, int]:
    out = {}
    with conn.cursor() as cur:
        for t in TABLES:
            cur.execute(f"SELECT count(*) FROM {t}")
            out[t] = cur.fetchone()[0]
    return out
