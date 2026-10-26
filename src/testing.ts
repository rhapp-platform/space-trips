// Test stand-ins shared by admin.test.ts and cli.test.ts.
import type { MemberRow, SegmentRow, TripRow } from "./types";

export const TRIP = `trp_${"A".repeat(26)}`;
export const OTHER = `trp_${"B".repeat(26)}`;
export const SEG = `tseg_${"C".repeat(26)}`;
export const OTHER_SEG = `tseg_${"D".repeat(26)}`;

export type Call = { op: string; args: unknown[] };

/** In-memory stand-in for space-store's Trips domain, same result envelope. */
export function fakeTrips(options: { fail?: { op: string; status: number; message: string } } = {}) {
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
  // The store keeps details as JSON text, null when empty.
  const stored = (w: any) => ("details" in w ? { ...w, details: w.details ? JSON.stringify(w.details) : null } : w);
  const service = {
    async trips(_gn: string, op: string, args: unknown[] = []) {
      calls.push({ op, args });
      if (options.fail?.op === op) return { ok: false, status: options.fail.status, message: options.fail.message };
      const [a, b, c, d] = args as any[];
      switch (op) {
        case "list": case "schedule": return ok([...trips.values()]);
        case "get": {
          const t = trips.get(a);
          if (!t) return ok(null);
          return ok({ trip: t, segments: [...segments.values()].filter((s) => s.trip_id === a).sort((x, y) => x.position - y.position),
            members: members.filter((m) => m.trip_id === a) });
        }
        case "create":
          trips.set(a, { ...trip(a, c.title), ...c, gn: b, created_by: d });
          members.push({ trip_id: a, member_id: d, role: "owner", added_at: now });
          return ok(trips.get(a));
        case "update": trips.set(a, { ...trips.get(a)!, ...b }); return ok(trips.get(a));
        case "delete": return ok({ deleted: trips.delete(a) });
        case "addSegment": {
          // As the store: appended after the trip's last item unless a position is given.
          const last = Math.max(-1, ...[...segments.values()].filter((s) => s.trip_id === b).map((s) => s.position));
          segments.set(a, { id: a, trip_id: b, position: last + 1, created_at: now, ...stored(c) });
          return ok(segments.get(a));
        }
        case "updateSegment": segments.set(a, { ...segments.get(a)!, ...stored(b) }); return ok(segments.get(a));
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
export const ROSTER = [
  { id: "su_dana", username: "dana", directory_name: "Dana Reyes", status: "enabled", email: "dana@example.com", password: "pbkdf2$secret-hash" },
  { id: "su_lee", username: "lee", directory_name: "", status: "enabled", email: "lee@example.com", password: "pbkdf2$secret-hash" },
  { id: "su_gone", username: "gone", directory_name: "Gone Person", status: "disabled", email: "gone@example.com", password: "pbkdf2$secret-hash" },
];

export function fakeMemberAccounts(options: { backend?: "store" | "d1"; down?: boolean } = {}) {
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
        if (operation === "findUserByIdentifier") {
          const ref = String(args[0]);
          return { ok: true, value: ROSTER.find((r) => r.username === ref || r.email.toLowerCase() === ref) ?? null };
        }
        return { ok: false, status: 404, message: "no" };
      },
    },
  };
}

