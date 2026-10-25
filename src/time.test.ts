import { describe, expect, test } from "bun:test";
import { canonicalZone, endsBeforeStart, instant, when, zoneLabel, zoneNames } from "./time";

describe("item times and zones", () => {
  test("a wall-clock time in a zone is the right moment, on both sides of a DST change", () => {
    expect(new Date(instant("2026-07-01T14:00", "Europe/Rome")).toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(new Date(instant("2026-12-01T14:00", "Europe/Rome")).toISOString()).toBe("2026-12-01T13:00:00.000Z");
    // The night US clocks go back (2026-11-01): 08:30 is after the change.
    expect(new Date(instant("2026-11-01T08:30", "America/Chicago")).toISOString()).toBe("2026-11-01T14:30:00.000Z");
    expect(new Date(instant("2026-03-08T12:00", "America/New_York")).toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  test("labels name the place and that date's offset", () => {
    expect(zoneLabel("2026-07-01T14:00", "Europe/Rome")).toBe("Rome, GMT+2");
    expect(zoneLabel("2026-12-01T14:00", "Europe/Rome")).toBe("Rome, GMT+1");
    expect(zoneLabel("2026-07-01T14:00", "America/New_York")).toBe("New York, GMT-4");
    expect(when("2026-07-01T14:00", "Europe/Rome")).toBe("2026-07-01 14:00 (Rome, GMT+2)");
    expect(when("2026-07-01T14:00")).toBe("2026-07-01 14:00");
    expect(when(null, "Europe/Rome")).toBe("");
  });

  test("zone names are checked and made canonical", () => {
    expect(canonicalZone(" europe/rome ")).toBe("Europe/Rome");
    expect(canonicalZone("Rome")).toBeNull();
    expect(canonicalZone("")).toBeNull();
    expect(zoneNames()).toContain("Europe/Rome");
  });

  test("a westbound flight lands at an earlier clock time without ending before it starts", () => {
    expect(endsBeforeStart("2026-07-01T14:00", "Europe/Rome", "2026-07-01T17:00", "America/New_York")).toBe(false);
    expect(endsBeforeStart("2026-07-01T14:00", "Europe/Rome", "2026-07-01T07:00", "America/New_York")).toBe(true);
    expect(endsBeforeStart("2026-07-01T21:00", "Asia/Tokyo", "2026-07-01T09:00", "Pacific/Honolulu")).toBe(false);
    // One zone given: the other end is taken to be in it. None: wall clocks, as before.
    expect(endsBeforeStart("2026-07-01T14:00", "Europe/Rome", "2026-07-01T13:00", null)).toBe(true);
    expect(endsBeforeStart("2026-07-01T14:00", null, "2026-07-01T13:00", null)).toBe(true);
  });
});
