"""Each test gets its own throwaway database built from init.sql, set up the way
the user's `sources` database is (publication `liveops` on the 8 original tables,
liveops_reader with SELECT). Needs a Postgres with wal_level=logical:

    HOSPITAL_SIM_TEST_DSN=postgresql://postgres:postgres@localhost:5432/postgres pytest tools/hospital-sim/tests
"""
import os
import pathlib
import sys
import uuid

import psycopg
import pytest

HERE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

ADMIN_DSN = os.environ.get("HOSPITAL_SIM_TEST_DSN", "postgresql://postgres:postgres@localhost:5432/postgres")
ORIGINAL_TABLES = ("epic.adt_beds, epic.encounters, epic.unit_census, epic.triage_queue, "
                   "kronos.roster, kronos.rounds, evs.tasks, gps.ambulances")


def _admin():
    try:
        return psycopg.connect(ADMIN_DSN, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as exc:
        pytest.skip(f"no test Postgres at HOSPITAL_SIM_TEST_DSN ({exc.__class__.__name__})")


def _dsn_for(db: str) -> str:
    return psycopg.conninfo.make_conninfo(ADMIN_DSN, dbname=db)


@pytest.fixture
def make_db():
    """Factory: make_db() -> dsn of a fresh copy of the user's schema."""
    admin = _admin()
    made = []

    def make() -> str:
        db = f"hsim_test_{uuid.uuid4().hex[:10]}"
        admin.execute(f'CREATE DATABASE "{db}"')
        made.append(db)
        init = (HERE / "init.sql").read_text().replace(
            "CREATE ROLE liveops_reader LOGIN PASSWORD 'reader_pw';",
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liveops_reader') THEN "
            "CREATE ROLE liveops_reader LOGIN PASSWORD 'reader_pw'; END IF; END $$;")
        with psycopg.connect(_dsn_for(db), autocommit=True) as conn:
            conn.execute(init)
            conn.execute(f"CREATE PUBLICATION liveops FOR TABLE {ORIGINAL_TABLES}")
            conn.execute("GRANT USAGE ON SCHEMA epic, kronos, evs, gps TO liveops_reader")
            conn.execute(f"GRANT SELECT ON {ORIGINAL_TABLES} TO liveops_reader")
        return _dsn_for(db)

    yield make
    for db in made:
        admin.execute(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)')
    admin.close()


@pytest.fixture
def db(make_db):
    dsn = make_db()
    with psycopg.connect(dsn, autocommit=True) as conn:
        yield conn
