import { STATE_KEYS, readStateColors, stateKey, stateVar } from "./stateColors";

describe("state color mapping", () => {
  test.each([
    ["free", "free"], ["available", "free"], ["Available", "free"],
    ["occupied", "in-use"], ["in_use", "in-use"], ["In Use", "in-use"], ["in-use", "in-use"], ["BUSY", "in-use"],
    ["cleaning", "cleaning"], ["maintenance", "cleaning"],
    ["alert", "alert"], ["error", "alert"], ["blocked", "alert"],
    ["discharged", "unknown"], ["", "unknown"],
  ])("%s → %s", (raw, key) => expect(stateKey(raw)).toBe(key));

  test("non-strings are unknown", () => {
    expect(stateKey(undefined)).toBe("unknown");
    expect(stateKey(3)).toBe("unknown");
    expect(stateKey(null)).toBe("unknown");
  });

  test("colors are read from --state-* CSS variables at runtime", () => {
    const el = document.documentElement;
    el.style.setProperty("--state-free", " #010203 ");
    el.style.setProperty("--state-alert", "#aabbcc");
    const c = readStateColors(el);
    expect(c.free).toBe("#010203");
    expect(c.alert).toBe("#aabbcc");
    expect(Object.keys(c)).toEqual([...STATE_KEYS]);
    expect(stateVar("in-use")).toBe("--state-in-use");
    el.style.setProperty("--state-free", "#0f0f0f"); // theme switch
    expect(readStateColors(el).free).toBe("#0f0f0f");
  });
});
