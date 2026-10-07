-- Mock hospital source systems for the Live Ops Phase 2 pipeline.
-- All data is synthetic. Four schemas stand in for four separate systems:
--   epic   = EHR (admissions, beds, triage)       -> in a real hospital: Epic, Cerner...
--   kronos = staff roster and rounds              -> workforce system
--   evs    = environmental services (cleaning)    -> housekeeping system
--   gps    = ambulance fleet positions            -> fleet / GPS feed
-- The "zetaris" schema holds the unified views. In production these views live
-- in Zetaris and join the four systems where they sit. Here, Postgres plays
-- Zetaris' part so the pipeline runs end to end on a laptop.

CREATE SCHEMA epic;
CREATE SCHEMA kronos;
CREATE SCHEMA evs;
CREATE SCHEMA gps;
CREATE SCHEMA zetaris;

CREATE TABLE epic.adt_beds (
  bed_id     text PRIMARY KEY,
  unit       text NOT NULL,
  status     text NOT NULL CHECK (status IN ('free', 'occupied', 'cleaning')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE epic.encounters (
  encounter_id  serial PRIMARY KEY,
  patient_ref   text NOT NULL,
  bed_id        text NOT NULL REFERENCES epic.adt_beds (bed_id),
  admitted_at   timestamptz NOT NULL DEFAULT now(),
  discharged_at timestamptz
);
CREATE UNIQUE INDEX one_open_encounter_per_bed ON epic.encounters (bed_id) WHERE discharged_at IS NULL;

-- Beds on other wards, kept as counts so unit totals are realistic.
CREATE TABLE epic.unit_census (
  unit           text PRIMARY KEY,
  capacity       int  NOT NULL,
  occupied_other int  NOT NULL CHECK (occupied_other >= 0)
);

CREATE TABLE epic.triage_queue (
  id         serial PRIMARY KEY,
  arrived_at timestamptz NOT NULL DEFAULT now(),
  status     text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'admitted', 'left'))
);

CREATE TABLE kronos.roster (
  staff_id text PRIMARY KEY,
  name     text NOT NULL,
  role     text NOT NULL,
  unit     text NOT NULL,
  on_shift boolean NOT NULL DEFAULT true
);

CREATE TABLE kronos.rounds (
  id         serial PRIMARY KEY,
  staff_name text NOT NULL,
  bed_id     text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evs.tasks (
  task_id    serial PRIMARY KEY,
  bed_id     text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz
);

CREATE TABLE gps.ambulances (
  unit_id    text PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('idle', 'inbound', 'arrived')),
  eta_min    numeric(5, 1),
  dest_unit  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed data: 12 beds on Ward 2 (4 Emergency, 4 ICU, 4 General).
INSERT INTO epic.adt_beds (bed_id, unit, status) VALUES
  ('B01', 'ER', 'occupied'), ('B02', 'ER', 'occupied'), ('B03', 'ICU', 'occupied'), ('B04', 'ICU', 'free'),
  ('B05', 'General', 'occupied'), ('B06', 'General', 'occupied'), ('B07', 'ER', 'occupied'), ('B08', 'ER', 'free'),
  ('B09', 'ICU', 'occupied'), ('B10', 'ICU', 'cleaning'), ('B11', 'General', 'free'), ('B12', 'General', 'occupied');

INSERT INTO epic.encounters (patient_ref, bed_id, admitted_at) VALUES
  ('P-1040', 'B01', now() - interval '3 hours'), ('P-1041', 'B02', now() - interval '50 minutes'),
  ('P-1042', 'B03', now() - interval '2 days'),  ('P-1043', 'B05', now() - interval '5 hours'),
  ('P-1044', 'B06', now() - interval '1 day'),   ('P-1045', 'B07', now() - interval '20 minutes'),
  ('P-1046', 'B09', now() - interval '9 hours'), ('P-1047', 'B12', now() - interval '4 hours');

INSERT INTO evs.tasks (bed_id, created_at) VALUES ('B10', now());

INSERT INTO epic.unit_census (unit, capacity, occupied_other) VALUES
  ('ER', 10, 4), ('ICU', 8, 3), ('General', 26, 18), ('Pediatrics', 6, 4);

INSERT INTO epic.triage_queue (status) SELECT 'waiting' FROM generate_series(1, 5);

INSERT INTO kronos.roster (staff_id, name, role, unit) VALUES
  ('S01', 'Dr. Okafor', 'doctor', 'ER'), ('S02', 'Dr. Lindqvist', 'doctor', 'ICU'), ('S03', 'Dr. Rao', 'doctor', 'General'),
  ('S04', 'Nurse Patel', 'nurse', 'ER'), ('S05', 'Nurse Kim', 'nurse', 'ICU'), ('S06', 'Nurse Alvarez', 'nurse', 'General');

INSERT INTO gps.ambulances (unit_id, status, eta_min, dest_unit) VALUES ('A-7', 'idle', NULL, 'ER');

-- ---------------------------------------------------------------------------
-- Unified views: what the portal reads. Same names and columns as the views
-- you will create in Zetaris (see zetaris/views.sql).
-- ---------------------------------------------------------------------------
CREATE VIEW zetaris.hospital_live AS
SELECT b.bed_id, b.unit, b.status, e.patient_ref, b.updated_at
FROM epic.adt_beds b
LEFT JOIN epic.encounters e ON e.bed_id = b.bed_id AND e.discharged_at IS NULL;

CREATE VIEW zetaris.unit_capacity AS
SELECT c.unit, c.capacity, c.occupied_other + COALESCE(w.n, 0) AS occupied
FROM epic.unit_census c
LEFT JOIN (SELECT unit, COUNT(*) AS n FROM epic.adt_beds WHERE status = 'occupied' GROUP BY unit) w ON w.unit = c.unit;

CREATE VIEW zetaris.er_status AS
SELECT COUNT(*) FILTER (WHERE status = 'waiting') AS waiting
FROM epic.triage_queue;

CREATE VIEW zetaris.ambulance_eta AS
SELECT unit_id, status, eta_min, dest_unit, updated_at
FROM gps.ambulances;

CREATE VIEW zetaris.recent_rounds AS
SELECT r.id AS round_id, r.staff_name, r.bed_id, r.started_at
FROM kronos.rounds r
WHERE r.started_at > now() - interval '10 minutes';

CREATE VIEW zetaris.cleaning_tasks AS
SELECT t.bed_id, t.status, t.created_at, t.done_at
FROM evs.tasks t
WHERE t.status = 'open' OR t.done_at > now() - interval '10 minutes';

-- The portal's read-only user. Views run with their owner's rights, so this
-- user can read the views and nothing else: no base tables, no writes.
CREATE ROLE liveops_reader LOGIN PASSWORD 'reader_pw';
GRANT USAGE ON SCHEMA zetaris TO liveops_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA zetaris TO liveops_reader;
ALTER ROLE liveops_reader SET statement_timeout = '10s';
ALTER ROLE liveops_reader SET default_transaction_read_only = on;
