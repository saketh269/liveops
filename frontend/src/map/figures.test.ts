import { figureKey, figureModel, isPerson, isVehicle } from "./figures";

test("kind picks the model, role refines people (case-insensitive)", () => {
  expect(figureModel("Bed")).toBe("bed");
  expect(figureModel("PATIENT")).toBe("patient");
  expect(figureModel("staff", "Nurse")).toBe("nurse");
  expect(figureModel("person", "physician")).toBe("doctor");
  expect(figureModel("staff", "housekeeping")).toBe("cleaner");
  expect(figureModel("staff")).toBe("person");
  expect(figureModel("doctor")).toBe("doctor");
  expect(figureModel(undefined, "nurse")).toBe("nurse");
  expect(figureModel("person", "patient")).toBe("patient");
  expect(figureModel("ambulance")).toBe("ambulance");
  expect(figureModel("vehicle")).toBe("vehicle");
  expect(figureModel("equipment", "nurse")).toBe("equipment");
  expect(figureModel("bed", "nurse")).toBe("bed");
});

test("unknown kinds fall back to the box figure", () => {
  expect(figureModel("pump")).toBe("other");
  expect(figureModel(undefined)).toBe("other");
  expect(figureKey({ site_id: "s", asset_id: "1", updated_ts: 0, _sources: {}, kind: "Pump" })).toBe("other");
  expect(figureKey({ site_id: "s", asset_id: "1", updated_ts: 0, _sources: {} })).toBe("other");
  expect(isVehicle("ambulance") && !isVehicle("nurse")).toBe(true);
  expect(isPerson("cleaner") && !isPerson("bed")).toBe(true);
});
