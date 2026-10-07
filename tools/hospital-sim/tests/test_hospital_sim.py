import psycopg
import pytest

from hospital_sim import Config, Hospital, migrate, parse_counts
from invariants import check


def quiet(**kw) -> Config:
    kw.setdefault("seed", 1)
    return Config(verbose=False, **kw)


def run(h: Hospital, ticks: int, check_every: int = 0, conn=None):
    for _ in range(ticks):
        h.tick()
        if check_every and h.t % check_every == 0:
            assert check(conn) == [], f"invariants broken at t={h.t}"


def test_schema_additions_are_idempotent_and_keep_old_queries_working(db):
    cfg = quiet()
    assert migrate(db, cfg, log=lambda m: None)            # first run adds columns/tables
    assert migrate(db, cfg, log=lambda m: None) == []      # rerun: nothing to do, no locks taken
    Hospital(db, cfg, log=lambda m: None)
    # what the original simulator and views do still works (rolled back afterwards)
    with db.transaction(force_rollback=True):
        db.execute("INSERT INTO epic.triage_queue DEFAULT VALUES")
        db.execute("INSERT INTO kronos.rounds (staff_name, bed_id) VALUES ('Dr. Rao', 'B01')")
        db.execute("INSERT INTO evs.tasks (bed_id) VALUES ('B01')")
        for view in ("hospital_live", "unit_capacity", "er_status", "ambulance_eta", "recent_rounds",
                     "cleaning_tasks", "people_live"):
            db.execute(f"SELECT * FROM zetaris.{view}").fetchall()


def test_reader_and_publication_cover_new_table(db):
    Hospital(db, quiet(), log=lambda m: None)
    assert db.execute("SELECT has_table_privilege('liveops_reader', 'rtls.locations', 'SELECT')").fetchone()[0]
    assert db.execute("SELECT has_table_privilege('liveops_reader', 'zetaris.people_live', 'SELECT')").fetchone()[0]
    pub = {r[0] for r in db.execute("SELECT schemaname || '.' || tablename FROM pg_publication_tables "
                                    "WHERE pubname = 'liveops'")}
    assert "rtls.locations" in pub and "epic.adt_beds" in pub


def test_configured_size(db):
    h = Hospital(db, quiet(), log=lambda m: None)
    per_unit = dict(db.execute("SELECT unit, count(*) FROM epic.adt_beds WHERE in_service GROUP BY unit"))
    assert per_unit == parse_counts("ER:8,ICU:6,General:16,Pediatrics:6")
    staff = db.execute("SELECT role, count(*) FROM kronos.roster WHERE crew IN ('A','B') GROUP BY role").fetchall()
    assert dict(staff) == {"nurse": 24, "doctor": 12, "cleaner": 6}
    assert db.execute("SELECT count(*) FROM gps.ambulances").fetchone()[0] == 3
    assert check(db) == []
    assert h.t == 0


def test_invariants_hold_through_a_simulated_day(db):
    h = Hospital(db, quiet(), log=lambda m: None)
    run(h, 1440, check_every=20, conn=db)
    joined = "\n".join(h.events)
    assert "ER rush begins" in joined and "shift change" in joined
    # every kind of change happened
    for table in ("epic.adt_beds", "epic.encounters", "epic.triage_queue", "evs.tasks", "gps.ambulances",
                  "kronos.rounds", "kronos.roster", "rtls.locations", "epic.unit_census"):
        assert h.writes[table] > 0, table
    # rounds carry bed ids; patients carry synthetic refs only
    assert db.execute("SELECT count(*) FROM kronos.rounds WHERE bed_id IS NULL").fetchone()[0] == 0
    names = [r[0] for r in db.execute("SELECT name FROM rtls.locations WHERE person_type = 'patient'")]
    assert names and all(n.startswith("P-") for n in names)


def test_every_patient_is_in_exactly_one_place(db):
    h = Hospital(db, quiet(seed=7), log=lambda m: None)
    run(h, 400)
    rows = db.execute("SELECT person_id, count(*) FROM rtls.locations WHERE person_type = 'patient' "
                      "GROUP BY person_id").fetchall()
    assert all(n == 1 for _, n in rows)
    in_model = {ref for ref, p in h.patients.items()}
    assert {r[0] for r in rows} == in_model
    for a in h.ambulances.values():   # on the way in: in the ambulance, not in the building
        if a.patient:
            assert a.patient.ref not in in_model


def test_deterministic_with_seed(make_db):
    def go(seed):
        with psycopg.connect(make_db(), autocommit=True) as conn:
            h = Hospital(conn, quiet(seed=seed), log=lambda m: None)
            run(h, 400)
            rows = conn.execute("SELECT tag_id, unit, room, bed_id, status FROM rtls.locations ORDER BY 1").fetchall()
            beds = conn.execute("SELECT bed_id, status FROM epic.adt_beds ORDER BY 1").fetchall()
            return h.events, rows, beds
    a, b, c = go(3), go(3), go(4)
    assert a == b
    assert a[0] != c[0]


def test_rows_stay_bounded(db):
    h = Hospital(db, quiet(), log=lambda m: None)
    run(h, 600)
    h.prune_now(0)    # retention 0: everything closed goes
    one = lambda q: db.execute(q).fetchone()[0]
    assert one("SELECT count(*) FROM epic.encounters") == one(
        "SELECT count(*) FROM epic.encounters WHERE discharged_at IS NULL")
    assert one("SELECT count(*) FROM epic.triage_queue WHERE status <> 'waiting'") == 0
    assert one("SELECT count(*) FROM evs.tasks WHERE status = 'done'") == 0
    assert one("SELECT count(*) FROM kronos.rounds") <= len(h.staff)
    assert one("SELECT count(*) FROM rtls.locations") == len(h.patients) + sum(s.present for s in h.staff.values())
    assert check(db, retention_minutes=0) == []


def test_restart_resumes_consistently(db):
    h = Hospital(db, quiet(), log=lambda m: None)
    run(h, 300)
    h2 = Hospital(db, quiet(seed=2), log=lambda m: None, t0=h.t)   # e.g. container restarted
    assert check(db) == []
    run(h2, 300, check_every=25, conn=db)


def test_hand_edits_are_repaired_on_start(db):
    Hospital(db, quiet(), log=lambda m: None)
    db.execute("UPDATE epic.adt_beds SET status = 'occupied' WHERE bed_id = (SELECT min(bed_id) FROM epic.adt_beds "
               "WHERE status = 'free')")
    db.execute("UPDATE epic.adt_beds SET status = 'cleaning' WHERE bed_id = (SELECT min(bed_id) FROM epic.adt_beds "
               "WHERE status = 'free')")
    db.execute("INSERT INTO epic.triage_queue DEFAULT VALUES")
    assert check(db) != []
    Hospital(db, quiet(), log=lambda m: None)
    assert check(db) == []


def test_custom_units_and_closed_beds(db):
    cfg = quiet(units=parse_counts("ER:4,ICU:2,Cardiology:5"), nurses=parse_counts("ER:2,ICU:1,Cardiology:2"),
                doctors=parse_counts("ER:1,ICU:1,Cardiology:1"), cleaners=1, ambulances=1)
    h = Hospital(db, cfg, log=lambda m: None)
    start = db.execute("SELECT now()").fetchone()[0]
    run(h, 500, check_every=50, conn=db)
    closed = db.execute("SELECT count(*) FROM epic.encounters e JOIN epic.adt_beds b USING (bed_id) "
                        "WHERE NOT b.in_service AND e.admitted_at >= %s", (start,)).fetchone()[0]
    assert closed == 0
    assert db.execute("SELECT count(*) FROM epic.adt_beds WHERE unit = 'Cardiology' AND in_service").fetchone()[0] == 5


def test_config_requires_er():
    with pytest.raises(ValueError):
        Config(units=parse_counts("ICU:4"))
