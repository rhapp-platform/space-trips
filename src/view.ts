/**
 * Who may see a trip, and the trip as they may see it. The trip page
 * (index.ts) and the TripsView entrypoint (worker.ts, behind the registry's
 * `trip/1` reference, app-design-registry ADR 0007) both decide through
 * `access`, so the two can never disagree on who sees a trip, a seat or a name.
 *
 * `tripView` is the finished trip a design arranges: days, display times and
 * labels are made here, once. It never carries a member ID, a raw time, or a
 * private field the viewer may not see.
 */
import { artworkUrl } from "../../home/src/image-field";
import { canManageTrips } from "./admin";
import { kindOf, readDetails, shownDetails } from "./kinds";
import { zoneLabel } from "./time";
import type { People } from "./people";
import type { MemberRow, SegmentRow, TripDetail, TripRow, TripsResult } from "./types";

/** Who is looking: from the role session on a page, from the host for TripsView. */
export interface Looker {
  uid: string | null;
  role: string | null;
  signedIn: boolean;
}

export interface AccessOptions {
  /** ADR 0007: a trip app shows an archived trip to nobody. The trip page shows it. */
  hideArchived?: boolean;
}

/**
 * Null when the viewer may not see the trip; otherwise whether they are an
 * insider (on the trip, or staff). Insiders see private details, confirmation
 * numbers and names. An unknown status or visibility is refused, not guessed.
 */
export function access(trip: TripRow, members: MemberRow[], viewer: Looker, options: AccessOptions = {}): { insider: boolean; staff: boolean } | null {
  const staff = canManageTrips(viewer.role);
  // Drafts are for staff only; everyone else gets the same answer as a missing trip.
  if (trip.status === "draft") { if (!staff) return null; }
  else if (trip.status === "archived") { if (options.hideArchived) return null; }
  else if (trip.status !== "active") return null;
  const onTrip = Boolean(viewer.uid && members.some((m) => m.member_id === viewer.uid));
  if (trip.visibility === "private") { if (!onTrip) return null; }
  else if (trip.visibility === "members") { if (!viewer.signedIn) return null; }
  else if (trip.visibility !== "public") return null;
  return { insider: staff || onTrip, staff };
}

// ── The finished trip ────────────────────────────────────────────────────────

export const VIEW_LIMITS = { days: 60, items: 300, notes: 2000 };

export interface ItemView {
  kind: string;
  kindLabel: string;
  icon: string;
  name: string;
  /** Display text, e.g. "Check-in 3:00 PM (Rome, GMT+2) · Check-out Oct 22, 11:00 AM". */
  when: string | null;
  /** The kind's label for the location ("Address", "Place"), with its value. */
  place: { label: string; value: string } | null;
  details: [string, string][];
  notes: string | null;
  image: string | null;
  /** Insiders only; null for everyone else. */
  confirmation: string | null;
}

export interface TripView {
  title: string;
  description: string[];
  dates: string | null;
  status: TripRow["status"];
  cover: string | null;
  insider: boolean;
  days: { heading: string; date: string; items: ItemView[] }[];
  unscheduled: ItemView[];
  /** People are named for insiders only; everyone else gets the count. */
  travelers: { count: number; people: { name: string; role: string }[] | null };
  truncated: boolean;
}

const ROLE_LABEL: Record<string, string> = { owner: "Organizer", traveler: "Traveler", viewer: "Following" };

const UTC = { timeZone: "UTC" } as const;
const day = (date: string) => new Date(`${date}T00:00:00Z`);
const fmt = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...UTC, ...options }).format(day(date));

/** "9:00 AM" from a wall-clock "…T09:00". */
export function clock(wall: string): string {
  const [h, m] = wall.slice(11, 16).split(":").map(Number);
  return `${(h! % 12) || 12}:${String(m).padStart(2, "0")} ${h! < 12 ? "AM" : "PM"}`;
}

/** "October 19 – November 1, 2026 · 14 days", "From October 19, 2026", or null. */
export function tripDates(start: string | null, end: string | null): string | null {
  if (!start) return end ? `Until ${fmt(end, { month: "long", day: "numeric", year: "numeric" })}` : null;
  const long = { month: "long", day: "numeric", year: "numeric" } as const;
  if (!end) return `From ${fmt(start, long)}`;
  const days = Math.round((day(end).getTime() - day(start).getTime()) / 86_400_000) + 1;
  const first = start.slice(0, 4) === end.slice(0, 4) ? fmt(start, { month: "long", day: "numeric" }) : fmt(start, long);
  return `${start === end ? fmt(start, long) : `${first} – ${fmt(end, long)}`} · ${days} ${days === 1 ? "day" : "days"}`;
}

/** "Day 2 · Tuesday, October 20"; just the date before the trip starts or with no start. */
function dayHeading(date: string, tripStart: string | null): string {
  const text = fmt(date, { weekday: "long", month: "long", day: "numeric" });
  if (!tripStart || date < tripStart) return text;
  return `Day ${Math.round((day(date).getTime() - day(tripStart).getTime()) / 86_400_000) + 1} · ${text}`;
}

/** One side of an item's time: label, the date when it isn't the item's day, the clock, the zone. */
function side(label: string, wall: string, zone: string | undefined, groupDate: string | null): string {
  const date = wall.slice(0, 10) === groupDate ? "" : `${fmt(wall.slice(0, 10), { month: "short", day: "numeric" })}, `;
  return `${label} ${date}${clock(wall)}${zone ? ` (${zoneLabel(wall, zone)})` : ""}`;
}

function item(seg: SegmentRow, insider: boolean, image: (tag: string, revision: string | null | undefined) => string): ItemView {
  const kind = kindOf(seg.type);
  const zones = readDetails(seg.details);
  const group = seg.start_at?.slice(0, 10) ?? null;
  const times = [
    seg.start_at ? side(kind?.start ?? "Starts", seg.start_at, zones.start_tz, group) : "",
    seg.end_at ? side(kind?.end ?? "Ends", seg.end_at, zones.end_tz, group) : "",
  ].filter(Boolean);
  const notes = seg.notes ? seg.notes.slice(0, VIEW_LIMITS.notes) : null;
  return {
    kind: seg.type,
    kindLabel: kind?.name ?? seg.type,
    icon: kind?.icon ?? "mdi:map-marker",
    name: seg.label,
    when: times.length ? times.join(" · ") : null,
    place: seg.location ? { label: kind?.location ?? "Place", value: seg.location } : null,
    details: shownDetails(seg, insider),
    notes,
    image: seg.image_tag ? image(seg.image_tag, seg.image_revision) : null,
    confirmation: insider && seg.confirmation_ref ? seg.confirmation_ref : null,
  };
}

/** The trip as this viewer may see it. `names` is consulted for insiders only. */
export function project(
  detail: TripDetail,
  insider: boolean,
  names: Map<string, { label: string }> | null,
  art: { gn: string; environment: string },
): TripView {
  const { trip, members } = detail;
  const image = (tag: string, revision: string | null | undefined) => artworkUrl(art.gn, tag, revision, "md", art.environment);
  const ordered = [...detail.segments].sort((a, b) => a.position - b.position);
  let truncated = ordered.length > VIEW_LIMITS.items;
  const segments = ordered.slice(0, VIEW_LIMITS.items);

  const byDay = new Map<string, ItemView[]>();
  const unscheduled: ItemView[] = [];
  for (const seg of segments) {
    const date = seg.start_at?.slice(0, 10);
    if (!date) { unscheduled.push(item(seg, insider, image)); continue; }
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push(item(seg, insider, image));
  }
  let dates = [...byDay.keys()].sort();
  if (dates.length > VIEW_LIMITS.days) { truncated = true; dates = dates.slice(0, VIEW_LIMITS.days); }

  // ADR 0007, answer 5: no cover → the first item image in itinerary order.
  const coverItem = segments.find((s) => s.image_tag);
  const cover = trip.cover_tag ? image(trip.cover_tag, trip.cover_revision)
    : coverItem ? image(coverItem.image_tag!, coverItem.image_revision) : null;

  const going = members.filter((m) => m.role !== "viewer");
  return {
    title: trip.title,
    description: (trip.description ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
    dates: tripDates(trip.start_date, trip.end_date),
    status: trip.status,
    cover,
    insider,
    days: dates.map((date) => ({ heading: dayHeading(date, trip.start_date), date, items: byDay.get(date)! })),
    unscheduled,
    travelers: {
      count: going.length,
      people: insider
        ? members.map((m) => ({ name: names?.get(m.member_id)?.label ?? "A member", role: ROLE_LABEL[m.role] ?? m.role }))
        : null,
    },
    truncated,
  };
}

export interface ViewDeps {
  call: <T>(op: string, args: unknown[]) => Promise<TripsResult<T>>;
  people: People | null;
  gn: string;
  environment: string;
}

/**
 * The trip for this viewer: `null` when it is missing or they may not see it
 * (the two look the same on purpose), or a failure the caller shows as an outage.
 * A directory outage degrades names to "A member", never to IDs or an error.
 */
export async function tripView(deps: ViewDeps, viewer: Looker, tripId: string, options: AccessOptions = {}): Promise<TripsResult<TripView | null>> {
  const result = await deps.call<TripDetail | null>("get", [tripId]);
  if (!result.ok) return result.status === 404 ? { ok: true, value: null } : result;
  if (!result.value) return { ok: true, value: null };
  const allowed = access(result.value.trip, result.value.members, viewer, options);
  if (!allowed) return { ok: true, value: null };
  let names: Map<string, { label: string }> | null = null;
  if (allowed.insider && deps.people && result.value.members.length) {
    try {
      names = await deps.people.find(result.value.members.map((m) => m.member_id));
    } catch (error) {
      console.error("[space-trips] traveler names unavailable", (error as Error).message);
    }
  }
  return { ok: true, value: project(result.value, allowed.insider, names, deps) };
}
