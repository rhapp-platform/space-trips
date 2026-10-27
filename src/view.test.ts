import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { app } from "./index";
import { people } from "./people";
import { access, clock, tripDates, tripView, type Looker } from "./view";
import type { Env, MemberRow, TripRow } from "./types";
import { SEG, TRIP, fakeMemberAccounts, fakeTrips } from "./testing";

const SECRET = "trips-view-test";
const ORIGIN = "https://renner.rhapp.work";

const OUT: Looker = { uid: null, role: null, signedIn: false };
const MEMBER: Looker = { uid: "su_gone", role: "member", signedIn: true };
const TRAVELER: Looker = { uid: "su_lee", role: "member", signedIn: true };
const STAFF: Looker = { uid: "su_boss", role: "staff", signedIn: true };
const VIEWERS = { out: OUT, member: MEMBER, traveler: TRAVELER, staff: STAFF };

/** A trip holding every private thing: a seat, a room, a confirmation, named travelers. */
function fixture(trip: Partial<TripRow> = {}, options: { membersDown?: boolean } = {}) {
  const store = fakeTrips();
  Object.assign(store.trips.get(TRIP)!, { description: "Fourteen days.\n\nVisits may change.", ...trip });
  Object.assign(store.segments.get(SEG)!, {
    start_at: "2026-11-01T08:30", end_at: "2026-11-01T11:10", confirmation_ref: "XYZ123",
    details: JSON.stringify({ airline: "United", seat: "14C", start_tz: "America/Chicago", end_tz: "America/Denver" }),
  });
  const now = "2026-10-19T12:00:00Z";
  store.segments.set("tseg_hotel", { id: "tseg_hotel", trip_id: TRIP, type: "hotel", label: "Hotel Monaco", start_at: null,
    end_at: null, location: "Denver", confirmation_ref: "H-77", notes: "Late check-in.", position: 1, created_at: now,
    details: JSON.stringify({ room: "512", phone: "555-0100" }), image_tag: "hotel", image_revision: null });
  store.segments.set("tseg_day3", { id: "tseg_day3", trip_id: TRIP, type: "activity", label: "Museum", start_at: "2026-11-03T10:00",
    end_at: null, location: "Art museum", confirmation_ref: null, notes: null, position: 2, created_at: now });
  store.members.push({ trip_id: TRIP, member_id: "su_lee", role: "traveler", added_at: now } as MemberRow);
  const members = fakeMemberAccounts({ down: options.membersDown });
  const env = {
    ENVIRONMENT: "test", WORKER_VERSION: "test", AUTH_SESSION_SECRET: SECRET,
    RHAP_MASTER_SECRET: "cmhhcHBzb2R5LXRlc3Qtb25seS1tYXN0ZXIta2V5ISE=",
    APPS: { get: async () => ({ displayName: "Renner", route: { instance: "enam1" } }) },
    TRIPS_WORKER: store.service, MEMBER_ACCOUNTS: members.binding,
  } as unknown as Env;
  async function page(viewer: Looker) {
    const headers: Record<string, string> = {};
    if (viewer.signedIn) {
      headers.Cookie = `rhauth-role=${await sign({ sub: viewer.uid, uid: viewer.uid, gn: "renner", instance: "enam1", role: viewer.role,
        source: "d1", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;
    }
    return app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`, { headers }), env);
  }
  const deps = {
    call: (op: string, args: unknown[]) => store.service.trips("renner", op, args) as any,
    people: people(env, "renner"), gn: "renner", environment: "test",
  };
  return { store, env, page, deps };
}

describe("access", () => {
  const members: MemberRow[] = [{ trip_id: TRIP, member_id: "su_lee", role: "traveler", added_at: "" }];
  const trip = (t: Partial<TripRow>) => ({ ...fakeTrips().trips.get(TRIP)!, ...t }) as TripRow;
  const who = (t: Partial<TripRow>, options = {}) =>
    Object.fromEntries(Object.entries(VIEWERS).map(([k, v]) => [k, access(trip(t), members, v, options)?.insider ?? "no"]));

  test("public: everyone; insiders are the travelers and staff", () => {
    expect(who({ visibility: "public" })).toEqual({ out: false, member: false, traveler: true, staff: true });
  });
  test("members: signed in only", () => {
    expect(who({ visibility: "members" })).toEqual({ out: "no", member: false, traveler: true, staff: true });
  });
  test("private: the people on it, not staff who aren't", () => {
    expect(who({ visibility: "private" })).toEqual({ out: "no", member: "no", traveler: true, staff: "no" });
  });
  test("drafts: staff only, even for a traveler on a public trip", () => {
    expect(who({ visibility: "public", status: "draft" })).toEqual({ out: "no", member: "no", traveler: "no", staff: true });
  });
  test("archived: shown on the trip page, hidden from everyone in a trip app", () => {
    expect(who({ visibility: "public", status: "archived" })).toEqual({ out: false, member: false, traveler: true, staff: true });
    expect(who({ visibility: "public", status: "archived" }, { hideArchived: true })).toEqual({ out: "no", member: "no", traveler: "no", staff: "no" });
  });
  test("an unknown status or visibility is refused", () => {
    expect(who({ visibility: "everyone" as any })).toEqual({ out: "no", member: "no", traveler: "no", staff: "no" });
    expect(who({ status: "paused" as any })).toEqual({ out: "no", member: "no", traveler: "no", staff: "no" });
  });
});

describe("the trip page and tripView agree", () => {
  const SECRETS = ["14C", "512", "XYZ123", "H-77", "Dana Reyes"];
  for (const visibility of ["public", "members", "private"] as const) {
    for (const status of ["active", "draft", "archived"] as const) {
      test(`${visibility} ${status}`, async () => {
        const f = fixture({ visibility, status });
        for (const [name, viewer] of Object.entries(VIEWERS)) {
          const r = await f.page(viewer);
          const html = await r.text();
          const v = await tripView(f.deps, viewer, TRIP);
          if (!v.ok) throw new Error(v.message);
          expect([name, r.status === 200]).toEqual([name, v.value !== null]);
          if (!v.value) { expect(html).not.toContain("Hotel Monaco"); continue; }
          const json = JSON.stringify(v.value);
          for (const secret of SECRETS) {
            // A secret shows in the view exactly when it shows on the page.
            expect([name, secret, json.includes(secret)]).toEqual([name, secret, html.includes(secret)]);
          }
          expect(json.includes("14C")).toBe(v.value.insider);
          // The comparison above means nothing unless the page does show them to insiders.
          if (v.value.insider) for (const secret of SECRETS) expect([name, secret, html.includes(secret)]).toEqual([name, secret, true]);
          expect(json).not.toContain("su_");
        }
      });
    }
  }
});

describe("tripView", () => {
  test("days, times in each zone, the unscheduled list and the travelers", async () => {
    const f = fixture({ visibility: "members", start_date: "2026-11-01", end_date: "2026-11-05" });
    const r = await tripView(f.deps, TRAVELER, TRIP);
    if (!r.ok || !r.value) throw new Error("expected a trip");
    const v = r.value;
    expect(v.dates).toBe("November 1 – November 5, 2026 · 5 days");
    expect(v.description).toEqual(["Fourteen days.", "Visits may change."]);
    expect(v.days.map((d) => d.heading)).toEqual(["Day 1 · Sunday, November 1", "Day 3 · Tuesday, November 3"]);
    const flight = v.days[0]!.items[0]!;
    expect(flight).toMatchObject({ kind: "flight", icon: "mdi:airplane", confirmation: "XYZ123" });
    // Daylight saving ended at 2 AM that morning.
    expect(flight.when).toBe("Departs 8:30 AM (Chicago, GMT-6) · Arrives 11:10 AM (Denver, GMT-7)");
    expect(flight.details).toEqual([["Airline", "United"], ["Seat", "14C"]]);
    expect(v.unscheduled.map((i) => i.name)).toEqual(["Hotel Monaco"]);
    expect(v.unscheduled[0]!.place).toEqual({ label: "Address", value: "Denver" });
    expect(v.travelers).toEqual({ count: 2, people: [{ name: "Dana Reyes", role: "Organizer" }, { name: "lee", role: "Traveler" }] });
  });

  test("a day without a time sits on its day; another day's end says which", async () => {
    const f = fixture({ visibility: "members", start_date: "2026-11-01" });
    Object.assign(f.store.segments.get("tseg_hotel")!, { start_at: "2026-11-01", end_at: "2026-11-03" });
    const r = await tripView(f.deps, TRAVELER, TRIP);
    if (!r.ok || !r.value) throw new Error("expected a trip");
    expect(r.value.unscheduled).toEqual([]);
    const hotel = r.value.days[0]!.items.find((i) => i.kind === "hotel")!;
    expect(hotel.when).toBe("Check-out Nov 3");
    Object.assign(f.store.segments.get("tseg_hotel")!, { end_at: null });
    const s = await tripView(f.deps, TRAVELER, TRIP);
    expect(s.ok && s.value?.days[0]!.items.find((i) => i.kind === "hotel")!.when).toBeNull();
  });

  test("an outsider gets no seat, room, confirmation or names", async () => {
    const f = fixture({ visibility: "public" });
    const r = await tripView(f.deps, OUT, TRIP);
    if (!r.ok || !r.value) throw new Error("expected a trip");
    expect(r.value.insider).toBe(false);
    expect(r.value.days[0]!.items[0]!.details).toEqual([["Airline", "United"]]);
    expect(r.value.days[0]!.items[0]!.confirmation).toBeNull();
    expect(r.value.unscheduled[0]!.details).toEqual([["Phone", "555-0100"]]);
    expect(r.value.travelers).toEqual({ count: 2, people: null });
  });

  test("no cover → the first item image in itinerary order", async () => {
    const f = fixture({ visibility: "public" });
    const r = await tripView(f.deps, OUT, TRIP);
    expect(r.ok && r.value?.cover).toContain("hotel");
    const g = fixture({ visibility: "public", cover_tag: "sicily", cover_revision: null });
    const s = await tripView(g.deps, OUT, TRIP);
    expect(s.ok && s.value?.cover).toContain("sicily");
  });

  test("missing, refused and outage", async () => {
    const f = fixture({ visibility: "private" });
    expect(await tripView(f.deps, OUT, TRIP)).toEqual({ ok: true, value: null });
    expect(await tripView(f.deps, TRAVELER, `trp_${"Z".repeat(26)}`)).toEqual({ ok: true, value: null });
    const down = { ...f.deps, call: async () => ({ ok: false as const, status: 503, message: "down" }) };
    expect((await tripView(down, TRAVELER, TRIP)).ok).toBe(false);
  });

  test("a directory outage names nobody by ID", async () => {
    const f = fixture({ visibility: "members" }, { membersDown: true });
    const r = await tripView(f.deps, TRAVELER, TRIP);
    if (!r.ok || !r.value) throw new Error("expected a trip");
    expect(r.value.travelers.people).toEqual([{ name: "A member", role: "Organizer" }, { name: "A member", role: "Traveler" }]);
  });
});

test("dates and clocks", () => {
  expect(tripDates("2026-10-19", "2026-11-01")).toBe("October 19 – November 1, 2026 · 14 days");
  expect(tripDates("2026-12-28", "2027-01-03")).toBe("December 28, 2026 – January 3, 2027 · 7 days");
  expect(tripDates("2026-10-19", "2026-10-19")).toBe("October 19, 2026 · 1 day");
  expect(tripDates("2026-10-19", null)).toBe("From October 19, 2026");
  expect(tripDates(null, null)).toBeNull();
  expect([clock("2026-10-19T00:05"), clock("2026-10-19T12:00"), clock("2026-10-19T23:59")]).toEqual(["12:05 AM", "12:00 PM", "11:59 PM"]);
});
