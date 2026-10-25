import { describe, expect, test } from "bun:test";
import { canonicalZone, endsBeforeStart, instant, outsideTrip, when, zoneLabel, zoneNames } from "./time";

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

describe("items outside the trip's dates", () => {
  const trip = { start_date: "2026-10-18", end_date: "2026-11-01" };
  const item = (start_at: string | null, end_at: string | null = null) => ({ start_at, end_at });

  test("inside the dates, including the first and last day, says nothing", () => {
    expect(outsideTrip(trip, item("2026-10-18T06:00", "2026-11-01T23:30"))).toBeNull();
    expect(outsideTrip(trip, item("2026-10-20T15:00"))).toBeNull();
    expect(outsideTrip(trip, item(null, "2026-10-25T12:45"))).toBeNull();
  });

  test("an item starting before the trip, or ending after it, is pointed out", () => {
    expect(outsideTrip(trip, item("2026-10-14T15:44", "2026-10-25T12:45"))).toBe(
      "This is before the trip starts on 2026-10-18. Check the date, or change the trip's dates.",
    );
    expect(outsideTrip(trip, item("2026-10-30T15:00", "2026-11-02T11:00"))).toContain("after the trip ends on 2026-11-01");
    expect(outsideTrip(trip, item(null, "2026-10-17T09:00"))).toContain("before the trip starts");
  });

  test("no item time, or no trip dates, says nothing", () => {
    expect(outsideTrip(trip, item(null))).toBeNull();
    expect(outsideTrip({ start_date: null, end_date: null }, item("2020-01-01T00:00"))).toBeNull();
    expect(outsideTrip({ start_date: "2026-10-18", end_date: null }, item("2027-01-01T00:00"))).toBeNull();
  });
});
