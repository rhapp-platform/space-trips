/**
 * The operations behind `rhap trips`. The gateway (my-rhapp-app) verifies the
 * caller, confirms the account owns the space or is a delegated admin, and
 * calls these over a service binding with the space name and an actor.
 * Nothing here trusts request input for either.
 *
 * The CLI speaks in trip *documents*: a trip's fields, its itinerary items and
 * its travelers, shaped like the TOML file a person edits. Every write maps
 * the document onto the same flat form the HTML admin posts and validates it
 * with the same rules (rules.ts), so a file can't hold anything the form
 * couldn't.
 *
 * `apply` is a plan, then a write. The dry run returns the plan and a hash of
 * it; the write recomputes the plan and refuses if the hash differs, so what
 * the person confirmed is what happens.
 */
import { KINDS, kindOf, readDetails, type Kind } from "./kinds";
import type { Contact, People } from "./people";
import {
  IMAGE_REVISION, IMAGE_TAG, MEMBER_ROLES, STATUSES, TRP, TSEG, VISIBILITIES,
  newId, segmentWrite, tripWrite, type Form, type Say,
} from "./rules";
import { outsideTrip } from "./time";
import type { MemberRow, SegmentRow, TripDetail, TripRow, TripsResult } from "./types";

export type CliResult = { ok: true; value: unknown } | { ok: false; status: number; message: string };

export interface CliDeps {
  call<T>(op: string, args?: unknown[]): Promise<TripsResult<T>>;
  people: People | null;
}

/** One itinerary item as the file writes it: every value is text. */
export type FileItem = Record<string, string>;

export interface FileTraveler {
  member: string;
  role?: string;
}

export interface TripDocument {
  id?: string;
  title?: string;
  /** The cover's image tag in the space library. */
  cover?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  visibility?: string;
  item?: FileItem[];
  traveler?: FileTraveler[];
}

const no = (status: number, message: string): CliResult => ({ ok: false, status, message });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const FILE_SAY: Say = {
  date: "Write it as year-month-day, like 2027-03-14.",
  dateTime: "Write it as a date and a 24-hour time, like 2027-03-14T08:05.",
  status: `status must be ${STATUSES.map(([v]) => v).join(", ")}.`,
  visibility: `visibility must be ${VISIBILITIES.map(([v]) => v).join(", ")}.`,
};

// ── The file's shape, from kinds.ts ─────────────────────────────────────────

const TRIP_KEYS = ["id", "title", "description", "start_date", "end_date", "status", "visibility", "cover", "item", "traveler"];
const COMMON_ITEM_KEYS = ["id", "kind", "name", "start", "start_tz", "end", "end_tz", "confirmation", "notes", "image"];

/** The file key for a kind's location column: "Address" → "address", "Pick-up place" → "pick_up_place". */
export function locationKey(kind: Kind): string | null {
  return kind.location ? kind.location.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") : null;
}

function itemKeys(kind: Kind): string[] {
  const loc = locationKey(kind);
  return [...COMMON_ITEM_KEYS.slice(0, 7), ...(loc ? [loc] : []), ...kind.details.map((f) => f.key), ...COMMON_ITEM_KEYS.slice(7)];
}

/**
 * The kind as the file names its fields, so a refusal says “end is before
 * start” rather than the form's “Arrives is before Departs”.
 */
function fileKind(kind: Kind): Kind {
  return {
    ...kind,
    start: "start",
    end: "end",
    location: locationKey(kind),
    details: kind.details.map((f) => ({ ...f, label: f.key })),
  };
}

/** What `rhap trips kinds` shows, and what `--help` and the export template draw on. */
export function describeKinds() {
  return KINDS.map((k) => ({
    kind: k.type,
    name: k.name,
    example: k.example,
    start: k.start,
    end: k.end,
    location: locationKey(k),
    location_label: k.location,
    fields: k.details.map((f) => ({ key: f.key, label: f.label, hint: f.hint ?? null, private: f.private === true })),
  }));
}

// ── Document ⇄ form ─────────────────────────────────────────────────────────

/** Describes an item in a message: “Item 3 (Hotel Monaco)”. */
function itemName(n: number, item: FileItem | SegmentRow): string {
  const name = "label" in item ? item.label : item.name;
  return name ? `Item ${n} (${name})` : `Item ${n}`;
}

function strings(value: unknown, where: string, errors: string[]): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${where} must be a set of fields.`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v !== "string") {
      errors.push(`${where}: put “${key}” in quotes, like ${key} = "${String(v)}".`);
      continue;
    }
    out[key] = v.trim();
  }
  return out;
}

/**
 * Images are named by their tag in the space library. The web picker freezes
 * ("pins") the chosen picture and posts its tag and revision; the CLI does the
 * same with `rhap images pin`, which is also what proves the tag exists. So a
 * new tag needs its revision from the caller: until it has one, the plan lists
 * the tag under `needs` and leaves the image as it is.
 */
interface ImageContext {
  gn: string;
  revisions: Record<string, string>;
  needs: Set<string>;
  errors: string[];
}

/**
 * The picker's `imageSelection` for a file's tag: "" keeps, "null" removes.
 * The tag it already shows is no change, so re-applying an export never
 * re-freezes a picture. A single change that names the picture (`refresh`,
 * with the stored revision) does take a newer frozen revision of the same tag:
 * that's how a replaced library picture reaches the trip.
 */
function imageSelection(
  tag: string | undefined, current: string | null | undefined, field: string, where: string, ctx: ImageContext,
  refresh?: { revision: string | null | undefined },
): string {
  if (tag === undefined) return "";
  if (tag === "") return current ? "null" : "";
  if (!IMAGE_TAG.test(tag)) {
    ctx.errors.push(`${where}: ${field} “${tag}” isn't an image name. Names are lowercase letters, digits and hyphens. See the live ones with: rhap images list --live`);
    return "";
  }
  const revision = ctx.revisions[tag];
  if (tag === current && !(refresh && revision && revision !== refresh.revision)) return "";
  if (!revision) {
    ctx.needs.add(tag);
    return "";
  }
  return JSON.stringify({ space: ctx.gn, tag, revision });
}

/** The form the admin would post for this item, or an error. */
function itemForm(item: FileItem, kind: Kind, imageSelection = ""): Form {
  const loc = locationKey(kind);
  return {
    label: item.name ?? "",
    start_at: item.start ?? "",
    end_at: item.end ?? "",
    start_tz: item.start_tz ?? "",
    end_tz: item.end_tz ?? "",
    location: loc ? (item[loc] ?? "") : "",
    confirmation_ref: item.confirmation ?? "",
    notes: item.notes ?? "",
    imageSelection,
    ...Object.fromEntries(kind.details.map((f) => [`d_${f.key}`, item[f.key] ?? ""])),
  };
}

/** An item as the file writes it: only the fields that have a value. */
export function fileItem(seg: SegmentRow): FileItem {
  const kind = kindOf(seg.type);
  const details = readDetails(seg.details);
  const loc = kind ? locationKey(kind) : null;
  const out: FileItem = { id: seg.id, kind: seg.type, name: seg.label };
  const put = (key: string, value: string | null | undefined) => {
    if (value) out[key] = value;
  };
  put("start", seg.start_at);
  put("start_tz", details.start_tz);
  put("end", seg.end_at);
  put("end_tz", details.end_tz);
  if (loc) put(loc, seg.location);
  for (const f of kind?.details ?? []) put(f.key, details[f.key]);
  put("confirmation", seg.confirmation_ref);
  put("notes", seg.notes);
  put("image", seg.image_tag);
  return out;
}

function tripForm(doc: TripDocument, current: TripRow | null, imageSelection = ""): Form {
  return {
    title: doc.title ?? "",
    description: doc.description ?? "",
    start_date: doc.start_date ?? "",
    end_date: doc.end_date ?? "",
    // Required by the form; a file that leaves them out keeps what's there.
    status: doc.status || current?.status || "draft",
    visibility: doc.visibility || current?.visibility || "members",
    imageSelection,
  };
}

// ── Reading the trip ────────────────────────────────────────────────────────

async function tripList(deps: CliDeps, gn: string): Promise<TripRow[] | CliResult> {
  const r = await deps.call<TripRow[]>("list", [gn]);
  return r.ok ? r.value : r;
}

/** A trip by its id, or by its exact title when only one trip has it. */
async function findTrip(deps: CliDeps, gn: string, ref: string): Promise<TripDetail | CliResult> {
  const value = ref.trim();
  if (!value) return no(400, "Say which trip, by its id or its title. See them with: rhap trips list");
  let id = value;
  if (!TRP.test(value)) {
    const trips = await tripList(deps, gn);
    if (!Array.isArray(trips)) return trips;
    const matches = trips.filter((t) => t.gn === gn && t.title.toLowerCase() === value.toLowerCase());
    if (!matches.length) return no(404, `No trip is called “${value}”. See the trips with: rhap trips list`);
    if (matches.length > 1) return no(409, `${matches.length} trips are called “${value}”. Use the trip's id instead: ${matches.map((t) => t.id).join(", ")}`);
    id = matches[0]!.id;
  }
  const r = await deps.call<TripDetail | null>("get", [id]);
  if (!r.ok) return r;
  if (!r.value || r.value.trip.gn !== gn) return no(404, `There is no trip ${id} in this space.`);
  return r.value;
}

const isDetail = (v: TripDetail | CliResult): v is TripDetail => "trip" in v;

async function contacts(deps: CliDeps, members: MemberRow[]): Promise<Map<string, Contact>> {
  if (!deps.people || !members.length) return new Map();
  try {
    return await deps.people.contacts(members.map((m) => m.member_id));
  } catch (error) {
    console.error("[trips-cli] member contacts unavailable", (error as Error).message);
    return new Map();
  }
}

/** How a traveler is written in a file: email when known, then username, then the member ID. */
function memberRef(id: string, known: Map<string, Contact>): string {
  const c = known.get(id);
  return c?.email ?? c?.username ?? id;
}

export async function tripDocument(deps: CliDeps, detail: TripDetail) {
  const { trip, segments, members } = detail;
  const known = await contacts(deps, members);
  const put = <T extends object>(o: T, key: keyof T, value: string | null | undefined) => {
    if (value) (o as Record<string, string>)[key as string] = value;
  };
  const document: TripDocument = { id: trip.id, title: trip.title };
  put(document, "description", trip.description);
  put(document, "start_date", trip.start_date);
  put(document, "end_date", trip.end_date);
  document.status = trip.status;
  document.visibility = trip.visibility;
  put(document, "cover", trip.cover_tag);
  document.item = segments.map(fileItem);
  document.traveler = members.map((m) => ({ member: memberRef(m.member_id, known), role: m.role }));
  return {
    document,
    travelers: members.map((m) => ({ member: memberRef(m.member_id, known), name: known.get(m.member_id)?.label ?? null, role: m.role })),
    hints: segments.flatMap((seg, i) => {
      const h = outsideTrip(trip, seg);
      return h ? [`${itemName(i + 1, seg)}: ${h}`] : [];
    }),
  };
}

// ── The plan ────────────────────────────────────────────────────────────────

type Step =
  | { op: "create-trip"; title: string; write: Record<string, unknown> }
  | { op: "update-trip"; changes: string[]; write: Record<string, unknown> }
  | { op: "add-item"; item: string; write: Record<string, unknown> }
  | { op: "update-item"; id: string; item: string; changes: string[]; write: Record<string, unknown> }
  | { op: "remove-item"; id: string; item: string }
  | { op: "set-traveler"; member_id: string; member: string; role: string; was: string | null }
  | { op: "remove-traveler"; member_id: string; member: string };

interface Plan {
  steps: Step[];
  /** Items and travelers on the trip but not in the file, left alone without --prune. */
  kept: string[];
  hints: string[];
  errors: string[];
  /** Image tags the file sets that have no revision yet: pin them, then plan again. */
  needs: string[];
  current: TripDetail | null;
}

const TRIP_FIELDS = ["title", "description", "start_date", "end_date", "status", "visibility"] as const;

/**
 * A planned image change. The write carries the picture only when imageSelection
 * chose one, so a write of the same tag means a refreshed revision.
 */
const imageChanged = (write: Record<string, unknown>, [tagKey, revisionKey]: [string, string], stored: { tag?: string | null; revision?: string | null }) =>
  tagKey in write && (!same(write[tagKey], stored.tag) || !same(write[revisionKey], stored.revision));

/** Text the same whether a value is missing or empty. */
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (!a && !b);

function sameDetails(write: unknown, stored: string | null | undefined): boolean {
  const a = (write ?? {}) as Record<string, string>;
  const b = readDetails(stored);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => same(a[k], b[k]));
}

/** The fields a segment write would change, by their file names. */
function itemChanges(write: Record<string, unknown>, seg: SegmentRow, kind: Kind): string[] {
  const changes: string[] = [];
  const loc = locationKey(kind);
  if (!same(write.label, seg.label)) changes.push("name");
  if (!same(write.start_at, seg.start_at)) changes.push("start");
  if (!same(write.end_at, seg.end_at)) changes.push("end");
  if (loc && "location" in write && !same(write.location, seg.location)) changes.push(loc);
  if (!same(write.confirmation_ref, seg.confirmation_ref)) changes.push("confirmation");
  if (!same(write.notes, seg.notes)) changes.push("notes");
  if (imageChanged(write, ["image_tag", "image_revision"], { tag: seg.image_tag, revision: seg.image_revision })) changes.push("image");
  if (!sameDetails(write.details, seg.details)) {
    const a = (write.details ?? {}) as Record<string, string>;
    const b = readDetails(seg.details);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[k], b[k])) changes.push(k);
  }
  if ("position" in write && write.position !== seg.position) changes.push("order");
  return changes;
}

async function resolveTraveler(deps: CliDeps, ref: string, onTrip: MemberRow[], known: Map<string, Contact>): Promise<string | null | "unavailable"> {
  // Someone already on the trip, named the way an export names them.
  const already = onTrip.find((m) => m.member_id === ref || memberRef(m.member_id, known).toLowerCase() === ref.toLowerCase());
  if (already) return already.member_id;
  // Without the member list nothing can be checked, so nothing new is taken on
  // trust: an email typed here would otherwise be stored as a member ID.
  if (!deps.people) return "unavailable";
  try {
    return (await deps.people.resolve(ref))?.id ?? null;
  } catch {
    return "unavailable";
  }
}

/** Which pictures a single change names, so a newer revision of the same tag counts (see imageSelection). */
interface Refresh {
  cover?: boolean;
  item?: string;
}

async function buildPlan(deps: CliDeps, gn: string, raw: unknown, options: { prune: boolean; allowNew: boolean; revisions?: Record<string, string>; refresh?: Refresh }): Promise<Plan> {
  const plan: Plan = { steps: [], kept: [], hints: [], errors: [], needs: [], current: null };
  const errors = plan.errors;
  const images: ImageContext = { gn, revisions: options.revisions ?? {}, needs: new Set(), errors };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("The trip file could not be read as a trip.");
    return plan;
  }
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!TRIP_KEYS.includes(key)) errors.push(`“${key}” isn't a trip field. A trip takes: ${TRIP_KEYS.filter((k) => k !== "item" && k !== "traveler").join(", ")}, then [[item]] and [[traveler]] blocks.`);
  }
  const header = strings(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "item" && k !== "traveler")), "The trip", errors) ?? {};

  // Which trip: the file's id, or a new one.
  let current: TripDetail | null = null;
  if (header.id) {
    if (!TRP.test(header.id)) {
      errors.push(`The trip id “${header.id}” isn't one this space uses. Remove the id line to create a new trip.`);
      return plan;
    }
    const found = await findTrip(deps, gn, header.id);
    if (!isDetail(found)) {
      if (found.ok === false && found.status === 404) errors.push(`There is no trip ${header.id} in this space. Remove the id line to create it as a new trip.`);
      else if (found.ok === false) errors.push(found.message);
      return plan;
    }
    current = found;
  } else if (!options.allowNew && header.title) {
    const trips = await tripList(deps, gn);
    if (!Array.isArray(trips)) {
      errors.push((trips as { message: string }).message);
      return plan;
    }
    const twin = trips.find((t) => t.gn === gn && t.title.toLowerCase() === header.title!.toLowerCase());
    if (twin) {
      errors.push(`A trip called “${twin.title}” already exists (${twin.id}). To change it, add  id = "${twin.id}"  to the file. To make another trip with the same name, pass --new.`);
      return plan;
    }
  }
  plan.current = current;

  // The trip's own fields.
  const cover = imageSelection(header.cover, current?.trip.cover_tag, "cover", "The trip", images,
    options.refresh?.cover && current ? { revision: current.trip.cover_revision } : undefined);
  const trip = tripWrite(tripForm(header as TripDocument, current?.trip ?? null, cover), gn, FILE_SAY);
  if (!trip.write) errors.push(trip.error!);
  else if (!current) plan.steps.push({ op: "create-trip", title: String(trip.write.title), write: trip.write });
  else {
    const changes: string[] = TRIP_FIELDS.filter((f) => !same(trip.write![f], current!.trip[f]));
    if (imageChanged(trip.write, ["cover_tag", "cover_revision"], { tag: current.trip.cover_tag, revision: current.trip.cover_revision })) changes.push("cover");
    if (changes.length) plan.steps.push({ op: "update-trip", changes, write: trip.write });
  }

  // Itinerary items, in file order.
  const items = doc.item === undefined ? [] : doc.item;
  if (!Array.isArray(items)) errors.push("Write itinerary items as [[item]] blocks.");
  const segments = current?.segments ?? [];
  const claimed = new Set<string>();
  // Ids the file names are spoken for: an item without an id never matches one.
  const named = new Set((Array.isArray(items) ? items : []).map((it) => text(object(it).id)).filter(Boolean));
  const matched: { n: number; seg: SegmentRow | undefined; kind: Kind; where: string; write: Record<string, unknown> }[] = [];
  const tripDates = { start_date: (trip.write?.start_date as string | null) ?? null, end_date: (trip.write?.end_date as string | null) ?? null };
  (Array.isArray(items) ? items : []).forEach((rawItem, i) => {
    const n = i + 1;
    const item = strings(rawItem, `Item ${n}`, errors);
    if (!item) return;
    const where = itemName(n, item);
    let seg: SegmentRow | undefined;
    if (item.id) {
      seg = TSEG.test(item.id) ? segments.find((s) => s.id === item.id) : undefined;
      if (!seg) return void errors.push(`${where}: the id ${item.id} isn't an item on this trip. Remove the id line to add it as a new item.`);
      if (claimed.has(seg.id)) return void errors.push(`${where}: the id ${item.id} is used by an earlier item too. Each item needs its own id, or none.`);
    }
    const type = item.kind || seg?.type || "";
    const kind = seg ? kindOf(seg.type) : KINDS.find((k) => k.type === type);
    if (!kind) return void errors.push(`${where}: kind must be ${KINDS.map((k) => k.type).join(", ")}.`);
    if (seg && type !== seg.type) return void errors.push(`${where}: this item is a ${seg.type}, and an item's kind can't change. To make it a ${type}, remove its id line (it's added as a new item) and remove the old one.`);
    const allowed = itemKeys(kind);
    const unknown = Object.keys(item).filter((k) => !allowed.includes(k));
    if (unknown.length) return void errors.push(`${where}: ${unknown.map((k) => `“${k}”`).join(", ")} ${unknown.length === 1 ? "isn't a field" : "aren't fields"} of a ${kind.type}. A ${kind.type} takes: ${allowed.join(", ")}.`);
    // The stored item this one will match (below, by kind + name + start when it has no id), for its image.
    const twin = seg ?? segments.find((s) => !claimed.has(s.id) && !named.has(s.id) && s.type === kind.type &&
      s.label.toLowerCase() === (item.name ?? "").toLowerCase() && same(s.start_at, item.start || null));
    const image = imageSelection(item.image, twin?.image_tag, "image", where, images,
      twin && options.refresh?.item === twin.id ? { revision: twin.image_revision } : undefined);
    const result = segmentWrite(itemForm(item, kind, image), fileKind(kind), gn, FILE_SAY);
    if (!result.write) return void errors.push(`${where}: ${result.error}`);
    const write = result.write;
    // An item without an id is the same one as a stored item of the same kind, name and start.
    if (!seg) {
      seg = segments.find((s) => !claimed.has(s.id) && !named.has(s.id) && s.type === kind.type && s.label.toLowerCase() === String(write.label).toLowerCase() && same(s.start_at, write.start_at));
    }
    const hint = outsideTrip(tripDates, { start_at: (write.start_at as string | null) ?? null, end_at: (write.end_at as string | null) ?? null });
    if (hint) plan.hints.push(`${where}: ${hint}`);
    if (seg) claimed.add(seg.id);
    matched.push({ n, seg, kind, where, write });
  });
  // Positions are written only when the order changes: stored items in their
  // stored order, with new ones after them, leaves every position alone.
  const stored = matched.filter((m) => m.seg).map((m) => m.seg!.position);
  const firstNew = matched.findIndex((m) => !m.seg);
  const reorder = stored.some((p, i) => i > 0 && p < stored[i - 1]!) || (firstNew >= 0 && matched.slice(firstNew).some((m) => m.seg));
  const adds: Step[] = [];
  const updates: Step[] = [];
  matched.forEach((m, i) => {
    const write = reorder ? { ...m.write, position: i } : m.write;
    if (!m.seg) return void adds.push({ op: "add-item", item: m.where, write });
    const changes = itemChanges(write, m.seg, m.kind);
    if (changes.length) updates.push({ op: "update-item", id: m.seg.id, item: m.where, changes, write });
  });
  plan.steps.push(...updates, ...adds);
  for (const seg of segments.filter((s) => !claimed.has(s.id))) {
    const where = `${kindOf(seg.type)?.name ?? seg.type} “${seg.label}”`;
    if (options.prune) plan.steps.push({ op: "remove-item", id: seg.id, item: where });
    else plan.kept.push(where);
  }

  // Travelers.
  const travelers = doc.traveler === undefined ? [] : doc.traveler;
  if (!Array.isArray(travelers)) errors.push("Write travelers as [[traveler]] blocks.");
  const members = current?.members ?? [];
  const known = await contacts(deps, members);
  const listed = new Set<string>();
  for (const [i, rawTraveler] of (Array.isArray(travelers) ? travelers : []).entries()) {
    const n = i + 1;
    const t = strings(rawTraveler, `Traveler ${n}`, errors);
    if (!t) continue;
    const extra = Object.keys(t).filter((k) => k !== "member" && k !== "role");
    if (extra.length) {
      errors.push(`Traveler ${n}: ${extra.map((k) => `“${k}”`).join(", ")} isn't a traveler field. A traveler takes: member, role.`);
      continue;
    }
    if (!t.member) {
      errors.push(`Traveler ${n}: say who, with  member = "their email"  (or their username).`);
      continue;
    }
    const role = t.role || "traveler";
    if (!MEMBER_ROLES.some(([v]) => v === role)) {
      errors.push(`Traveler ${n} (${t.member}): role must be ${MEMBER_ROLES.map(([v]) => v).join(", ")}.`);
      continue;
    }
    const id = await resolveTraveler(deps, t.member, members, known);
    if (id === "unavailable") {
      errors.push(`Traveler ${n} (${t.member}): the member list can't be searched right now. Try again in a moment.`);
      continue;
    }
    if (!id) {
      errors.push(`Traveler ${n}: no active member of this space has the email or username “${t.member}”.`);
      continue;
    }
    if (listed.has(id)) {
      errors.push(`Traveler ${n} (${t.member}) is listed twice. Keep one of them.`);
      continue;
    }
    listed.add(id);
    const was = members.find((m) => m.member_id === id)?.role ?? null;
    if (was !== role) plan.steps.push({ op: "set-traveler", member_id: id, member: t.member, role, was });
  }
  for (const m of members.filter((m) => !listed.has(m.member_id))) {
    const who = memberRef(m.member_id, known);
    if (options.prune) plan.steps.push({ op: "remove-traveler", member_id: m.member_id, member: who });
    else plan.kept.push(`traveler ${who}`);
  }
  plan.needs = [...images.needs].sort();
  return plan;
}

async function planHash(plan: Plan): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ trip: plan.current?.trip.id ?? null, steps: plan.steps }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** The plan as the CLI shows it: no write payloads, which hold private details. */
function shownPlan(plan: Plan) {
  return {
    trip: plan.current ? { id: plan.current.trip.id, title: plan.current.trip.title } : null,
    steps: plan.steps.map((s) => {
      switch (s.op) {
        case "create-trip": return { op: s.op, what: s.title };
        case "update-trip": return { op: s.op, what: "trip", changes: s.changes };
        case "add-item": return { op: s.op, what: s.item };
        case "update-item": return { op: s.op, what: s.item, changes: s.changes };
        case "remove-item": return { op: s.op, what: s.item };
        case "set-traveler": return { op: s.op, what: s.member, role: s.role, was: s.was };
        case "remove-traveler": return { op: s.op, what: s.member };
      }
    }),
    kept: plan.kept,
    hints: plan.hints,
  };
}

/** Run a plan's steps in order. A failure stops it and says how far it got; running again finishes the rest. */
async function runPlan(deps: CliDeps, gn: string, actor: string, plan: Plan): Promise<CliResult> {
  let tripId = plan.current?.trip.id ?? "";
  let done = 0;
  // Once the trip exists, a run of the same file would find it by title and
  // refuse; finishing needs the file to name the new trip by its id.
  const created = () => !plan.current && done > 0;
  const stop = (r: { status: number; message: string }) =>
    no(r.status, !done
      ? r.message
      : created()
        ? `Stopped after ${plural(done, "change")} of ${plan.steps.length}: ${r.message} The trip was created as ${tripId}. To finish, add  id = "${tripId}"  at the top of the file and run the same command again; it shows only what is left.`
        : `Stopped after ${plural(done, "change")} of ${plan.steps.length}: ${r.message} Run the same command again to finish; it shows only what is left.`);
  for (const step of plan.steps) {
    let r: TripsResult<unknown>;
    switch (step.op) {
      case "create-trip": {
        tripId = newId("trp_");
        r = await deps.call("create", [tripId, gn, step.write, actor]);
        // The store makes the creator the trip's owner. The CLI's actor is an
        // account, not a member of the space: the file says who is on the trip.
        if (r.ok) {
          const removed = await deps.call("removeMember", [tripId, actor]);
          if (!removed.ok) console.error(`[trips-cli] could not drop the creating account from ${tripId}`, removed.message);
        }
        break;
      }
      case "update-trip": r = await deps.call("update", [tripId, step.write, actor]); break;
      case "add-item": r = await deps.call("addSegment", [newId("tseg_"), tripId, step.write]); break;
      case "update-item": r = await deps.call("updateSegment", [step.id, step.write]); break;
      case "remove-item": r = await deps.call("removeSegment", [step.id]); break;
      case "set-traveler": r = await deps.call("setMember", [tripId, step.member_id, step.role]); break;
      case "remove-traveler": r = await deps.call("removeMember", [tripId, step.member_id]); break;
    }
    if (!r.ok) return stop(r);
    done++;
  }
  return { ok: true, value: { id: tripId, changes: done } };
}

async function applyDocument(
  deps: CliDeps, gn: string, actor: string, doc: unknown,
  options: { prune: boolean; allowNew: boolean; dryRun: boolean; expect?: string; revisions?: Record<string, string>; refresh?: Refresh },
): Promise<CliResult> {
  const plan = await buildPlan(deps, gn, doc, options);
  if (plan.errors.length) {
    const n = plan.errors.length;
    return no(400, `${n === 1 ? "One thing needs" : `${n} things need`} fixing before anything is saved:\n  - ${plan.errors.join("\n  - ")}`);
  }
  const hash = await planHash(plan);
  if (options.dryRun) return { ok: true, value: { plan: shownPlan(plan), hash, needs: plan.needs } };
  // The CLI pins every needed tag before it writes; reaching here without one is a caller bug.
  if (plan.needs.length) return no(400, `Freeze these images first, with rhap images pin: ${plan.needs.join(", ")}.`);
  if (options.expect !== undefined && options.expect !== hash) {
    return no(409, "The trip changed after you looked at the plan, so nothing was saved. Run the command again to see the new plan.");
  }
  if (!plan.steps.length) return { ok: true, value: { id: plan.current?.trip.id ?? null, changes: 0 } };
  return runPlan(deps, gn, actor, plan);
}

// ── Operations ──────────────────────────────────────────────────────────────

/** An item on the trip by its id, or by its number in the itinerary (1 is the first). */
function findItem(detail: TripDetail, ref: string): SegmentRow | CliResult {
  const value = ref.trim();
  const byNumber = /^\d+$/.test(value) ? detail.segments[Number(value) - 1] : undefined;
  const seg = byNumber ?? detail.segments.find((s) => s.id === value);
  return seg ?? no(404, `This trip has no item “${value}”. Items are numbered from 1; see them with: rhap trips show ${detail.trip.id}`);
}

/**
 * A field-by-field change on top of what's stored: empty text clears a field.
 * An image's "" stays in, because in a document a missing image means "keep".
 */
function merged<T extends object>(base: T, set: Record<string, unknown>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(set)) {
    if ((k === "image" || k === "cover") && (v === "" || v === null)) out[k] = "";
    else if (v === "" || v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** Revisions the CLI pinned, by tag. Anything not shaped like one is dropped. */
function revisionsOf(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).filter(([tag, rev]) => IMAGE_TAG.test(tag) && typeof rev === "string" && IMAGE_REVISION.test(rev)),
  ) as Record<string, string>;
}

export async function cliOp(deps: CliDeps, gn: string, actor: string, op: string, input: Record<string, unknown> = {}): Promise<CliResult> {
  if (op === "kinds") return { ok: true, value: { kinds: describeKinds() } };

  if (op === "list") {
    const trips = await tripList(deps, gn);
    if (!Array.isArray(trips)) return trips;
    return {
      ok: true,
      value: {
        trips: trips.filter((t) => t.gn === gn).map((t) => ({
          id: t.id, title: t.title, status: t.status, visibility: t.visibility, start_date: t.start_date, end_date: t.end_date,
        })),
      },
    };
  }

  if (op === "apply") {
    return applyDocument(deps, gn, actor, input.document, {
      prune: input.prune === true,
      allowNew: input.new === true,
      dryRun: input.dryRun === true,
      expect: typeof input.expect === "string" ? input.expect : undefined,
      revisions: revisionsOf(input.revisions),
    });
  }

  if (op === "create") {
    const doc = { ...object(input.trip) };
    delete doc.id;
    return applyDocument(deps, gn, actor, doc, { prune: false, allowNew: input.new === true, dryRun: false, revisions: revisionsOf(input.revisions) });
  }

  // Everything else acts on one trip.
  const found = await findTrip(deps, gn, text(input.trip));
  if (!isDetail(found)) return found;
  const detail = found;
  const { document } = await tripDocument(deps, detail);
  const header = { ...document };
  delete header.item;
  delete header.traveler;

  switch (op) {
    case "show":
      return { ok: true, value: await tripDocument(deps, detail) };

    case "edit": {
      const set = object(input.set);
      if ("id" in set) return no(400, "A trip's id can't change.");
      return applyDocument(deps, gn, actor, merged(header, set), {
        prune: false, allowNew: false, dryRun: false, revisions: revisionsOf(input.revisions), refresh: { cover: "cover" in set },
      });
    }

    case "delete": {
      const r = await deps.call<{ deleted: boolean }>("delete", [detail.trip.id, actor]);
      if (!r.ok) return r;
      return r.value.deleted
        ? { ok: true, value: { id: detail.trip.id, title: detail.trip.title, items: detail.segments.length, travelers: detail.members.length } }
        : no(404, `There is no trip ${detail.trip.id} in this space.`);
    }

    case "item-add": {
      const item = { ...object(input.item) };
      delete item.id;
      // Added at the end: the plan only adds, and keeps everything already there.
      const items = [...(document.item ?? []), item as FileItem];
      return applyDocument(deps, gn, actor, { ...header, item: items }, { prune: false, allowNew: false, dryRun: false, revisions: revisionsOf(input.revisions) });
    }

    case "item-edit": {
      const seg = findItem(detail, text(input.item));
      if (!("id" in seg)) return seg;
      const set = object(input.set);
      if ("id" in set || ("kind" in set && set.kind !== seg.type)) {
        return no(400, "An item's kind can't change. Add a new item of the other kind and remove this one.");
      }
      const items = (document.item ?? []).map((it) => (it.id === seg.id ? merged(it, set) : it));
      return applyDocument(deps, gn, actor, { ...header, item: items }, {
        prune: false, allowNew: false, dryRun: false, revisions: revisionsOf(input.revisions), refresh: { item: "image" in set ? seg.id : undefined },
      });
    }

    case "item-remove": {
      const seg = findItem(detail, text(input.item));
      if (!("id" in seg)) return seg;
      const r = await deps.call("removeSegment", [seg.id]);
      return r.ok ? { ok: true, value: { removed: seg.label } } : r;
    }

    case "traveler-add":
    case "traveler-remove": {
      const ref = text(input.member);
      if (!ref) return no(400, "Say who, by their email or username.");
      const known = await contacts(deps, detail.members);
      const id = await resolveTraveler(deps, ref, detail.members, known);
      if (id === "unavailable") return no(503, "The member list can't be searched right now. Try again in a moment.");
      if (op === "traveler-remove") {
        if (!id || !detail.members.some((m) => m.member_id === id)) {
          return input.ifExists === true ? { ok: true, value: { removed: 0 } } : no(404, `“${ref}” isn't on this trip.`);
        }
        const r = await deps.call("removeMember", [detail.trip.id, id]);
        return r.ok ? { ok: true, value: { removed: 1 } } : r;
      }
      if (!id) return no(400, `No active member of this space has the email or username “${ref}”.`);
      const role = text(input.role) || "traveler";
      if (!MEMBER_ROLES.some(([v]) => v === role)) return no(400, `role must be ${MEMBER_ROLES.map(([v]) => v).join(", ")}.`);
      const r = await deps.call<MemberRow>("setMember", [detail.trip.id, id, role]);
      return r.ok ? { ok: true, value: { member: ref, role } } : r;
    }
  }
  return no(400, "That trips command does not exist.");
}
