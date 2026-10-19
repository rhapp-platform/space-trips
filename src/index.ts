/**
 * space-trips — the space-level trip itinerary surface.
 *
 * Serves {space}.rhapp.app/trips. Reads from the space-store DO via the
 * SpaceStoreTrips service binding; no D1, no separate set worker.
 *
 * Server-rendered. Chrome, identity, and session come from space-surface.
 */

import { Hono } from "hono";
import { escapeHtml as esc, readSpaceRecord, renderState, resolveSpaceName } from "../../space-surface/src";
import { admin } from "./admin";
import { callTrips } from "./trips";
import { notAvailable, page, scope, unavailable, type Scope } from "./scope";
import { SURFACE } from "./surface";
import type { Env, MemberRow, SegmentRow, TripDetail, TripRow } from "./types";

const app = new Hono<{ Bindings: Env }>();

const TRP = /^trp_[0-9A-Za-z]{26}$/;

// ── Health ───────────────────────────────────────────────────────────────────

app.get("/trips/_/health", async (c) => {
  const gn = resolveSpaceName(new URL(c.req.url));
  const record = gn ? await readSpaceRecord(c.env, gn) : null;
  const instance = record?.route?.instance ?? null;

  let tripsOk = false;
  if (gn) {
    const r = await callTrips<TripRow[]>(c.env, gn, "list", [gn, "public"]);
    tripsOk = r.ok;
  }

  c.header("Cache-Control", "no-store, max-age=0");
  return c.json(
    {
      worker: "space-trips",
      version: c.env.WORKER_VERSION,
      environment: c.env.ENVIRONMENT,
      space: gn,
      spaceRecord: record ? "found" : "missing",
      instance,
      certAid: SURFACE.aid,
      tripsBinding: Boolean(c.env.TRIPS_WORKER),
      tripsOk,
      secrets: {
        master: Boolean(c.env.RHAP_MASTER_SECRET),
        roleSession: Boolean(c.env.AUTH_SESSION_SECRET),
      },
    },
    gn && record && tripsOk ? 200 : 503,
  );
});

// ── Admin ────────────────────────────────────────────────────────────────────

app.route("/trips/admin", admin);

// ── Rendering helpers ────────────────────────────────────────────────────────

function statusLabel(status: string): string {
  if (status === "active") return "Active";
  if (status === "archived") return "Archived";
  return "Draft";
}

function dateRange(trip: TripRow): string {
  if (trip.start_date && trip.end_date) return `${trip.start_date} – ${trip.end_date}`;
  if (trip.start_date) return `From ${trip.start_date}`;
  return "";
}

const SEGMENT_GLYPH: Record<string, string> = {
  flight: "✈", hotel: "🏨", car: "🚗", activity: "🎯", other: "📌",
};

function renderAgenda(trips: TripRow[], spaceName: string, signedIn: boolean): string {
  if (!trips.length) {
    return renderState(
      "No trips yet",
      signedIn
        ? `No trips have been shared in ${spaceName} yet.`
        : "Sign in to see trips you're part of, or check back for public trips.",
    );
  }
  const cards = trips
    .map(t => {
      const dates = dateRange(t);
      return `<li><a class="trip-card" href="/trips/${esc(t.id)}">
        <h2>${esc(t.title)}</h2>
        ${dates ? `<p class="dates">${esc(dates)}</p>` : ""}
        <span class="status">${esc(statusLabel(t.status))}</span>
      </a></li>`;
    })
    .join("");
  return `<div class="intro"><h1>${esc(spaceName)} Trips</h1></div>
    <ul class="trip-list">${cards}</ul>`;
}

function renderTripDetail(
  detail: TripDetail,
  viewerUid: string | null,
): string {
  const { trip, segments, members } = detail;
  const dates = dateRange(trip);

  const segList = segments.length
    ? `<ul class="segments">${segments
        .map(
          seg => `<li class="segment">
        <p class="type">${SEGMENT_GLYPH[seg.type] ?? "•"} ${esc(seg.type)}</p>
        <h3>${esc(seg.label)}</h3>
        ${seg.start_at || seg.end_at
          ? `<p class="when">${[seg.start_at, seg.end_at].filter((v): v is string => Boolean(v)).map(esc).join(" → ")}</p>`
          : ""}
        ${seg.location ? `<p class="when">📍 ${esc(seg.location)}</p>` : ""}
        ${seg.confirmation_ref ? `<p class="when">Ref: ${esc(seg.confirmation_ref)}</p>` : ""}
      </li>`,
        )
        .join("")}</ul>`
    : "<p>No itinerary segments yet.</p>";

  const memberChips = members.length
    ? `<div class="members">${members
        .map(
          m => `<span class="member-chip">${esc(m.member_id)}<span class="role">${esc(m.role)}</span></span>`,
        )
        .join("")}</div>`
    : "";

  return `<div class="trip-head">
    <h1>${esc(trip.title)}</h1>
    <div class="trip-meta">
      ${dates ? `<div class="row"><span class="k">📅</span><span>${esc(dates)}</span></div>` : ""}
      ${trip.description
        ? `<div class="row"><span class="k">ℹ</span><span>${esc(trip.description)}</span></div>`
        : ""}
      <div class="row"><span class="k">•</span><span>${esc(statusLabel(trip.status))}</span></div>
    </div>
  </div>
  <h2>Itinerary</h2>
  ${segList}
  ${memberChips ? `<h2>Travelers</h2>${memberChips}` : ""}`;
}

// ── Agenda ───────────────────────────────────────────────────────────────────

app.get("/trips", async (c) => {
  const s = await scope(c);
  if ("error" in s) return s.error;

  // Signed-in viewers see public trips + members trips + private trips they belong to.
  // schedule() implements that cross-visibility check against trip_members.
  // Signed-out visitors see public-only via list().
  const [op, args]: [string, unknown[]] =
    s.viewer.signedIn && s.viewer.uid
      ? ["schedule", [s.gn, s.viewer.uid]]
      : ["list", [s.gn, "public"]];

  const result = await callTrips<TripRow[]>(c.env, s.gn, op, args);
  if (!result.ok) return unavailable(s, "/trips", result.status);

  return page(s, {
    title: "Trips",
    canonicalPath: "/trips",
    cache: s.cache,
    description: `Upcoming trips at ${s.space.name}.`,
    content: renderAgenda(result.value, s.space.name, s.viewer.signedIn),
  });
});

// ── Trip detail ──────────────────────────────────────────────────────────────

app.get("/trips/:id", async (c) => {
  const s = await scope(c);
  if ("error" in s) return s.error;
  const id = c.req.param("id");
  const path = `/trips/${encodeURIComponent(id)}`;
  if (!TRP.test(id)) return notAvailable(s, path);

  const result = await callTrips<TripDetail | null>(c.env, s.gn, "get", [id]);
  if (!result.ok) {
    return result.status === 404 ? notAvailable(s, path) : unavailable(s, path, result.status);
  }
  if (!result.value) return notAvailable(s, path);

  const { trip, members } = result.value;

  // Enforce visibility gate in the surface worker (space-store serves raw data).
  if (trip.visibility === "private") {
    if (!s.viewer.uid || !members.some((m: MemberRow) => m.member_id === s.viewer.uid)) {
      return notAvailable(s, path);
    }
  } else if (trip.visibility === "members" && !s.viewer.signedIn) {
    return notAvailable(s, path);
  }

  return page(s, {
    title: trip.title,
    barTitle: "Trips",
    backPath: "/trips",
    canonicalPath: `/trips/${id}`,
    // Private and members-only trips must never be edge-cached.
    cache: trip.visibility === "public" ? s.cache : "private",
    description: trip.description?.slice(0, 300) ?? undefined,
    content: renderTripDetail(result.value, s.viewer.uid),
  });
});

app.notFound((c) => c.text("Not found", 404));
app.onError((error, c) => {
  console.error("[space-trips] request failed", error);
  return c.text("Trips are temporarily unavailable.", 500);
});

export { app };
export default app;
