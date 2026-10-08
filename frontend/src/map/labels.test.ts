import type { Asset, SiteLayout } from "../api/types";
import {
  attachedSections, detailOnly, durWords, eventText, fieldLabel, humanizeToken, inSentence, isRawToken, looksTransient,
  ownStatus, resetOwnStatus, shortRoomLabel, shortSourceName, splitTransient, statusText, valueText, whoName, zoneLabel,
} from "./labels";

const NOW = 1_800_000_000;
const iso = (minAgo: number) => new Date((NOW - minAgo * 60) * 1000).toISOString();
const rec = (over: Partial<Asset>): Asset => ({ site_id: "hs", asset_id: "X", updated_ts: NOW, _sources: {}, ...over }) as Asset;
const layout: SiteLayout = {
  zones: [
    { id: "wait", name: "ED Waiting Room", kind: "waiting", polygon: [] },
    { id: "ED", name: "Emergency", kind: "unit", polygon: [] },
    { id: "fleet-at", name: "at_hospital_offloading", kind: "bay", polygon: [] },
  ],
};

describe("humanizer", () => {
  test("machine tokens read as words; real names stay as they are", () => {
    expect(humanizeToken("waiting_for_provider")).toBe("Waiting for provider");
    expect(humanizeToken("at_hospital_offloading")).toBe("At hospital · offloading");
    expect(humanizeToken("AT_HOSPITAL_OFFLOADING")).toBe("At hospital · offloading");
    expect(humanizeToken("returning")).toBe("Returning");
    expect(humanizeToken("en_route_to_scene")).toBe("En route to scene");
    expect(humanizeToken("ED_BOARDER")).toBe("ED boarder");
    for (const name of ["ED-02", "3W-305A", "Radiology – MRI", "ED Waiting Room", "L&D-512"]) {
      expect(isRawToken(name)).toBe(false);
      expect(zoneLabel(name)).toBe(name);
    }
    expect(inSentence("waiting_for_provider")).toBe("waiting for provider");
    expect(inSentence("ED_BOARDER")).toBe("ED boarder");
  });

  test("field names in plain words", () => {
    expect(["esi_acuity", "bed_id", "unit_id", "encounter_class", "expected_discharge", "attributes.assigned_to", "created_at"].map(fieldLabel))
      .toEqual(["Acuity (ESI)", "Bed", "Unit", "Visit type", "Expected discharge", "Assigned to", "Requested"]);
  });

  test("values: codes in words, units by name, times as local time and age, booleans, empties hidden", () => {
    const ctx = { now: NOW, layout };
    expect(valueText("status", "waiting_for_provider", ctx)).toBe("Waiting for provider");
    expect(valueText("encounter_class", "emergency", ctx)).toBe("Emergency");
    expect(valueText("unit_id", "ED", ctx)).toBe("Emergency");
    expect(valueText("unit_id", "4E", ctx)).toBe("4E");
    expect(valueText("isolation", false, ctx)).toBe("No");
    expect(valueText("expected_discharge", null, ctx)).toBeNull();
    expect(valueText("bed_id", "ED-02", ctx)).toBe("ED-02");
    expect(valueText("admit_time", iso(12), ctx)).toMatch(/^\d{2}:\d{2} · 12 min ago$/);
    expect(valueText("zone", "wait", ctx)).toBe("ED Waiting Room");
  });

  test("durations read as words", () => {
    expect([30, 2820, 11100, 7200, 200000].map(durWords)).toEqual(["under 1 min", "47 min", "3 h 5 min", "2 h", "2 d 7 h"]);
  });

  test("two-bed rooms have a short form; names without one keep theirs", () => {
    expect(shortRoomLabel("3W-305A")).toBe("305A");
    expect(shortRoomLabel("L&D-512")).toBe("512");
    expect(shortRoomLabel("Lobby")).toBeNull();
  });

  test("staff are named with their role", () => {
    expect(whoName(rec({ label: "Daniel Wagner", kind: "staff", role: "Registered Nurse" }))).toBe("Nurse Daniel Wagner");
    expect(whoName(rec({ label: "Ana Ruiz", kind: "staff", role: "EVS Technician" }))).toBe("EVS technician Ana Ruiz");
    expect(whoName(rec({ label: "P7401887", kind: "patient" }))).toBe("P7401887");
  });
});

describe("the record's own status", () => {
  beforeEach(() => resetOwnStatus());
  const patient = (status: string, src: string, state = "alert") => rec({
    asset_id: "P7401887", kind: "patient", state, attributes: { status },
    _sources: { state: "patients", zone: "patients", "attributes.status": src },
  });

  test("comes from the source that maps the state, never from an attached one", () => {
    expect(ownStatus(patient("waiting_for_provider", "patients"))).toBe("waiting_for_provider");
    expect(statusText(patient("in_progress", "transport"))).toBe("Waiting for provider"); // remembered
    expect(statusText(patient("in_progress", "transport", "in_use"))).toBe("In use"); // state changed: memory no longer applies
  });

  test("falls back to the mapped state, and works without source info", () => {
    expect(statusText(patient("in_progress", "transport"))).toBe("Alert");
    expect(statusText(rec({ state: "cleaning", attributes: { status: "dirty" } }))).toBe("Dirty");
    expect(statusText(rec({}))).toBe("No status");
  });
});

describe("attached sources", () => {
  test("get their own short sections", () => {
    const bed = rec({
      asset_id: "ED-11", kind: "bed", state: "cleaning", zone: "ED-11",
      attributes: { status: "in_progress", assigned_to: "Marco", started_at: iso(12), priority: "stat", unit_id: "ED" },
      _sources: { state: "beds", zone: "beds", "attributes.unit_id": "beds", "attributes.status": "clean", "attributes.assigned_to": "clean", "attributes.started_at": "clean", "attributes.priority": "clean" },
    });
    const [s] = attachedSections(bed, { beds: "Riverside – Beds (live)", clean: "Riverside – Cleaning tasks" }, { now: NOW, layout });
    expect(s.title).toBe("Cleaning");
    expect(s.summary).toBe("in progress · Marco · 12 min");
    expect(s.facts.map((f) => `${f.label}: ${f.value}`)).toEqual(["Priority: Stat"]);

    const p = rec({
      asset_id: "P1", kind: "patient", state: "in_use",
      attributes: { status: "assigned", to: "Radiology – MRI", mode: "wheelchair" },
      _sources: { state: "pat", "attributes.status": "tr", "attributes.to": "tr", "attributes.mode": "tr" },
    });
    const [t] = attachedSections(p, { tr: "Riverside – Transport requests" }, { now: NOW, layout });
    expect(`${t.title}: ${t.summary}`).toBe("Transport to Radiology – MRI: assigned · wheelchair");
    expect(shortSourceName("Housekeeping")).toBe("Housekeeping");
  });
});

describe("event text", () => {
  const ctx = { layout, sourceNames: { tr: "Riverside – Transport requests" } };
  const patient = rec({ asset_id: "P7401887", kind: "patient", state: "alert", _sources: { state: "pat", zone: "pat" } });

  test("zone and status together are one sentence; no field names or arrows", () => {
    const text = eventText({ source: "pat", changes: { zone: ["wait", "ED-02"], "attributes.status": ["waiting_room", "waiting_for_provider"] } }, patient, ctx);
    expect(text).toBe("moved from ED Waiting Room to ED-02 · now waiting for provider");
  });

  test("status changes, fleet bays, staff moves and removals", () => {
    const bed = rec({ asset_id: "ED-11", kind: "bed", _sources: { state: "beds" } });
    expect(eventText({ source: "beds", changes: { state: ["in_use", "cleaning"], "attributes.status": ["occupied", "dirty"] } }, bed, ctx)).toBe("is dirty (was occupied)");
    const amb = rec({ asset_id: "M1", label: "Medic 1", kind: "ambulance", _sources: { state: "amb", zone: "amb" } });
    expect(eventText({ source: "amb", changes: { zone: ["en_route_to_scene", "transporting_to_hospital"], "attributes.status": ["en_route_to_scene", "transporting_to_hospital"] } }, amb, ctx))
      .toBe("is transporting to hospital");
    const nurse = rec({ asset_id: "S1", label: "Daniel Wagner", kind: "staff", role: "Registered Nurse", _sources: { zone: "staff" } });
    expect(eventText({ source: "staff", changes: { zone: ["3W-NS", "3W-305A"] } }, nurse, ctx)).toBe("went to 3W-305A");
    expect(eventText({ removed: true, changes: { "attributes.status": ["discharge_ordered", null] } }, patient, ctx)).toBe("left the map (discharged)");
    expect(eventText({ removed: true, changes: { state: ["free", null] } }, bed, ctx)).toBe("left the map");
  });

  test("an attached source's change is named by the source, and pings say nothing", () => {
    expect(eventText({ source: "tr", changes: { "attributes.status": ["waiting_for_provider", "assigned"] } }, patient, ctx)).toBe("transport is now assigned");
    expect(eventText({ source: "tr", changes: { "attributes.status": ["assigned", null], "attributes.to": ["Radiology – MRI", null] } }, patient, ctx)).toBe("transport finished");
    expect(eventText({ source: "pat", changes: { "attributes.badge_last_seen": ["a", "b"] } }, patient, ctx)).toBeNull();
    // The transport finished and the patient's own status shows again in the shared field.
    const back = { ...patient, _sources: { ...patient._sources, "attributes.status": "pat" } };
    expect(eventText({ source: "tr", changes: { "attributes.status": ["assigned", "waiting_for_provider"], "attributes.to": ["Dialysis", null] } }, back, ctx)).toBe("transport finished");
  });

  test("an old status an attached source may have written is left out; a place is not repeated as a status", () => {
    resetOwnStatus();
    const bed = rec({ asset_id: "ED-16", kind: "bed", attributes: { status: "queued" }, _sources: { state: "beds", "attributes.status": "clean" } });
    ownStatus(bed); // seen with the cleaning task's status
    expect(eventText({ source: "beds", changes: { "attributes.status": ["queued", "dirty"] } }, bed, ctx)).toBe("is now dirty");
    expect(eventText({ source: "pat", changes: { zone: [null, "wait"], "attributes.status": [null, "waiting_room"] } }, patient, ctx)).toBe("arrived in ED Waiting Room");
  });
});

describe("transient locations", () => {
  test("movement-like values are transient; places are not", () => {
    for (const v of ["En route ED-07 → 4E-405A", "ED-07 -> 4E", "In transit", "Discharged", "en_route"]) expect(looksTransient(v)).toBe(true);
    for (const v of ["Radiology – MRI", "ED Waiting Room", "Transport Hub B1", "Endoscopy"]) expect(looksTransient(v)).toBe(false);
  });

  test("a value held by one record for under two minutes is a passage; held longer or by several it is a place", () => {
    const missing = new Map([["En route ED-07 → 4E-405A", 3], ["Cath Lab", 1], ["Endoscopy", 1], ["Dialysis", 2]]);
    const seen = new Map([["Cath Lab", NOW - 30], ["Endoscopy", NOW - 300], ["Dialysis", NOW - 10]]);
    const { places, transient } = splitTransient(missing, seen, NOW);
    expect([...places.keys()]).toEqual(["Endoscopy", "Dialysis"]);
    expect([...transient.keys()]).toEqual(["En route ED-07 → 4E-405A", "Cath Lab"]);
  });

  test("records that only carry another record's details are not placed on their own", () => {
    expect(detailOnly(rec({ attributes: { status: "requested" }, _sources: { "attributes.status": "tr" } }))).toBe(true);
    expect(detailOnly(rec({ state: "free", _sources: { state: "beds" } }))).toBe(false);
    expect(detailOnly(rec({}))).toBe(false);
  });
});
