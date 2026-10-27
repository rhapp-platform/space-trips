import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { app } from "./index";
import { IMAGE_FIELD_PATH } from "./admin";
import { IMAGE_FIELD_JS } from "../../home/src/image-field";
import type { Env } from "./types";
import { OTHER, OTHER_SEG, ROSTER, SEG, TRIP, fakeMemberAccounts, fakeTrips } from "./testing";

const SECRET = "trips-admin-test";
const ORIGIN = "https://renner.rhapp.work";
const BASE = `/trips/admin/${TRIP}`;

function fixture(options: Parameters<typeof fakeTrips>[0] & { members?: ReturnType<typeof fakeMemberAccounts> } = {}) {
  const store = fakeTrips(options);
  const env = {
    ENVIRONMENT: "test",
    WORKER_VERSION: "test",
    AUTH_SESSION_SECRET: SECRET,
    RHAP_MASTER_SECRET: "cmhhcHBzb2R5LXRlc3Qtb25seS1tYXN0ZXIta2V5ISE=",
    APPS: { get: async () => ({ displayName: "Renner", route: { instance: "enam1" } }) },
    TRIPS_WORKER: store.service,
    ...(options.members ? { MEMBER_ACCOUNTS: options.members.binding } : {}),
  } as unknown as Env;
  async function cookie(claims: Record<string, unknown>) {
    return `rhauth-role=${await sign({ sub: "dana", uid: "su_dana", gn: "renner", instance: "enam1", role: "staff",
      source: "d1", exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, SECRET)}`;
  }
  async function request(path: string, init: RequestInit = {}, claims: Record<string, unknown> = {}) {
    return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { Cookie: await cookie(claims), ...init.headers } }), env);
  }
  function post(path: string, fields: Record<string, string>, headers: Record<string, string> = { Origin: ORIGIN }) {
    return request(path, { method: "POST", body: new URLSearchParams(fields), headers });
  }
  const writes = () => store.calls.filter((c) => !["list", "get"].includes(c.op));
  return { ...store, env, request, post, writes };
}

const TRIP_FORM = { title: "Fall retreat", description: "", start_date: "2026-11-10", end_date: "2026-11-12", status: "draft", visibility: "members" };
const SEG_FORM = { type: "hotel", label: "Hotel Monaco", start_at: "2026-11-01T15:00", end_at: "2026-11-03T11:00", location: "Denver", confirmation_ref: "", notes: "" };

describe("Trips admin access", () => {
  test("signed out redirects, members are denied, nothing reaches the store", async () => {
    const f = fixture();
    const anon = await app.fetch(new Request(`${ORIGIN}${BASE}`), f.env);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toBe(`/login?return=${encodeURIComponent(BASE)}`);
    expect((await f.request(BASE, {}, { role: "member" })).status).toBe(403);
    expect((await f.request(`${BASE}/delete`, { method: "POST", headers: { Origin: ORIGIN } }, { role: "member" })).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  test("missing or foreign Origin never writes", async () => {
    const f = fixture();
    for (const headers of [{}, { Origin: "https://other.rhapp.work" }] as Record<string, string>[]) {
      expect((await f.post("/trips/admin/new", TRIP_FORM, headers)).status).toBe(403);
      expect((await f.post(`${BASE}/delete`, {}, headers)).status).toBe(403);
    }
    expect(f.calls).toHaveLength(0);
  });

  test("every admin response is private and not indexed", async () => {
    const f = fixture();
    for (const r of [await f.request("/trips/admin"), await f.request("/trips/admin/nope"), await f.post("/trips/admin/new", TRIP_FORM)]) {
      expect(r.headers.get("Cache-Control")).toBe("private, no-store");
      expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
    }
  });
});

test("the management bar names Trips and links to the public list", async () => {
  const html = await (await fixture().request("/trips/admin")).text();
  expect(html).toMatch(/<li><a href="\/manage">[^<]+<\/a><\/li>/);
  expect(html).toContain('<a class="mg-view" href="/trips">');
});

describe("Trips", () => {
  test("create posts to the store as the viewer and redirects to the new trip", async () => {
    const f = fixture();
    const r = await f.post("/trips/admin/new", TRIP_FORM);
    expect(r.status).toBe(303);
    const location = r.headers.get("Location")!;
    expect(location).toMatch(/^\/trips\/admin\/trp_[0-9A-Za-z]{26}\?done=created$/);
    const create = f.writes()[0];
    expect(create.op).toBe("create");
    expect(create.args[1]).toBe("renner");
    expect(create.args[3]).toBe("su_dana");
    expect(create.args[2]).toMatchObject({ title: "Fall retreat", description: null, status: "draft" });
    const html = await (await f.request(location)).text();
    expect(html).toContain("Trip created.");
    expect(html).toContain("Fall retreat");
  });

  test("bad input re-renders the form with the person's values and never writes", async () => {
    const f = fixture();
    const empty = await f.post("/trips/admin/new", { ...TRIP_FORM, title: "  " });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Give the trip a name");
    const backwards = await f.post("/trips/admin/new", { ...TRIP_FORM, title: "Kept <b>", start_date: "2026-11-12", end_date: "2026-11-10" });
    const html = await backwards.text();
    expect(html).toContain("ends before it starts");
    expect(html).toContain('value="Kept &lt;b&gt;"');
    expect((await f.post("/trips/admin/new", { ...TRIP_FORM, start_date: "2026-02-30" })).status).toBe(400);
    expect((await f.post("/trips/admin/new", { ...TRIP_FORM, visibility: "everyone" })).status).toBe(400);
    expect(f.writes()).toHaveLength(0);
  });

  test("a store refusal is shown on the form; an outage is never a success", async () => {
    const refused = fixture({ fail: { op: "update", status: 400, message: "Title must be 1 to 200 characters." } });
    const r = await refused.post(`${BASE}/edit`, TRIP_FORM);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Title must be 1 to 200 characters.");
    const down = fixture({ fail: { op: "update", status: 503, message: "x" } });
    const d = await down.post(`${BASE}/edit`, TRIP_FORM);
    expect(d.status).toBe(503);
    expect(d.headers.get("Location")).toBeNull();
  });

  test("edit form is prefilled and escaped; save redirects", async () => {
    const f = fixture();
    const html = await (await f.request(`${BASE}/edit`)).text();
    expect(html).toContain('value="Spring &lt;tour&gt;"');
    expect(html).toContain('<option value="active" selected>');
    const r = await f.post(`${BASE}/edit`, { ...TRIP_FORM, status: "archived" });
    expect(r.headers.get("Location")).toBe(`${BASE}?done=saved`);
    expect(f.trips.get(TRIP)!.status).toBe("archived");
  });

  test("delete asks first, then deletes on POST", async () => {
    const f = fixture();
    const html = await (await f.request(`${BASE}/delete`)).text();
    expect(html).toContain("1 itinerary item");
    expect(html).toContain('method="post"');
    expect(f.writes()).toHaveLength(0);
    const r = await f.post(`${BASE}/delete`, {});
    expect(r.headers.get("Location")).toBe("/trips/admin?done=deleted");
    expect(f.trips.has(TRIP)).toBe(false);
    expect(await (await f.request("/trips/admin?done=deleted")).text()).toContain("Trip deleted.");
  });

  test("unknown and malformed trips are 404 without writing", async () => {
    const f = fixture();
    expect((await f.request(`/trips/admin/trp_${"Z".repeat(26)}`)).status).toBe(404);
    expect((await f.request("/trips/admin/not-a-trip/edit")).status).toBe(404);
    expect((await f.post(`/trips/admin/trp_${"Z".repeat(26)}/delete`, {})).status).toBe(404);
  });
});

describe("Itinerary", () => {
  test("add, edit and remove an item", async () => {
    const f = fixture();
    const add = await f.post(`${BASE}/segments/new`, SEG_FORM);
    expect(add.headers.get("Location")).toBe(`${BASE}?done=segment-added`);
    const added = f.writes().find((c) => c.op === "addSegment")!;
    expect(added.args[0]).toMatch(/^tseg_[0-9A-Za-z]{26}$/);
    expect(added.args[1]).toBe(TRIP);

    const editHtml = await (await f.request(`${BASE}/segments/${SEG}/edit`)).text();
    expect(editHtml).toContain('value="Flight to Denver"');
    expect(editHtml).toContain('name="start_on" value="2026-11-01"');
    expect(editHtml).toContain('name="start_time" value="08:30"');
    const edit = await f.post(`${BASE}/segments/${SEG}/edit`, { ...SEG_FORM, type: "flight", label: "Flight to Boise" });
    expect(edit.headers.get("Location")).toBe(`${BASE}?done=segment-saved`);
    expect(f.segments.get(SEG)!.label).toBe("Flight to Boise");

    const remove = await f.post(`${BASE}/segments/${SEG}/remove`, {});
    expect(remove.headers.get("Location")).toBe(`${BASE}?done=segment-removed`);
    expect(f.segments.has(SEG)).toBe(false);
  });

  test("an item from another trip cannot be edited or removed through this one", async () => {
    const f = fixture();
    expect((await f.request(`${BASE}/segments/${OTHER_SEG}/edit`)).status).toBe(404);
    expect((await f.post(`${BASE}/segments/${OTHER_SEG}/remove`, {})).status).toBe(404);
    expect(f.segments.has(OTHER_SEG)).toBe(true);
  });

  test("item validation", async () => {
    const f = fixture();
    expect(await (await f.post(`${BASE}/segments/new`, { ...SEG_FORM, label: "" })).text()).toContain("short name");
    expect(await (await f.post(`${BASE}/segments/new`, { ...SEG_FORM, end_at: "2026-10-01T00:00" })).text()).toContain("“Check-out” is before “Check-in”");
    // An unknown kind, or a car (no longer offered), goes back to choosing one.
    for (const type of ["boat", "car"]) {
      const r = await f.post(`${BASE}/segments/new`, { ...SEG_FORM, type });
      expect([r.status, r.headers.get("Location")]).toEqual([303, `${BASE}/segments/new`]);
    }
    const tooLong = await f.post(`${BASE}/segments/new`, { ...SEG_FORM, d_phone: "5".repeat(301) });
    expect(await tooLong.text()).toContain("Keep “Phone” to 300 characters");
    expect(f.writes()).toHaveLength(0);
  });
});

describe("Travelers", () => {
  test("without a member directory, staff add by member ID", async () => {
    const f = fixture();
    const html = await (await f.request(`${BASE}/members/add`)).text();
    expect(html).toContain('name="member_id"');
    expect(html).not.toContain("can't be searched");
    const r = await f.post(`${BASE}/members`, { member_id: "su_lee", role: "traveler" });
    expect(r.headers.get("Location")).toBe(`${BASE}?done=member-saved`);
    expect(f.members.some((m) => m.member_id === "su_lee")).toBe(true);
  });

  test("with a directory: search shows names only, never emails or credentials", async () => {
    const accounts = fakeMemberAccounts();
    const f = fixture({ members: accounts });
    const html = await (await f.request(`${BASE}/members/add?q=`)).text();
    expect(html).toContain("Dana Reyes");
    expect(html).toContain("Already on this trip");
    expect(html).toContain(">lee<"); // empty directory name falls back to username
    expect(html).not.toContain("Gone Person");
    expect(html).not.toContain("@example.com");
    expect(html).not.toContain("pbkdf2");
    expect(accounts.ops).toContain("finish");
    const detail = await (await f.request(BASE)).text();
    expect(detail).toContain("Dana Reyes");
    expect(detail).not.toContain("pbkdf2");
  });

  test("with a directory, only enabled members of the space can be added", async () => {
    const f = fixture({ members: fakeMemberAccounts() });
    for (const member_id of ["su_gone", "su_nobody"]) {
      const r = await f.post(`${BASE}/members`, { member_id, role: "traveler" });
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("an active member of this space");
    }
    expect((await f.post(`${BASE}/members`, { member_id: "su_lee", role: "viewer" })).status).toBe(303);
    expect(f.writes().map((c) => c.op)).toEqual(["setMember"]);
  });

  test("a directory outage falls back to the ID field rather than failing the page", async () => {
    const f = fixture({ members: fakeMemberAccounts({ down: true }) });
    const html = await (await f.request(`${BASE}/members/add`)).text();
    expect(html).toContain("can't be searched right now");
    expect(html).toContain('name="member_id"');
    expect((await f.request(BASE)).status).toBe(200);
  });

  test("role change and removal", async () => {
    const f = fixture();
    expect((await f.post(`${BASE}/members`, { member_id: "su_dana", role: "viewer" })).status).toBe(303);
    expect(f.members.find((m) => m.member_id === "su_dana")!.role).toBe("viewer");
    expect((await f.post(`${BASE}/members`, { member_id: "su_dana", role: "captain" })).status).toBe(400);
    const confirm = await (await f.request(`${BASE}/members/su_dana/remove`)).text();
    expect(confirm).toContain("Remove from trip");
    const r = await f.post(`${BASE}/members/su_dana/remove`, {});
    expect(r.headers.get("Location")).toBe(`${BASE}?done=member-removed`);
    expect(f.members).toHaveLength(0);
    expect((await f.post(`${BASE}/members/su_dana/remove`, {})).status).toBe(404);
  });
});

describe("Public pages and drafts", () => {
  function withDraft() {
    const f = fixture();
    f.trips.set(TRIP, { ...f.trips.get(TRIP)!, status: "draft", visibility: "public" });
    f.trips.set(OTHER, { ...f.trips.get(OTHER)!, visibility: "public" });
    return f;
  }

  test("the list leaves drafts out for visitors, members and staff", async () => {
    const f = withDraft();
    const anon = await (await app.fetch(new Request(`${ORIGIN}/trips`), f.env)).text();
    expect(anon).toContain("Other trip");
    expect(anon).not.toContain("Spring");
    for (const role of ["member", "staff"]) {
      const html = await (await f.request("/trips", {}, { role })).text();
      expect(html).toContain("Other trip");
      expect(html).not.toContain("Spring");
    }
  });

  test("a draft is not available to visitors or members, even when public", async () => {
    const f = withDraft();
    const anon = await app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`), f.env);
    expect(anon.status).toBe(404);
    expect(await anon.text()).not.toContain("Spring");
    const member = await f.request(`/trips/${TRIP}`, {}, { role: "member" });
    expect(member.status).toBe(404);
    expect(await member.text()).not.toContain("Spring");
  });

  test("staff can preview a draft, marked as a draft and never cached", async () => {
    const f = withDraft();
    const res = await f.request(`/trips/${TRIP}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Spring &lt;tour&gt;");
    expect(html).toContain("This trip is a draft");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  test("active trips show without the draft note", async () => {
    const f = withDraft();
    const html = await (await app.fetch(new Request(`${ORIGIN}/trips/${OTHER}`), f.env)).text();
    expect(html).toContain("Other trip");
    expect(html).not.toContain("This trip is a draft");
  });
});

const REV = "b".repeat(64);
const FLIGHT_FORM = { type: "flight", label: "Flight to Denver", start_at: "", end_at: "", confirmation_ref: "", notes: "" };

describe("Time zones", () => {
  // Across the date line: leaves Tokyo 21:00 and lands in Honolulu at 09:00 the same date, ten hours later.
  const WEST = { ...FLIGHT_FORM, start_at: "2026-07-01T21:00", end_at: "2026-07-01T09:00", start_tz: "asia/tokyo", end_tz: "Pacific/Honolulu" };
  const added = (f: ReturnType<typeof fixture>) => f.writes().filter((c) => c.op === "addSegment").map((c) => c.args[2] as Record<string, unknown>);

  test("a flight can land at an earlier clock time; zones are saved in canonical form", async () => {
    const f = fixture();
    const r = await f.post(`${BASE}/segments/new`, WEST);
    expect(r.status).toBe(303);
    expect(added(f)[0]!.details).toEqual({ start_tz: "Asia/Tokyo", end_tz: "Pacific/Honolulu" });
    // Without zones the same times read as ending first, as before.
    const html = await (await f.post(`${BASE}/segments/new`, { ...WEST, start_tz: "", end_tz: "" })).text();
    expect(html).toContain("“Arrives” is before “Departs”. Check the two times.");
    expect(added(f)).toHaveLength(1);
  });

  test("an unknown zone is refused with the person's values kept", async () => {
    const f = fixture();
    const html = await (await f.post(`${BASE}/segments/new`, { ...WEST, end_tz: "New York" })).text();
    expect(html).toContain("The time zone for “Arrives” isn&#39;t one we recognise.");
    expect(html).toContain('value="New York"');
    expect(added(f)).toHaveLength(0);
  });

  test("a zone without its time is not saved", async () => {
    const f = fixture();
    await f.post(`${BASE}/segments/new`, { ...WEST, end_at: "" });
    expect(added(f)[0]!.details).toEqual({ start_tz: "Asia/Tokyo" });
  });

  test("the form suggests zones; a new item starts where the last one ended; editing keeps the item's own", async () => {
    const f = fixture();
    f.segments.set(SEG, { ...f.segments.get(SEG)!, details: JSON.stringify({ start_tz: "America/Chicago", end_tz: "America/Denver" }) });
    const fresh = await (await f.request(`${BASE}/segments/new?type=hotel`)).text();
    expect(fresh).toContain('<datalist id="tz-names">');
    expect(fresh).toContain('<option value="Europe/Rome">');
    expect(fresh).toMatch(/name="start_tz" value="America\/Denver"/);
    expect(fresh).toMatch(/name="end_tz" value="America\/Denver"/);
    const edit = await (await f.request(`${BASE}/segments/${SEG}/edit`)).text();
    expect(edit).toMatch(/name="start_tz" value="America\/Chicago"/);
  });

  test("times show their zone on the trip page and in the admin", async () => {
    const f = fixture();
    f.trips.set(TRIP, { ...f.trips.get(TRIP)!, visibility: "public" });
    f.segments.set(SEG, { ...f.segments.get(SEG)!, details: JSON.stringify({ start_tz: "America/Chicago" }) });
    const page = await (await app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`), f.env)).text();
    expect(page).toContain("Departs 2026-11-01 08:30 (Chicago, GMT-6)");
    expect(page).not.toContain("start_tz");
    expect(await (await f.request(BASE)).text()).toContain("2026-11-01 08:30 (Chicago, GMT-6)");
  });
});

describe("Items outside the trip's dates", () => {
  test("the admin trip page points out an item that starts before the trip; visitors never see it", async () => {
    const f = fixture();
    expect(await (await f.request(BASE)).text()).not.toContain('<p class="admin-hint">');
    f.segments.set(SEG, { ...f.segments.get(SEG)!, start_at: "2026-10-30T08:30" });
    f.trips.set(TRIP, { ...f.trips.get(TRIP)!, visibility: "public" });
    expect(await (await f.request(BASE)).text()).toContain(
      "This is before the trip starts on 2026-11-01. Check the date, or change the trip&#39;s dates.",
    );
    expect(await (await app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`), f.env)).text()).not.toContain("before the trip starts");
  });
});

describe("Item kinds, details and images", () => {
  test("adding starts by choosing a kind; each kind asks for its own fields", async () => {
    const f = fixture();
    const choose = await (await f.request(`${BASE}/segments/new`)).text();
    for (const name of ["Flight", "Hotel", "Activity", "Other"]) expect(choose).toContain(`?type=${name.toLowerCase()}`);
    expect(choose).not.toContain("?type=car");
    const flight = await (await f.request(`${BASE}/segments/new?type=flight`)).text();
    expect(flight).toContain('name="d_airline"');
    expect(flight).toContain(">Departs<");
    expect(flight).not.toContain('name="location"');
    const hotel = await (await f.request(`${BASE}/segments/new?type=hotel`)).text();
    expect(hotel).toContain(">Check-in<");
    expect(hotel).toContain(">Address<");
    expect(hotel).toContain('name="d_room"');
    expect(hotel).toContain("data-image-field");
  });

  test("details are sent as one object holding only the kind's filled-in fields", async () => {
    const f = fixture();
    await f.post(`${BASE}/segments/new`, { ...FLIGHT_FORM, d_airline: "United", d_seat: "14C", d_to: "", d_room: "ignored", location: "ignored" });
    const write = f.writes().find((c) => c.op === "addSegment")!.args[2] as Record<string, unknown>;
    expect(write.details).toEqual({ airline: "United", seat: "14C" });
    expect("location" in write).toBe(false); // flights don't use it, so a saved one is kept
    expect("image_tag" in write).toBe(false); // no image choice = image unchanged
    await f.post(`${BASE}/segments/new`, FLIGHT_FORM);
    expect((f.writes().filter((c) => c.op === "addSegment")[1]!.args[2] as Record<string, unknown>).details).toBeNull();
  });

  test("an item's kind can't change when it is edited", async () => {
    const f = fixture();
    await f.post(`${BASE}/segments/${SEG}/edit`, { ...SEG_FORM, type: "hotel", label: "Still a flight" });
    expect((f.writes().find((c) => c.op === "updateSegment")!.args[1] as Record<string, unknown>).type).toBe("flight");
  });

  test("the image choice: set, remove, and refused from another space", async () => {
    const f = fixture();
    const choice = (v: unknown) => ({ ...SEG_FORM, imageSelection: JSON.stringify(v) });
    await f.post(`${BASE}/segments/${SEG}/edit`, choice({ space: "renner", tag: "hotel-lobby", revision: REV, alt: "" }));
    expect(f.segments.get(SEG)).toMatchObject({ image_tag: "hotel-lobby", image_revision: REV });
    const edit = await (await f.request(`${BASE}/segments/${SEG}/edit`)).text();
    expect(edit).toContain("hotel-lobby");
    await f.post(`${BASE}/segments/${SEG}/edit`, choice(null));
    expect(f.segments.get(SEG)).toMatchObject({ image_tag: null, image_revision: null });
    const before = f.writes().length;
    for (const bad of [{ space: "other-space", tag: "x" }, { space: "renner", tag: "Bad Tag" }, { space: "renner", tag: "ok", revision: "nope" }]) {
      const r = await f.post(`${BASE}/segments/${SEG}/edit`, choice(bad));
      expect(r.status).toBe(400);
    }
    expect((await f.post(`${BASE}/segments/${SEG}/edit`, { ...SEG_FORM, imageSelection: "{oops" })).status).toBe(400);
    expect(f.writes()).toHaveLength(before);
  });

  test("the picker's script is served under a name that matches its content", async () => {
    const f = fixture();
    const hash = new Bun.CryptoHasher("sha256").update(IMAGE_FIELD_JS).digest("hex").slice(0, 12);
    expect(IMAGE_FIELD_PATH).toBe(`/trips/admin/image-field-${hash}.js`);
    const js = await f.request(IMAGE_FIELD_PATH);
    expect(js.headers.get("Content-Type")).toContain("javascript");
    expect(await js.text()).toBe(IMAGE_FIELD_JS);
    expect(await (await f.request(BASE)).text()).toContain(`src="${IMAGE_FIELD_PATH}"`);
    // The library is staff-only, like the rest of the admin.
    expect((await f.request("/trips/admin/image-library", {}, { role: "member" })).status).toBe(403);
  });
});

describe("Public trip page: private details", () => {
  function publicTrip() {
    const f = fixture();
    f.trips.set(TRIP, { ...f.trips.get(TRIP)!, visibility: "public" });
    f.segments.set(SEG, { ...f.segments.get(SEG)!, details: JSON.stringify({ airline: "United", seat: "14C" }),
      image_tag: "denver", image_revision: null });
    return f;
  }

  test("visitors and other members see the item but not seats or confirmation numbers", async () => {
    const f = publicTrip();
    const anon = await (await app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`), f.env)).text();
    const member = await (await f.request(`/trips/${TRIP}`, {}, { uid: "su_lee", sub: "lee", role: "member" })).text();
    for (const html of [anon, member]) {
      expect(html).toContain("Airline: United");
      expect(html).toContain("Departs 2026-11-01 08:30");
      expect(html).toContain("/g/renner/denver/md.webp");
      expect(html).not.toContain("14C");
      expect(html).not.toContain("XYZ");
    }
  });

  test("travelers on the trip and staff see them", async () => {
    const f = publicTrip();
    const traveler = await (await f.request(`/trips/${TRIP}`, {}, { role: "member" })).text(); // su_dana is on the trip
    const staff = await (await f.request(`/trips/${TRIP}`, {}, { uid: "su_lee", sub: "lee" })).text();
    for (const html of [traveler, staff]) {
      expect(html).toContain("Seat: 14C");
      expect(html).toContain("Confirmation: XYZ");
    }
  });
});

describe("Trip cover image", () => {
  const cover = (v: unknown) => JSON.stringify(v);

  test("a new trip can have a cover; without a choice nothing is sent", async () => {
    const f = fixture();
    expect(await (await f.request("/trips/admin/new")).text()).toContain("Cover image (optional)");
    await f.post("/trips/admin/new", { ...TRIP_FORM, imageSelection: cover({ space: "renner", tag: "beach", revision: REV }) });
    await f.post("/trips/admin/new", TRIP_FORM);
    const [withCover, without] = f.writes().filter((c) => c.op === "create").map((c) => c.args[2] as Record<string, unknown>);
    expect(withCover).toMatchObject({ cover_tag: "beach", cover_revision: REV });
    expect("cover_tag" in without!).toBe(false);
  });

  test("edit sets and removes the cover, shows it, and refuses another space's image", async () => {
    const f = fixture();
    await f.post(`${BASE}/edit`, { ...TRIP_FORM, imageSelection: cover({ space: "renner", tag: "beach" }) });
    expect(f.trips.get(TRIP)).toMatchObject({ cover_tag: "beach", cover_revision: null });
    expect(await (await f.request(BASE)).text()).toContain("/g/renner/beach/md.webp");
    expect(await (await f.request(`${BASE}/edit`)).text()).toContain("beach");
    // A mistake elsewhere in the form shows the saved cover again.
    expect(await (await f.post(`${BASE}/edit`, { ...TRIP_FORM, title: "" })).text()).toContain("beach");
    const before = f.writes().length;
    expect((await f.post(`${BASE}/edit`, { ...TRIP_FORM, imageSelection: cover({ space: "elsewhere", tag: "x" }) })).status).toBe(400);
    expect(f.writes()).toHaveLength(before);
    await f.post(`${BASE}/edit`, { ...TRIP_FORM, imageSelection: "null" });
    expect(f.trips.get(TRIP)).toMatchObject({ cover_tag: null, cover_revision: null });
  });

  test("the cover shows on the public list and trip page", async () => {
    const f = fixture();
    f.trips.set(TRIP, { ...f.trips.get(TRIP)!, visibility: "public", cover_tag: "beach", cover_revision: null });
    const list = await (await app.fetch(new Request(`${ORIGIN}/trips`), f.env)).text();
    expect(list).toContain("/g/renner/beach/sm.webp");
    const page = await (await app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`), f.env)).text();
    expect(page).toContain('class="trip-cover"');
    expect(page).toContain("/g/renner/beach/md.webp");
  });
});

describe("Public trip page: travelers", () => {
  function publicTrip(members?: ReturnType<typeof fakeMemberAccounts>) {
    const f = fixture({ members });
    f.trips.set(TRIP, { ...f.trips.get(TRIP)!, visibility: "public" });
    f.members.push({ trip_id: TRIP, member_id: "su_lee", role: "traveler", added_at: "x" },
      { trip_id: TRIP, member_id: "su_gone", role: "viewer", added_at: "x" });
    return f;
  }
  const noSecrets = (html: string) => {
    expect(html).not.toMatch(/su_(dana|lee|gone)/);
    expect(html).not.toContain("@example.com");
    expect(html).not.toContain("pbkdf2");
  };

  test("visitors and other members see a count of who's going, never who, and nothing is looked up", async () => {
    const accounts = fakeMemberAccounts();
    const f = publicTrip(accounts);
    const anon = await (await app.fetch(new Request(`${ORIGIN}/trips/${TRIP}`), f.env)).text();
    f.members.splice(f.members.findIndex((m) => m.member_id === "su_lee"), 1); // su_lee: a member, not on the trip
    const member = await (await f.request(`/trips/${TRIP}`, {}, { uid: "su_lee", sub: "lee", role: "member" })).text();
    expect(anon).toContain("2 people are going.");
    expect(member).toContain("1 person is going.");
    for (const html of [anon, member]) {
      noSecrets(html);
      expect(html).not.toContain("Dana Reyes");
    }
    expect(accounts.ops).toEqual([]);
  });

  test("travelers and staff see names and roles; a name that can't be found reads 'A member'", async () => {
    const f = publicTrip(fakeMemberAccounts());
    const traveler = await (await f.request(`/trips/${TRIP}`, {}, { role: "member" })).text(); // su_dana is on it
    expect(traveler).toContain("Dana Reyes");
    expect(traveler).toContain("Organizer");
    expect(traveler).toContain(">lee<");
    expect(traveler).toContain("A member"); // su_gone is disabled, so the directory leaves it out
    noSecrets(traveler);
  });

  test("with the directory down or absent, insiders still get the page, without IDs", async () => {
    for (const members of [fakeMemberAccounts({ down: true }), undefined]) {
      const f = publicTrip(members);
      const res = await f.request(`/trips/${TRIP}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html.match(/A member/g)?.length).toBe(3);
      noSecrets(html);
    }
  });
});

describe("an item with a day but no time", () => {
  test("the form saves a bare day, drops its zone, and shows it again", async () => {
    const f = fixture();
    const r = await f.post(`${BASE}/segments/new`, { ...SEG_FORM, start_at: undefined as any, end_at: undefined as any,
      start_on: "2026-11-01", start_time: "", end_on: "2026-11-03", end_time: "11:00", start_tz: "Europe/Rome", end_tz: "Europe/Rome" });
    expect(r.status).toBe(303);
    const write = f.writes().find((c) => c.op === "addSegment")!.args[2] as any;
    expect(write.start_at).toBe("2026-11-01");
    expect(write.end_at).toBe("2026-11-03T11:00");
    expect(JSON.parse(JSON.stringify(write.details))).toEqual({ end_tz: "Europe/Rome" });
  });

  test("a time without a day, or a day that doesn't exist, is refused", async () => {
    const f = fixture();
    for (const [on, time] of [["", "09:00"], ["2026-02-30", ""]]) {
      const r = await f.post(`${BASE}/segments/new`, { ...SEG_FORM, start_on: on!, start_time: time!, end_on: "", end_time: "" });
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("isn&#39;t complete. Pick a date. Add a time if you know it.");
    }
    expect(f.writes()).toHaveLength(0);
  });

  test("a day-only end before the start is refused by day", async () => {
    const f = fixture();
    const r = await f.post(`${BASE}/segments/new`, { ...SEG_FORM, start_on: "2026-11-03", start_time: "15:00", end_on: "2026-11-01", end_time: "" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Check the two dates.");
  });
});
