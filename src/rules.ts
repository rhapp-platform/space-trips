/**
 * The rules for what a trip, an itinerary item and a traveler may hold. The
 * HTML admin and the CLI entrypoint (cli.ts) both validate through here, so the
 * two can never disagree. Inputs are flat string forms, as a form post gives
 * them: the CLI maps its file fields onto the same names.
 */
import { DETAIL_MAX, type Kind } from "./kinds";
import { canonicalZone, endsBeforeStart } from "./time";
import type { MemberRow, TripRow } from "./types";

export type Form = Record<string, string>;

export const TRP = /^trp_[0-9A-Za-z]{26}$/;
export const TSEG = /^tseg_[0-9A-Za-z]{26}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export const STATUSES: [TripRow["status"], string][] = [
  ["draft", "Draft"],
  ["active", "Active"],
  ["archived", "Archived"],
];
export const VISIBILITIES: [TripRow["visibility"], string][] = [
  ["members", "Members of this space"],
  ["private", "Only people on this trip"],
  ["public", "Anyone, including visitors"],
];
export const IMAGE_TAG = /^[a-z][a-z0-9-]{0,79}$/;
export const IMAGE_REVISION = /^[a-f0-9]{64}$/;
export const MEMBER_ROLES: [MemberRow["role"], string][] = [
  ["traveler", "Traveler"],
  ["owner", "Owner"],
  ["viewer", "Viewer"],
];

export function newId(prefix: "trp_" | "tseg_"): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  // 248 = 4 × 62: rejecting bytes above it keeps every character equally likely.
  const out: string[] = [];
  while (out.length < 26) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && out.length < 26) out.push(alphabet[byte % 62]);
    }
  }
  return prefix + out.join("");
}

/** A store refusal the person can fix (bad input, conflict) versus an outage. */
export function fixable(status: number): boolean {
  return status === 400 || status === 409;
}

export const MEMBER_ID_MAX = 256;

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * How a refusal tells the person what to do. The checks are the same
 * everywhere; only the advice differs between a form and a file.
 */
export interface Say {
  date: string;
  dateTime: string;
  status: string;
  visibility: string;
}

export const FORM_SAY: Say = {
  date: "Pick it from the calendar.",
  dateTime: "Pick a date. Add a time if you know it.",
  status: "Choose a status from the list.",
  visibility: "Choose who can see this trip.",
};

export function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function tripWrite(form: Form, gn: string, say: Say = FORM_SAY): { write?: Record<string, unknown>; error?: string } {
  const title = form.title ?? "";
  if (!title) return { error: "Give the trip a name, like “Spring tour 2027”." };
  if (title.length > 200) return { error: "Keep the trip name to 200 characters or fewer." };
  const description = form.description ?? "";
  if (description.length > 4000) return { error: "Keep the description to 4,000 characters or fewer." };
  const start = form.start_date ?? "";
  const end = form.end_date ?? "";
  for (const [value, which] of [[start, "start"], [end, "end"]] as const) {
    if (value && !validDate(value)) return { error: `The ${which} date isn't a real date. ${say.date}` };
  }
  if (start && end && end < start) return { error: "The trip ends before it starts. Check the two dates." };
  if (!STATUSES.some(([v]) => v === form.status)) return { error: say.status };
  if (!VISIBILITIES.some(([v]) => v === form.visibility)) return { error: say.visibility };
  const cover = imageWrite(form.imageSelection, gn, ["cover_tag", "cover_revision"]);
  if (cover.error) return { error: cover.error };
  return {
    write: {
      ...cover.write,
      title,
      description: description || null,
      status: form.status,
      start_date: start || null,
      end_date: end || null,
      visibility: form.visibility,
    },
  };
}

/**
 * The picker's hidden field: empty = leave the image alone, `null` = remove
 * it, otherwise the chosen library image. Anything else is refused.
 */
export function imageWrite(
  raw: string | undefined,
  gn: string,
  [tagKey, revisionKey]: [string, string] = ["image_tag", "image_revision"],
): { write?: Record<string, unknown>; error?: string } {
  if (!raw) return { write: {} };
  let choice: unknown;
  try {
    choice = JSON.parse(raw);
  } catch {
    return { error: "Choose the image again." };
  }
  if (choice === null) return { write: { [tagKey]: null, [revisionKey]: null } };
  const { space, tag, revision } = (choice ?? {}) as Record<string, unknown>;
  if (space !== gn || typeof tag !== "string" || !IMAGE_TAG.test(tag)) return { error: "Choose an image from this space's library." };
  if (revision !== undefined && (typeof revision !== "string" || !IMAGE_REVISION.test(revision))) return { error: "Choose the image again." };
  return { write: { [tagKey]: tag, [revisionKey]: revision ?? null } };
}

export function segmentWrite(form: Form, kind: Kind, gn: string, say: Say = FORM_SAY): { write?: Record<string, unknown>; error?: string } {
  const itemLabel = form.label ?? "";
  if (!itemLabel) return { error: `Give this item a short name, like “${kind.example}”.` };
  if (itemLabel.length > 200) return { error: "Keep the name to 200 characters or fewer." };
  const start = form.start_at ?? "";
  const end = form.end_at ?? "";
  // A day without a time is fine: hotels and free days often have none.
  for (const [value, which] of [[start, kind.start], [end, kind.end]] as const) {
    if (value && !((DATETIME.test(value) && validDate(value.slice(0, 10))) || validDate(value))) {
      return { error: `“${which}” isn't complete. ${say.dateTime}` };
    }
  }
  const zones: (string | null)[] = [];
  for (const [value, which] of [[form.start_tz, kind.start], [form.end_tz, kind.end]] as const) {
    const zone = value?.trim() ? canonicalZone(value) : null;
    if (value?.trim() && !zone) return { error: `The time zone for “${which}” isn't one we recognise. Use a region and city, like “Europe/Rome” or “America/Chicago”.` };
    zones.push(zone);
  }
  // A zone describes a time of day, so it is kept only alongside one; a bare
  // day drops it (the form fills the zone in from the item before).
  const [startZone, endZone] = [start.includes("T") ? zones[0]! : null, end.includes("T") ? zones[1]! : null];
  if (start && end && endsBeforeStart(start, startZone, end, endZone)) {
    return { error: `“${kind.end}” is before “${kind.start}”. Check the two ${start.includes("T") && end.includes("T") ? "times" : "dates"}${startZone || endZone ? " and their time zones" : ""}.` };
  }
  const limits: [string, string, number][] = [
    ["confirmation_ref", "Confirmation number", 100],
    ["notes", "Notes", 4000],
    ...(kind.location ? [["location", kind.location, 300] as [string, string, number]] : []),
    ...kind.details.map((f) => [`d_${f.key}`, f.label, DETAIL_MAX] as [string, string, number]),
  ];
  for (const [key, name, max] of limits) {
    if ((form[key] ?? "").length > max) return { error: `Keep “${name}” to ${max.toLocaleString("en-US")} characters or fewer.` };
  }
  const image = imageWrite(form.imageSelection, gn);
  if (image.error) return { error: image.error };
  const details = Object.fromEntries(
    [...kind.details.map((f) => [f.key, form[`d_${f.key}`] ?? ""]), ["start_tz", startZone ?? ""], ["end_tz", endZone ?? ""]].filter(([, v]) => v),
  );
  return {
    write: {
      type: kind.type,
      label: itemLabel,
      start_at: start || null,
      end_at: end || null,
      // A kind without a location leaves any saved one alone.
      ...(kind.location ? { location: form.location || null } : {}),
      confirmation_ref: form.confirmation_ref || null,
      notes: form.notes || null,
      // null clears; it is also the only value a store below v34 accepts.
      details: Object.keys(details).length ? details : null,
      ...image.write,
    },
  };
}
