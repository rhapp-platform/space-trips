import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { app } from "./index";
import type { Env, MemberRow, SegmentRow, TripRow } from "./types";

const SECRET = "trips-admin-test";
const ORIGIN = "https://renner.rhapp.work";
const TRIP = `trp_${"A".repeat(26)}`;
const OTHER = `trp_${"B".repeat(26)}`;
const SEG = `tseg_${"C".repeat(26)}`;
const OTHER_SEG = `tseg_${"D".repeat(26)}`;
const BASE = `/trips/admin/${TRIP}`;

type Call = { op: string; args: unknown[] };

/** In-memory stand-in for space-store's Trips domain, same result envelope. */
function fakeTrips(options: { fail?: { op: string; status: number; message: string } } = {}) {
  const trips = new Map<string, TripRow>();
  const segments = new Map<string, SegmentRow>();
  const members: MemberRow[] = [];
  const calls: Call[] = [];
  const now = "2026-10-19T12:00:00Z";
  const trip = (id: string, title: string): TripRow => ({
    id, gn: "renner", title, description: null, status: "active", start_date: "2026-11-01",
    end_date: "2026-11-05", visibility: "members", created_by: "su_dana", created_at: now,
  });
  trips.set(TRIP, trip(TRIP, "Spring <tour>"));
  trips.set(OTHER, trip(OTHER, "Other trip"));
  segments.set(SEG, { id: SEG, trip_id: TRIP, type: "flight", label: "Flight to Denver", start_at: "2026-11-01T08:30",
    end_at: null, location: "DEN", confirmation_ref: "XYZ", notes: null, position: 0, created_at: now });
  segments.set(OTHER_SEG, { ...segments.get(SEG)!, id: OTHER_SEG, trip_id: OTHER, label: "Elsewhere" });
  members.push({ trip_id: TRIP, member_id: "su_dana", role: "owner", added_at: now });
  const ok = (value: unknown) => ({ ok: true, value });
  const service = {
    async trips(_gn: string, op: string, args: unknown[] = []) {
      calls.push({ op, args });
      if (options.fail?.op === op) return { ok: false, status: options.fail.status, message: options.fail.message };
      const [a, b, c, d] = args as any[];
      switch (op) {
        case "list": return ok([...trips.values()]);
        case "get": {
          const t = trips.get(a);
          if (!t) return ok(null);
          return ok({ trip: t, segments: [...segments.values()].filter((s) => s.trip_id === a),
            members: members.filter((m) => m.trip_id === a) });
        }
        case "create":
          trips.set(a, { ...trip(a, c.title), ...c, gn: b, created_by: d });
          members.push({ trip_id: a, member_id: d, role: "owner", added_at: now });
          return ok(trips.get(a));
        case "update": trips.set(a, { ...trips.get(a)!, ...b }); return ok(trips.get(a));
        case "delete": return ok({ deleted: trips.delete(a) });
        case "addSegment": segments.set(a, { id: a, trip_id: b, position: 9, created_at: now, ...c }); return ok(segments.get(a));
        case "updateSegment": segments.set(a, { ...segments.get(a)!, ...b }); return ok(segments.get(a));
        case "removeSegment": return ok({ deleted: segments.delete(a) });
        case "setMember": {
          const existing = members.find((m) => m.trip_id === a && m.member_id === b);
          if (existing) existing.role = c;
          else members.push({ trip_id: a, member_id: b, role: c, added_at: now });
          return ok({ trip_id: a, member_id: b, role: c, added_at: now });
        }
        case "removeMember": {
          const i = members.findIndex((m) => m.trip_id === a && m.member_id === b);
          if (i >= 0) members.splice(i, 1);
          return ok({ deleted: i >= 0 });
        }
      }
      return { ok: false, status: 400, message: "unknown op" };
    },
  };
  return { service, calls, trips, segments, members };
}

/** Full space_users rows, credentials included, as the real entrypoint returns. */
const ROSTER = [
  { id: "su_dana", username: "dana", directory_name: "Dana Reyes", status: "enabled", email: "dana@example.com", password: "pbkdf2$secret-hash" },
  { id: "su_lee", username: "lee", directory_name: "", status: "enabled", email: "lee@example.com", password: "pbkdf2$secret-hash" },
  { id: "su_gone", username: "gone", directory_name: "Gone Person", status: "disabled", email: "gone@example.com", password: "pbkdf2$secret-hash" },
];

function fakeMemberAccounts(options: { backend?: "store" | "d1"; down?: boolean } = {}) {
  const ops: string[] = [];
  const permit = { permit_id: "p1", epoch: 1, backend: options.backend ?? "store", operation: "read" as const };
  return {
    ops,
    binding: {
      async begin() { return options.down ? { ok: false, status: 503, message: "down" } : { ok: true, value: permit }; },
      async finish() { ops.push("finish"); return { ok: true, value: true }; },
      async account(_gn: string, _p: unknown, operation: string, args: unknown[]) {
        ops.push(operation);
        if (operation === "listUsers") {
          const q = String((args[0] as { q: string }).q ?? "").toLowerCase();
          const rows = ROSTER.filter((r) => r.username.includes(q) || r.email.includes(q));
          return { ok: true, value: { rows, total: rows.length } };
        }
        if (operation === "findUserById") return { ok: true, value: ROSTER.find((r) => r.id === args[0]) ?? null };
        return { ok: false, status: 404, message: "no" };
      },
    },
  };
}

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
    expect(editHtml).toContain('value="2026-11-01T08:30"');
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
    expect(await (await f.post(`${BASE}/segments/new`, { ...SEG_FORM, end_at: "2026-10-01T00:00" })).text()).toContain("ends before it starts");
    expect((await f.post(`${BASE}/segments/new`, { ...SEG_FORM, type: "boat" })).status).toBe(400);
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
