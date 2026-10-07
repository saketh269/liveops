# Hospital simulator (test tool)

Makes the mock hospital database (`sources`) behave like a busy hospital so the
Live Ops map can be developed and demoed. **Test tool only**: it lives in
`tools/hospital-sim/` and never ships in product images (ADR 0006). All data is
synthetic; patients only ever have refs like `P-1234`, never names.

## What happens

One tick = one simulated minute. `--pace 1` = one tick per real second, so a
12-hour shift passes in 12 real minutes. The day starts at 16:00, so the first
shift change (19:00) comes about 3 minutes after you start it.

- **Patients** arrive on foot (`Entrance` → `Waiting Room`) or by **ambulance**
  (`gps.ambulances` goes `inbound` with an `eta_min` countdown → `arrived` →
  `idle`; the patient waits in `Ambulance Bay`). Triage puts the sickest first
  (acuity 1–5). Low-acuity patients who wait too long leave without being seen.
- An **ER bed** is assigned (`triage_queue.status = admitted`, a new
  `epic.encounters` row). After the ER stay the patient is discharged or
  admitted to ICU / General / Pediatrics. With no bed free they **board** in the
  ER bed. Later they transfer (ICU → General step-down, rare General → ICU) and
  are discharged. Inpatient stays are compressed to hours so beds keep turning.
- A vacated bed goes `occupied → cleaning`: an `evs.tasks` row opens, a cleaner
  is assigned, walks there (`travelling`), cleans, and the bed becomes `free`.
- **Nurses** round on their unit's beds and **doctors** move between units
  (`kronos.rounds` rows with `bed_id`, `ended_at` when they leave the bed).
- **Shift change**: crew B arrives 15 minutes early for handover, crew A
  finishes what it is doing and leaves (`kronos.roster.on_shift`).
- **ER rushes** (every ~4 simulated hours, 40–90 minutes) push the waiting room
  and boarding up so alerts have something to fire on.
- **`rtls.locations`**: one row per person in the building, like badge tracking.
  A row is deleted when the person leaves (discharge, left without being seen,
  end of shift).
- `epic.unit_census` (beds that are not on the map) drifts within capacity.
- Closed rows (discharged encounters, done tasks, ended rounds, finished triage
  rows) are deleted after `--retention-minutes` (real minutes, default 30), so
  tables stay small.
- Same starting database + same `--seed` = the same sequence of events.

## Run it on your Windows PC

Your `sources` database runs in container `liveops-sources-db-1`, published on
host port 5433. Pick one of the two ways below.

### A. Python (simplest)

```powershell
cd C:\path\to\liveops\tools\hospital-sim
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python hospital_sim.py --dsn "postgresql://postgres:liveops@localhost:5433/sources" --pace 1 --seed 1
```

Stop with `Ctrl+C`; it prints the row changes per table.

### B. Docker

```powershell
cd C:\path\to\liveops\tools\hospital-sim
$env:SOURCES_DSN = "postgresql://postgres:liveops@host.docker.internal:5433/sources"
docker compose -f docker-compose.sim.yml up --build -d
docker compose -f docker-compose.sim.yml logs -f
# when done
docker compose -f docker-compose.sim.yml down
```

Stop any older simulator first: only **one** simulator should write to the
database at a time.

### Check it is healthy

```powershell
python hospital_sim.py --dsn "postgresql://postgres:liveops@localhost:5433/sources" --check
```

prints `invariants: all good` or the rule that is broken (bed double-booked,
census out of range, a patient in two places, ...).

## Options

| Flag | Env | Default | |
|---|---|---|---|
| `--dsn` | `SOURCES_DSN` | `postgresql://postgres:liveops@localhost:5433/sources` | |
| `--pace` | `SIM_PACE` | `1` | simulated minutes per real second |
| `--seed` | `SIM_SEED` | none | repeatable runs |
| `--units` | `SIM_UNITS` | `ER:8,ICU:6,General:16,Pediatrics:6` | beds per unit (ER required; other names become general wards) |
| `--nurses` | `SIM_NURSES` | `ER:3,ICU:3,General:4,Pediatrics:2` | per unit, per crew |
| `--doctors` | `SIM_DOCTORS` | `ER:2,ICU:1,General:2,Pediatrics:1` | per unit, per crew |
| `--cleaners` | `SIM_CLEANERS` | `3` | EVS cleaners per crew |
| `--ambulances` | `SIM_AMBULANCES` | `3` | |
| `--shift-minutes` | `SIM_SHIFT_MINUTES` | `720` | |
| `--surge-every` | `SIM_SURGE_EVERY` | `240` | mean simulated minutes between ER rushes, `0` = none |
| `--arrival-scale` | `SIM_ARRIVAL_SCALE` | `1` | more or fewer patients |
| `--retention-minutes` | `SIM_RETENTION_MINUTES` | `30` | min 10 (the views look back 10 min) |
| `--setup-only` | | | apply schema additions and grants, then exit |
| `--check` | | | check invariants and exit |

## What it changes in your database (first run)

All additions are idempotent: a column is added only if missing, and a rerun
does nothing. No existing column or table is changed or removed, and the
existing views keep working.

- New columns
  - `epic.adt_beds`: `room`, `in_service`
  - `epic.encounters`: `current_unit`, `status` (`in_transit`, `in_bed`, `boarding`, `discharged`), `arrival_mode`, `acuity`, `updated_at`
  - `epic.triage_queue`: `patient_ref`, `arrival_mode`, `acuity`, `updated_at`
  - `kronos.roster`: `crew` (`A`, `B`, or `inactive`), `updated_at`
  - `kronos.rounds`: `staff_id`, `role`, `unit`, `ended_at`
  - `evs.tasks`: `unit`, `phase` (`queued`, `travelling`, `cleaning`, `done`), `assigned_to`, `cleaner_name`, `started_at`
  - `gps.ambulances`: `patient_ref`, `priority`
- New table `rtls.locations (tag_id PK, person_id, person_type patient|staff, role, name, unit, room, bed_id, status, updated_at)`
  and view `zetaris.people_live` over it.
- Data, sized to the config: beds `B13`–`B36` are added (the 12 existing beds keep their ids and units),
  rooms are named (`ER Bay 1`, `ICU 1`, `Room 201`, `Peds 301`), staff and ambulances are added, census
  `occupied_other` is clamped so census + mapped beds never exceed capacity, waiting triage rows get patient refs,
  and mostly empty units are pre-filled with patients. Shrinking `--units` later marks beds `in_service = false`
  instead of deleting them.

### Access for the portal

When the simulator connects as `postgres` (as above), it runs these itself and logs them. If it connects as a
user that is not allowed to, it prints them; run them as an admin:

```powershell
docker exec -it liveops-sources-db-1 psql -U postgres -d sources -c "GRANT USAGE ON SCHEMA rtls TO liveops_reader; GRANT SELECT ON rtls.locations TO liveops_reader; GRANT SELECT ON zetaris.people_live TO liveops_reader; ALTER PUBLICATION liveops ADD TABLE rtls.locations;"
```

Existing grants on the 8 original tables already cover their new columns.

## Mappings to create in Live Ops

Use the PostgreSQL CDC source with publication `liveops`. Map **beds** and **people**; the rest feed alerts and
counters. Do not map both `epic.encounters` and `rtls.locations` patients: each patient would be drawn twice.

| Dataset | ID | Zone | State | Label | Kind | Role | Anchor | Filter |
|---|---|---|---|---|---|---|---|---|
| `epic.adt_beds` | `bed_id` | `unit` | `status` (already `free`/`occupied`/`cleaning`) | `room` | fixed `bed` | | | `in_service` eq `true` |
| `rtls.locations` | `tag_id` | `unit` | `status` | `name` | column `person_type` | `role` | `bed_id` | none |
| `gps.ambulances` | `unit_id` | `dest_unit` | `status` | `unit_id` | fixed `ambulance` | | | none (or `status` ne `idle`) |
| `epic.encounters` *(only if you do not use rtls)* | `patient_ref` | `current_unit` | `status` | `patient_ref` | fixed `patient` | fixed `patient` | `bed_id` | `discharged_at` is_null |

Suggested state map for `rtls.locations`: `rounds`, `seeing_patient`, `travelling`, `walking`, `in_bed`,
`in_transit` → `in_use`; `available`, `station`, `charting`, `handover`, `leaving` → `free`; `cleaning` → `cleaning`;
`boarding`, `awaiting_transfer` → `alert`. For `gps.ambulances`: `idle` → `free`, `inbound` → `in_use`,
`arrived` → `alert`. Useful attributes: `eta_min`, `patient_ref` (ambulances), `acuity` (encounters).

Zones the data uses: `ER`, `ICU`, `General`, `Pediatrics` (beds and people), plus `Entrance`, `Waiting Room`,
`Ambulance Bay`, `Lobby`, `EVS` (people only). The map creates missing zones from the data; place them on the
layout as you like.

Not map assets, but good for alerts and counters: `zetaris.er_status` / `epic.triage_queue` (waiting room),
`zetaris.unit_capacity` / `epic.unit_census` (unit occupancy), `evs.tasks` (open cleaning, `phase`),
`kronos.rounds` / `zetaris.recent_rounds` (last round per bed), `epic.encounters` where `status = 'boarding'`.

## Tests

Need a local Postgres 12+ with `wal_level=logical` (each test makes and drops its own database):

```bash
HOSPITAL_SIM_TEST_DSN=postgresql://postgres:postgres@localhost:5432/postgres python -m pytest tools/hospital-sim/tests
```
