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
import { artworkUrl } from "../../home/src/image-field";
import { admin } from "./admin";
import { kindOf, readDetails, shownDetails } from "./kinds";
import { when } from "./time";
import { people, type Person } from "./people";
import { callTrips } from "./trips";
import { notAvailable, page, scope, unavailable, type Scope } from "./scope";
import { SURFACE } from "./surface";
import { access } from "./view";
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

function coverUrl(trip: TripRow, gn: string, environment: string, size: "sm" | "md"): string | null {
  return trip.cover_tag ? artworkUrl(gn, trip.cover_tag, trip.cover_revision, size, environment) : null;
}

function renderAgenda(trips: TripRow[], spaceName: string, signedIn: boolean, gn: string, environment: string): string {
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
      const cover = coverUrl(t, gn, environment, "sm");
      return `<li><a class="trip-card" href="/trips/${esc(t.id)}">
        ${cover ? `<img class="trip-card-cover" src="${esc(cover)}" alt="" loading="lazy">` : ""}
        <h2>${esc(t.title)}</h2>
        ${dates ? `<p class="dates">${esc(dates)}</p>` : ""}
        <span class="status">${esc(statusLabel(t.status))}</span>
      </a></li>`;
    })
    .join("");
  return `<div class="intro"><h1>${esc(spaceName)} Trips</h1></div>
    <ul class="trip-list">${cards}</ul>`;
}

/**
 * `insider` = on this trip, or staff. Only insiders see confirmation numbers
 * and private details (seat, room): a public trip page is readable by anyone,
 * and a booking reference plus a name is enough to change a booking.
 */
const ROLE_LABEL: Record<string, string> = { owner: "Organizer", traveler: "Traveler", viewer: "Following" };

/**
 * Who's on the trip. Insiders see names; everyone else sees how many are
 * traveling, never who. A member ID is never shown: a name that can't be
 * looked up reads "A member".
 */
function renderTravelers(members: MemberRow[], names: Map<string, Person> | null): string {
  const traveling = members.filter(m => m.role !== "viewer").length;
  if (!names) {
    return traveling ? `<p class="travelers-count">${traveling} ${traveling === 1 ? "person is" : "people are"} going.</p>` : "";
  }
  if (!members.length) return "";
  return `<div class="members">${members
    .map(m => `<span class="member-chip">${esc(names.get(m.member_id)?.label ?? "A member")}<span class="role">${esc(ROLE_LABEL[m.role] ?? m.role)}</span></span>`)
    .join("")}</div>`;
}

/** Names for insiders. A directory outage degrades to "A member", never to IDs or an error page. */
async function travelerNames(env: Env, gn: string, members: MemberRow[]): Promise<Map<string, Person>> {
  const directory = people(env, gn);
  if (!directory || !members.length) return new Map();
  try {
    return await directory.find(members.map(m => m.member_id));
  } catch (error) {
    console.error("[space-trips] traveler names unavailable", (error as Error).message);
    return new Map();
  }
}

function renderTripDetail(
  detail: TripDetail,
  gn: string,
  environment: string,
  insider: boolean,
  names: Map<string, Person> | null,
): string {
  const { trip, segments, members } = detail;
  const dates = dateRange(trip);

  const segList = segments.length
    ? `<ul class="segments">${segments
        .map(
          seg => {
            const kind = kindOf(seg.type);
            const zones = readDetails(seg.details);
            const times = [
              seg.start_at ? `${kind?.start ?? "Starts"} ${when(seg.start_at, zones.start_tz)}` : "",
              seg.end_at ? `${kind?.end ?? "Ends"} ${when(seg.end_at, zones.end_tz)}` : "",
            ].filter(Boolean);
            return `<li class="segment">
        ${seg.image_tag
          ? `<img class="segment-image" src="${esc(artworkUrl(gn, seg.image_tag, seg.image_revision, "md", environment))}" alt="" loading="lazy">`
          : ""}
        <p class="type">${SEGMENT_GLYPH[seg.type] ?? "•"} ${esc(kind?.name ?? seg.type)}</p>
        <h3>${esc(seg.label)}</h3>
        ${times.length ? `<p class="when">${times.map(esc).join(" · ")}</p>` : ""}
        ${seg.location ? `<p class="when">📍 ${esc(seg.location)}</p>` : ""}
        ${shownDetails(seg, insider).map(([k, v]) => `<p class="when">${esc(k)}: ${esc(v)}</p>`).join("")}
        ${insider && seg.confirmation_ref ? `<p class="when">Confirmation: ${esc(seg.confirmation_ref)}</p>` : ""}
      </li>`;
          },
        )
        .join("")}</ul>`
    : "<p>No itinerary segments yet.</p>";

  const travelers = renderTravelers(members, insider ? names : null);

  const draftNote = trip.status === "draft"
    ? `<p class="draft-note" role="note">This trip is a draft. Only staff can see it. Set its status to Active in Manage trips to share it.</p>`
    : "";

  const cover = coverUrl(trip, gn, environment, "md");
  return `${draftNote}${cover ? `<img class="trip-cover" src="${esc(cover)}" alt="">` : ""}<div class="trip-head">
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
  ${travelers ? `<h2>Travelers</h2>${travelers}` : ""}`;
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

  // The store does not filter by status, so drafts are dropped here. Staff
  // find drafts in /trips/admin; this page shows what everyone else sees.
  const trips = result.value.filter(t => t.status !== "draft");

  return page(s, {
    title: "Trips",
    canonicalPath: "/trips",
    cache: s.cache,
    description: `Upcoming trips at ${s.space.name}.`,
    content: renderAgenda(trips, s.space.name, s.viewer.signedIn, s.gn, s.environment),
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

  // The same gate as a trip app (view.ts); space-store serves raw rows. Drafts
  // are for staff, who preview one from the admin's "View as a visitor" link.
  // Everyone the gate refuses gets the same page as a missing trip.
  const allowed = access(trip, members, s.viewer);
  if (!allowed) return notAvailable(s, path);
  const draft = trip.status === "draft";

  return page(s, {
    title: trip.title,
    barTitle: "Trips",
    backPath: "/trips",
    canonicalPath: `/trips/${id}`,
    // Drafts, private and members-only trips must never be edge-cached.
    cache: draft ? "no-store" : trip.visibility === "public" ? s.cache : "private",
    description: trip.description?.slice(0, 300) ?? undefined,
    content: renderTripDetail(result.value, s.gn, s.environment, allowed.insider,
      allowed.insider ? await travelerNames(c.env, s.gn, members) : null),
  });
});

app.notFound((c) => c.text("Not found", 404));
app.onError((error, c) => {
  console.error("[space-trips] request failed", error);
  return c.text("Trips are temporarily unavailable.", 500);
});

export { app };
export default app;
