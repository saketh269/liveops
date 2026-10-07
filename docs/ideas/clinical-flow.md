# Clinical flow: what would make a hospital flow team open Live Ops every hour

Product research for LIVEOPS-101 (Live Ops 0.2 and later). Healthcare first. Rule kept throughout: every figure on the map is a real record; nothing is simulated or "predicted" as if it were real.

## 1. Summary

Flow teams already have the numbers (Epic bed boards, census reports, EVS dashboards). What they lack is one shared picture of *where the next bed is coming from and what is blocking it*, so they spend the day on the phone reconciling systems that disagree. Live Ops earns an hourly visit if it answers four questions on one floor-plan view, faster than a phone call: (1) which admitted ED patients are boarding, and for how long; (2) which beds will open soon (discharge ordered, patient still in bed, ride pending); (3) which dirty beds are waiting for EVS or transport, with a timer; (4) what is inbound (ambulances, transfers, PACU). The hook is the *pipeline* (pending discharge to dirty to cleaning to clean to assigned), not the static bed status. The literature backs the stakes: CMS's new ED access measure counts boarding over 4 hours and LWBS as quality failures from 2027 ([eCQI CMS1244](https://ecqi.healthit.gov/sites/default/files/ecqm/measures/CMS1244-v1.2.000-QDM.html)), AHRQ frames boarding as a hospital-wide (not ED) problem ([AHRQ 2025](https://www.ahrq.gov/news/newsletters/e-newsletter/951.html)), and reported command-center results include bed turnover falling from 111 to 49 minutes and 30% fewer patients waiting for beds at Johns Hopkins ([PMC review 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10637563/)).

## 2. Role by role

### Bed manager / patient flow coordinator
- **Day:** 06:30 pulls census and pending admits; 08:00–09:00 runs or joins the bed huddle (IHI's real-time demand capacity: predict unit capacity, predict demand, make a plan, review at day end ([IHI white paper](https://www.ihi.org/library/white-papers/achieving-hospital-wide-patient-flow))); the rest of the day places admits from ED, PACU, direct admits and transfers, chasing discharges and dirty beds by phone. Peak conflict is 11:00–17:00, when admit requests arrive before discharges leave.
- **Decisions:** which bed for which admit (unit, isolation, gender, telemetry); whether to place off-service; who to escalate to for a stalled discharge.
- **On screen:** pending-admit queue with time since bed request; every bed coloured by pipeline state with a timer; expected discharges today per unit; isolation flags.

### Charge nurse (inpatient unit)
- **Day:** shift handoff 07:00/19:00, makes assignments, morning rounds/discharge huddle, answers "can you take a patient?" calls all day, manages staffing ratio against census.
- **Decisions:** which patients go home today and in what order; when to accept an admit (ratio, acuity); when to call EVS/transport.
- **On screen:** own unit only: beds, discharge-ready patients and their blockers (ride, meds, paperwork), nurse-to-patient load, incoming admits assigned to the unit.

### ED charge nurse / lead
- **Day:** monitors waiting room and triage, ambulance arrivals, assigns rooms, pushes admitted boarders upstairs, triggers surge/escalation when boarders cross thresholds.
- **Decisions:** which waiting patient gets the next room; when to open hallway/surge space; when to escalate boarding to the house supervisor; offload ambulance crews.
- **On screen:** waiting-room count and longest wait, ambulances inbound with ETA and offload timers, boarders with hours since admit decision and assigned bed (if any), rooms held by boarders.

### House supervisor (nursing supervisor, usually nights/weekends)
- **Day:** acts as the administrator on duty: walks or calls every unit roughly every 2–4 hours, balances staffing (floats, call-ins), approves transfers in, handles codes and escalations, writes the shift report.
- **Decisions:** move nurses between units; open/close beds; accept or refuse outside transfers; declare surge level.
- **On screen:** whole-house map: occupancy by unit, staff on shift vs. census, open beds that cannot be staffed, ED boarding count and longest boarder.

### EVS supervisor
- **Day:** assigns cleaners by floor; discharge cleans peak in the afternoon (one academic centre saw 80% of dirty beds between 13:00 and 20:00 with 116-minute average turnover against a 60-minute best practice ([Harvard D3 case](https://d3.harvard.edu/platform-mhcdsolutions/submission/improving-bed-turnover-throughput-environmental-services/index.html))).
- **Decisions:** which dirty bed to clean next (priority = a patient is waiting for it); where to send the next free cleaner; when to call in staff.
- **On screen:** dirty beds ranked by "someone is waiting" and age; cleaner positions (RTLS) and current task; requests not yet acknowledged.

### Transport / porter dispatcher
- **Day:** queues and assigns transports (discharge wheelchair, ED to floor, radiology), all by request system plus radio.
- **Decisions:** next job for each porter; which job is urgent (ED boarder to newly clean bed beats a routine imaging trip).
- **On screen:** open jobs with age and priority, porter positions, ED-to-floor moves waiting on a porter.

### COO (buyer)
- **Rhythm:** daily safety/capacity huddle, weekly ops review, board reports.
- **Decisions:** fund staff/beds; set targets (boarding hours, LWBS, discharge timing); approve surge plans.
- **Needs:** a trustworthy trend (boarding hours, LWBS, turnover) and proof of dollars: CHRISTUS Westover Hills reported beds known open 2 h 40 min sooner than manual EHR entry and USD 351k/year from 117 extra bed gains ([Healthcare IT News](https://www.healthcareitnews.com/news/rtls-helps-texas-hospital-save-big-time-and-money-patient-discharge)).

**Data systems that hold it:** ADT (HL7 v2 A01 admit, A02 transfer, A03 discharge, A08 update, bed status in Epic Grand Central or Cerner), EHR orders (discharge order, admit decision, ESI triage), EVS and transport systems (TeleTracking, Epic Rover/EVS module, vendor tools), RTLS (badge/tag location), staffing (Kronos/UKG), and ambulance CAD/GPS.

**Pain points today:** whiteboards and status that lag reality (the 2 h 40 min gap above); bed status changed late or not at all; the phone as the integration layer; command-center tiles that show counts but not *where* or *why*; dashboards that each team owns separately; alert noise that people learn to ignore ([JMIR 2026](https://jmir.org/2026/1/e78676)).

## 3. Ranked feature proposals

Schema key (current test DB): `adt_beds` (bed_id, unit, status free/occupied/cleaning), `encounters` (patient_ref, bed_id, admitted_at, discharged_at), `triage_queue` (arrived_at, status waiting/admitted/left), `unit_census` (capacity, occupied_other), `evs.tasks` (bed_id, status, created_at, done_at), `gps.ambulances` (status, eta_min, dest_unit), `kronos.roster` (role, unit, on_shift), `kronos.rounds` (staff_name, bed_id, started_at), plus planned RTLS locations. "Has it" = yes / partial / no.

**Top 5 to build next are marked ★.**

| # | Feature | Who / how often | On the map | Data (has it?) | Metric moved | Effort | Release |
|---|---|---|---|---|---|---|---|
| 1 ★ | **Bed pipeline timers** | Bed manager, EVS sup., charge RN; constantly | Each bed shows state + time in state: occupied, discharge pending, dirty (waiting EVS), cleaning, clean-unassigned, assigned | adt_beds status + updated_at, evs.tasks created/done (yes); discharge-pending and "assigned" states (no) | Dirty-to-clean minutes; clean-to-occupied minutes | S | 0.2 |
| 2 ★ | **ED boarder strip** | ED charge, bed manager, house sup.; every 15–60 min | ED beds holding admitted patients glow with hours-boarding; line to the target bed if assigned; 2 h / 4 h colour bands matching CMS 4 h threshold | triage_queue status=admitted (partial: no admit-decision time, no patient link); encounters in ER beds (partial) | ED boarding time (decision to departure) | M | 0.2 if admit-decision time added to sim |
| 3 ★ | **"Patient waiting for this bed" priority on dirty beds** | EVS sup., transport; per request | Dirty beds that already have an assigned admit get a priority ring; EVS queue sorted by it | evs.tasks + a bed-request/assignment record (no) | Boarding time; turnover for "needed" beds | M | 0.2 stretch / 0.3 |
| 4 ★ | **Discharge-ready board on the map** | Charge RN, bed manager; huddles 08:00 & 13:00, hourly check | Patients with discharge order shown with a door icon and time since order; blocker tag (ride, meds, transport) | Discharge order time + blocker (no); encounters.discharged_at (yes, only at departure) | Discharge order to departure; % discharged before noon | M | 0.3 |
| 5 ★ | **Arrivals & ambulance offload** | ED charge; continuously | Inbound ambulances moving on approach with ETA; on arrival, offload timer at the bay; 15 / 45 min bands (NHS Handover 45) | gps.ambulances (yes for ETA/status); arrival and handover timestamps (partial: only status) | Ambulance offload time; diversion hours | S | 0.2 |
| 6 | Unit capacity bar per floor | House sup., COO; hourly | Floor badge: occupied / staffed / capacity, colour by threshold | unit_census + adt_beds (yes); staffed beds (no) | Occupancy; off-service placements | S | 0.2 |
| 7 | Waiting-room and LWBS watch | ED charge; every 15 min | Waiting-room zone with count, longest wait, left-without-being-seen in the last 4 h | triage_queue arrived_at/status=left (yes); ESI acuity (no) | LWBS rate; door-to-room (> 60 min) | S | 0.2 |
| 8 | Staff-to-census overlay | House sup., charge RN; every 2–4 h | Unit badge: RNs on shift vs. patients; units below ratio flagged | kronos.roster on_shift + unit (yes); ratio rules (config) | Unstaffed-bed hours; float use | S | 0.2 |
| 9 | Huddle snapshot mode | Bed manager, COO; 1–3x daily | One click freezes "now", shows admits pending, discharges expected, beds dirty, staffing gaps by unit; prints/shares | All above (partial) | Huddle length; predicted vs. actual discharges | M | 0.3 |
| 10 | Timeline replay for bottleneck review | Flow manager, COO; daily/weekly | Scrub yesterday 10:00–18:00 to see where beds sat dirty and boarders waited | CDC history of all tables (yes, via replay) | Supports every metric; root cause | S (exists) | 0.2 |
| 11 | EVS cleaner positions and assignment | EVS sup.; continuously | Cleaner figures walk to assigned dirty bed; idle cleaners highlighted near a dirty bed | RTLS locations (planned); evs.tasks assignee (no) | Dirty-to-clean; response time | M | 0.3 (with RTLS) |
| 12 | Transport job queue on map | Transport dispatcher; continuously | Pending moves drawn as dashed arrows origin to destination with age; porter figures | Transport table (no); RTLS (planned) | Transport response time; boarder departure | M | 0.3 |
| 13 | Isolation and bed attributes | Bed manager; per placement | Icon on beds: isolation, telemetry, bariatric, gender-cohort | Bed attributes (no) | Placement time; blocked-bed hours | S | 0.3 |
| 14 | Stranded / long-stay patients | Charge RN, case mgmt; daily | Beds with LOS ≥ 7 days ringed (SAFER "R") | encounters.admitted_at (yes) | Long-stay count; LOS | S | 0.2 |
| 15 | Rounds visibility | Charge RN; per shift | Bed shows last clinician visit time (rounding) | kronos.rounds (yes) | Rounding compliance; discharge readiness by noon | S | 0.2 |
| 16 | Threshold alerts with owner | Each role; event-driven | Alert names one owner, bed and timer (e.g. "B10 dirty 60 min, EVS"); acknowledge on map | All above | Time-to-acknowledge | M | 0.2 (basic) |
| 17 | Wallboard per role | ED, EVS office, bed office; always on | Fixed camera + role filter, PHI-masked labels | Same data | Shared awareness | S | 0.2 |
| 18 | Surge/escalation level | House sup., COO; event | Hospital status banner (green/amber/red) driven by boarders, occupancy, waiting room | Derived (partial) | Diversion hours; time in surge | S | 0.3 |
| 19 | Inter-facility transfer intake | Transfer centre, house sup.; per request | Pending transfers as cards docking to target units | Transfer requests (no) | Transfer acceptance time; refused transfers | M | Later |
| 20 | Expected-discharge-date heat | Bed manager; huddle | Beds tinted by documented EDD (today / tomorrow) — documented values only, not a model | EDD field (no) | Discharges by noon; next-day capacity | S | 0.3 |
| 21 | Daily metrics digest for COO | COO; daily/weekly | Trend panel: boarding hours, LWBS, turnover, offload, pre-noon discharges, with drill into replay | Derived from history (partial) | All headline metrics | M | 0.3 |
| 22 | PACU/OR holds | Bed manager; afternoon | PACU beds holding inpatients waiting for a floor bed | OR/PACU feed (no) | PACU hold hours; OR delays | M | Later |

**Why these five first.** #1 and #5 use data we already have and fix the "status lags reality" pain on day one. #2 targets the measure CMS will publicly report. #3 is the cheap, specific fix that connects EVS to the ED (cleaning the right bed first), which no single-department dashboard does. #4 is where the beds come from; IHI and NHS SAFER both put discharge timing at the centre of flow.

**Schema gaps to add to the hospital sim (small, high value):** `encounters.admit_decision_at`, `encounters.discharge_order_at`, `encounters.discharge_blocker`, `encounters.expected_discharge_date`; `adt_beds.status` add `dirty` (distinct from `cleaning`) and `assigned`, plus `isolation`; `triage_queue.patient_ref`, `esi`, `roomed_at`; `gps.ambulances.arrived_at`, `handover_at`; `evs.tasks.assigned_to`, `started_at`, `priority`; new `transport.jobs`. All map to standard ADT/EHR fields, so the demo stays honest about what real hospitals expose.

## 4. Pilot recommendation (60–90 days)

**Target metric: bed turnaround for discharge beds, measured as dirty-to-clean (bed marked dirty to EVS done), with clean-to-occupied as a secondary.**

Why this one: it is narrow (one unit set, one department), mostly owned by EVS and the bed office who will use the map daily, measurable entirely from timestamps in ADT and EVS systems, and the evidence suggests large gaps (116 vs. 60 minute benchmark; 111 to 49 minutes after command-center work). It moves boarding indirectly but does not need ED physician workflow change. ED boarding time is the COO's real metric, so report it as an outcome, not the pilot's pass/fail.

How to measure:
- **Baseline:** 8–12 weeks of historical ADT bed-status and EVS task timestamps before go-live, same units. Compute median and 90th percentile dirty-to-clean, split by day/evening shift and weekday/weekend. Also capture "discharge departure to bed marked dirty" (notification lag), which is often the hidden half.
- **After:** same calculation for weeks 3–12 (exclude go-live weeks 1–2).
- **Controls:** compare to non-pilot units over the same weeks to separate seasonal census effects; record census and EVS staffing per shift as covariates.
- **Success:** at least 20% reduction in median and a 90th percentile cut (long tails are what create boarders), with no rise in EVS overtime. Secondary: ED boarding hours for admits to pilot units; % of dirty beds with "patient waiting" cleaned first.
- **Usage check:** wallboard uptime and weekly active users per role; if EVS supervisors are not opening it, the metric change is not ours.

## 5. Risks and things to avoid

- **PHI on wallboards.** Wallboards are in hallways visible to patients and visitors. Default to bed numbers and states only; no names, MRN, diagnosis. Show initials or patient_ref only on authenticated screens; log who views identified data (HIPAA minimum necessary).
- **Alert fatigue.** Alerts must name one owner, one bed and a timer, and be rare. Start with 3–4 thresholds per role, measure acknowledge rate, retire alerts nobody acts on. No sound by default on wallboards.
- **Inventing movement or status.** Never animate a figure without an RTLS or ADT event. Show data age on every badge; if a feed is stale (> 5 min) grey it out rather than look current. Predictions (if ever) must look visibly different from facts.
- **Becoming a second source of truth.** Read-only against ADT/EVS at first; staff must still change bed status in Epic/TeleTracking, or the systems diverge. Write-back is a later, governed feature.
- **Metric gaming.** Discharge-before-noon targets have mixed evidence: a 189,781-patient Canadian study found no association with ED or hospital LOS ([The Hospitalist editorial](https://community.the-hospitalist.org/content/discharge-noon-toward-better-understanding-benefits-and-costs)). Show discharge order-to-departure time, not just a noon count, so teams do not delay discharges to hit a clock.
- **Surveillance perception of RTLS.** Staff location is sensitive for unions and staff. Show staff as role figures for operations, never for time-and-attendance or discipline; agree this in writing with the hospital.
- **Command-center evidence is thin.** The 2023 review notes the literature is sparse; set modest claims and publish the pilot method up front.
- **Integration effort.** Each hospital's ADT status codes differ; budget mapping time per site and keep the one-click setup honest about what it can infer.

## 6. Sources

- AHRQ, Report identifies strategies to reduce ED boarding (Mar 2025): https://www.ahrq.gov/news/newsletters/e-newsletter/951.html
- eCQI, CMS1244 Emergency Care Access & Timeliness measure (HOQR, 2027 period): https://ecqi.healthit.gov/sites/default/files/ecqm/measures/CMS1244-v1.2.000-QDM.html
- IHI, Achieving Hospital-wide Patient Flow (white paper): https://www.ihi.org/library/white-papers/achieving-hospital-wide-patient-flow (PDF: https://qi.elft.nhs.uk/wp-content/uploads/2018/01/IHIAchievingHospitalWidePatientFlowWhitePaper.pdf)
- NHS ECIP, SAFER patient flow bundle: https://fabnhsstuff.net/fab-stuff/the-safer-patient-flow-bundle
- Liverpool University Hospitals NHS FT, Handover 45: https://www.uhliverpool.nhs.uk/luhft-staff/hospital-to-home/handover-45
- Healthcare command centers narrative review (2023, PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC10637563/
- Harvard D3, Improving bed turnover/throughput, Environmental Services: https://d3.harvard.edu/platform-mhcdsolutions/submission/improving-bed-turnover-throughput-environmental-services/index.html
- Healthcare IT News, RTLS helps Texas hospital on patient discharge (CHRISTUS): https://www.healthcareitnews.com/news/rtls-helps-texas-hospital-save-big-time-and-money-patient-discharge
- The Hospitalist, Discharge by noon: benefits and costs: https://community.the-hospitalist.org/content/discharge-noon-toward-better-understanding-benefits-and-costs
- Becker's, State LWBS rates (CMS 2024 data, national 2%): https://www.beckershospitalreview.com/rankings-and-ratings/states-with-highest-lowest-ed-left-without-being-seen-rates-3/
- JMIR, Experiences of alert fatigue in hospitals (2026): https://jmir.org/2026/1/e78676

Note: the role day-in-the-life timings (huddle times, supervisor rounding cadence) are typical practice descriptions, not taken from a single source; validate with the pilot hospital's flow team.
