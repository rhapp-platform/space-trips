/**
 * Item times are wall-clock times at the place ("2026-10-03T14:05"), as a
 * datetime-local field gives them. A time zone, when someone chose one, is kept
 * beside each time in `details` (start_tz, end_tz): a flight leaves in one zone
 * and lands in another. Without a zone a time is shown exactly as entered.
 */
import { validSpaceTimezone } from "../../kv/types/space-geo";

export const ZONE_MAX = 100;

/** The zone's canonical name ("europe/rome" → "Europe/Rome"), or null if it isn't one. */
export function canonicalZone(value: string): string | null {
  const zone = value.trim();
  if (!validSpaceTimezone(zone)) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
}

/** Every zone name the runtime knows, for the form's suggestions. */
export function zoneNames(): string[] {
  return (Intl as unknown as { supportedValuesOf(key: "timeZone"): string[] }).supportedValuesOf("timeZone");
}

/** How far `zone` is ahead of UTC at the moment `at`, in milliseconds. */
function offset(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at / 1000) * 1000;
}

/** The moment a wall-clock time in `zone` happens, as epoch milliseconds. */
export function instant(wall: string, zone: string): number {
  const [date, time] = wall.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const [h, min] = time!.split(":").map(Number);
  const asUtc = Date.UTC(y!, m! - 1, d!, h!, min!);
  // Two passes: the first guess can land on the other side of a DST change.
  return asUtc - offset(zone, asUtc - offset(zone, asUtc));
}

/** "Rome, GMT+2": the place in the zone's name and its offset on that date. */
export function zoneLabel(wall: string, zone: string): string {
  const place = zone.split("/").pop()!.replace(/_/g, " ");
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(instant(wall, zone))
    .find((p) => p.type === "timeZoneName")?.value;
  return name && name !== place ? `${place}, ${name}` : place;
}

/** A time for people to read, with its zone when one was chosen. */
export function when(wall: string | null | undefined, zone?: string | null): string {
  if (!wall) return "";
  const text = wall.replace("T", " ");
  return zone ? `${text} (${zoneLabel(wall, zone)})` : text;
}

/**
 * Whether the end comes before the start. A missing zone is taken to be the
 * other one's; with no zones at all the wall clocks are compared, as before.
 */
export function endsBeforeStart(start: string, startZone: string | null, end: string, endZone: string | null): boolean {
  const a = startZone ?? endZone, b = endZone ?? startZone;
  return a && b ? instant(end, b) < instant(start, a) : end < start;
}

/**
 * A note when an item falls outside the trip's dates, or null. Dates are compared
 * as written: trip dates and item times are both local to where things happen.
 * It's a hint, not an error: a flight out the day before is ordinary.
 */
export function outsideTrip(
  trip: { start_date: string | null; end_date: string | null },
  item: { start_at: string | null; end_at: string | null },
): string | null {
  const first = (item.start_at ?? item.end_at)?.slice(0, 10);
  const last = (item.end_at ?? item.start_at)?.slice(0, 10);
  if (!first || !last) return null;
  if (trip.start_date && first < trip.start_date) return `This is before the trip starts on ${trip.start_date}. Check the date, or change the trip's dates.`;
  if (trip.end_date && last > trip.end_date) return `This is after the trip ends on ${trip.end_date}. Check the date, or change the trip's dates.`;
  return null;
}
