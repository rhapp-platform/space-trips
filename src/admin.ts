import { Hono, type Context } from "hono";
import {
  defineSurface,
  escapeHtml as esc,
  renderDocument,
  renderState,
} from "../../space-surface/src";
import type { ManagementArea } from "../../space-surface/src/management";
import { roleLevel } from "../../sets/sets/auth/shared/role-hierarchy";
import { IMAGE_PICKER_JS } from "../../home/src/generated/image-picker";
import { artworkUrl, imageField, imageLibraryRequest, IMAGE_FIELD_JS } from "../../home/src/image-field";
import { DETAIL_MAX, KINDS, kindOf, readDetails, shownDetails, type Kind } from "./kinds";
import { people, type People, type Person } from "./people";
import { callTrips } from "./trips";
import { scope, type Scope } from "./scope";
import { SURFACE } from "./surface";
import type { Env, MemberRow, SegmentRow, TripDetail, TripRow } from "./types";

export function canManageTrips(role: string | null): boolean {
  return role !== null && role !== "owner" && roleLevel(role) >= roleLevel("staff");
}

const ROOT = "/trips/admin";

/** The shared image field's script; the name carries a hash of its content (checked by a test). */
export const IMAGE_FIELD_PATH = `${ROOT}/image-field-aa3fffa95380.js`;

const ADMIN_SURFACE = defineSurface({
  ...SURFACE,
  // Only the image field: it finds its fieldset and does nothing on other pages.
  clientScript: true,
  clientScriptType: "module",
  clientScriptPath: IMAGE_FIELD_PATH,
  profiles: [],
  backLink: false,
  indexable: false,
  forms: true,
});

const MANAGEMENT: ManagementArea = "trips";

const TRP = /^trp_[0-9A-Za-z]{26}$/;
const TSEG = /^tseg_[0-9A-Za-z]{26}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const STATUSES: [TripRow["status"], string][] = [
  ["draft", "Draft"],
  ["active", "Active"],
  ["archived", "Archived"],
];
const VISIBILITIES: [TripRow["visibility"], string][] = [
  ["members", "Members of this space"],
  ["private", "Only people on this trip"],
  ["public", "Anyone, including visitors"],
];
const IMAGE_TAG = /^[a-z][a-z0-9-]{0,79}$/;
const IMAGE_REVISION = /^[a-f0-9]{64}$/;
const MEMBER_ROLES: [MemberRow["role"], string][] = [
  ["traveler", "Traveler"],
  ["owner", "Owner"],
  ["viewer", "Viewer"],
];

const DONE: Record<string, string> = {
  created: "Trip created. Add its itinerary and travelers below.",
  saved: "Trip saved.",
  "segment-added": "Added to the itinerary.",
  "segment-saved": "Itinerary item saved.",
  "segment-removed": "Removed from the itinerary.",
  "member-saved": "Traveler saved.",
  "member-removed": "Removed from the trip.",
  deleted: "Trip deleted.",
};

const CSS = `
:root{--wrap:720px}
.admin-title{font:700 clamp(26px,7vw,36px)/1.15 var(--heading);margin:0 0 12px;overflow-wrap:anywhere}
.admin-meta{color:var(--muted);margin:6px 0 18px;overflow-wrap:anywhere}
.admin-list{list-style:none;padding:0;display:grid;gap:12px}
.admin-card{display:block;border:1px solid var(--rule);border-radius:16px;padding:18px;
  background:var(--raised);text-decoration:none;overflow-wrap:anywhere}
.admin-card h2{font-size:19px;margin:0 0 8px}.admin-card p{margin:6px 0}
.admin-status{display:inline-block;font-size:14px;font-weight:700;
  padding:5px 10px;background:var(--soft);border-radius:8px}
.admin-actions{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
.admin-actions a,.admin-actions button,.admin-row button,.admin-row a{min-height:48px;display:inline-flex;
  align-items:center;justify-content:center;padding:10px 16px;border:1px solid var(--rule);border-radius:12px;
  text-decoration:none;background:var(--raised);color:var(--ink);font:inherit;font-weight:650;cursor:pointer}
.admin-actions .primary{background:var(--brand);border-color:var(--brand);color:var(--on-brand,#fff)}
.admin-danger{background:#9c2525!important;color:white!important;border-color:#9c2525!important}
.admin-notice{padding:16px;border:1px solid var(--rule);border-radius:12px;background:var(--soft);margin:16px 0}
.admin-error{padding:16px;border:1px solid #9c2525;border-radius:12px;margin:16px 0}
.admin-form{display:grid;gap:16px;margin:20px 0}
.admin-field{display:grid;gap:6px}.admin-field>span{font-weight:700}
.admin-field small{color:var(--muted)}
.admin-field input,.admin-field select,.admin-field textarea,.admin-row select{width:100%;min-height:48px;
  background:var(--raised);color:var(--ink);border:1px solid var(--rule);border-radius:10px;padding:10px;font:inherit}
.admin-field textarea{min-height:110px}
.admin-pair{display:grid;gap:16px}@media(min-width:560px){.admin-pair{grid-template-columns:1fr 1fr}}
.admin-section{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:28px 0 8px}
.admin-section h2{margin:0}
.admin-segment{border:1px solid var(--rule);border-radius:12px;padding:12px;margin:8px 0;overflow-wrap:anywhere}
.admin-segment .type{font-size:11px;font-weight:800;letter-spacing:.08em;
  text-transform:uppercase;color:var(--brand);margin:0 0 4px}
.admin-segment .admin-actions{margin:10px 0 0}
.admin-people{list-style:none;padding:0;margin:8px 0;display:grid;gap:8px}
.admin-person{border:1px solid var(--rule);border-radius:12px;padding:12px;overflow-wrap:anywhere}
.admin-person small{color:var(--muted)}
.admin-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center}
.admin-row select{width:auto;flex:1 1 140px}
.admin-kinds{display:grid;gap:10px;list-style:none;padding:0;margin:0 0 16px}
.admin-cover{display:block;width:100%;aspect-ratio:3/1;object-fit:cover;border-radius:14px;margin:0 0 14px}
.admin-thumb{float:right;margin:0 0 8px 12px;border-radius:10px;object-fit:cover}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:3px solid var(--brand);outline-offset:3px}
`.trim();

type AdminEnv = { Bindings: Env; Variables: { adminScope: Scope } };
type AdminContext = Context<AdminEnv>;
type Form = Record<string, string>;

export const admin = new Hono<AdminEnv>();

// ── Rendering helpers ───────────────────────────────────────────────────────

function adminPage(
  s: Scope,
  path: string,
  title: string,
  content: string,
  status = 200,
  back = ROOT,
): Response {
  return renderDocument({
    management: MANAGEMENT,
    surface: ADMIN_SURFACE,
    space: s.space,
    viewer: s.viewer,
    origin: s.origin,
    menu: s.menu,
    title,
    barTitle: path === ROOT ? "Manage trips" : title,
    canonicalPath: path,
    backPath: back,
    trail: path === ROOT ? undefined : [{ label: "Manage trips", href: ROOT }],
    localNav: [
      { href: ROOT, label: "All trips" },
      { href: "/trips", label: "View trips" },
    ],
    localNavActive: ROOT,
    css: CSS,
    cache: "private",
    status,
    content,
  });
}

function failure(s: Scope, path: string, status: number): Response {
  if (status === 404) {
    return adminPage(
      s,
      path,
      "Not found",
      renderState("Not found", "That trip or item no longer exists. It may have been deleted.", {
        href: ROOT,
        label: "All trips",
      }),
      404,
    );
  }
  return adminPage(
    s,
    path,
    "Trips unavailable",
    renderState("Trips unavailable", "Trips could not be reached just now. Nothing was changed. Please try again.", {
      href: ROOT,
      label: "All trips",
    }),
    status >= 500 ? status : 503,
  );
}

function label<T extends string>(choices: [T, string][], value: string): string {
  return choices.find(([v]) => v === value)?.[1] ?? value;
}

function statusLabel(status: string): string {
  return label(STATUSES, status);
}

function dateRange(trip: TripRow): string {
  if (trip.start_date && trip.end_date) return `${trip.start_date} – ${trip.end_date}`;
  if (trip.start_date) return `From ${trip.start_date}`;
  return "";
}

function when(value: string | null): string {
  return value ? value.replace("T", " ") : "";
}

function notice(c: AdminContext): string {
  const message = DONE[c.req.query("done") ?? ""];
  return message ? `<p class="admin-notice" role="status">${esc(message)}</p>` : "";
}

function errorBox(message: string | undefined): string {
  return message ? `<p class="admin-error" role="alert">${esc(message)}</p>` : "";
}

function field(name: string, text: string, control: string, hint = ""): string {
  return `<label class="admin-field" for="f-${name}"><span>${esc(text)}</span>${control}${
    hint ? `<small>${esc(hint)}</small>` : ""
  }</label>`;
}

function input(name: string, value: string, attrs = ""): string {
  return `<input id="f-${name}" name="${name}" value="${esc(value)}" ${attrs}>`;
}

function textarea(name: string, value: string, max: number): string {
  return `<textarea id="f-${name}" name="${name}" maxlength="${max}">${esc(value)}</textarea>`;
}

function select(name: string, choices: [string, string][], current: string, id = `f-${name}`): string {
  return `<select id="${id}" name="${name}">${choices
    .map(([v, t]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(t)}</option>`)
    .join("")}</select>`;
}

function newId(prefix: "trp_" | "tseg_"): string {
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

async function readForm(c: AdminContext): Promise<Form> {
  const body = await c.req.parseBody();
  const form: Form = {};
  for (const [key, value] of Object.entries(body)) form[key] = typeof value === "string" ? value.trim() : "";
  return form;
}

/** A store refusal the person can fix (bad input, conflict) versus an outage. */
function fixable(status: number): boolean {
  return status === 400 || status === 409;
}

async function loadTrip(c: AdminContext, s: Scope, id: string) {
  return callTrips<TripDetail | null>(c.env, s.gn, "get", [id]);
}

// ── Validation ──────────────────────────────────────────────────────────────

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

function tripWrite(form: Form, gn: string): { write?: Record<string, unknown>; error?: string } {
  const title = form.title ?? "";
  if (!title) return { error: "Give the trip a name, like “Spring tour 2027”." };
  if (title.length > 200) return { error: "Keep the trip name to 200 characters or fewer." };
  const description = form.description ?? "";
  if (description.length > 4000) return { error: "Keep the description to 4,000 characters or fewer." };
  const start = form.start_date ?? "";
  const end = form.end_date ?? "";
  for (const [value, which] of [[start, "start"], [end, "end"]] as const) {
    if (value && !validDate(value)) return { error: `The ${which} date isn't a real date. Pick it from the calendar.` };
  }
  if (start && end && end < start) return { error: "The trip ends before it starts. Check the two dates." };
  if (!STATUSES.some(([v]) => v === form.status)) return { error: "Choose a status from the list." };
  if (!VISIBILITIES.some(([v]) => v === form.visibility)) return { error: "Choose who can see this trip." };
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
function imageWrite(
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

function segmentWrite(form: Form, kind: Kind, gn: string): { write?: Record<string, unknown>; error?: string } {
  const itemLabel = form.label ?? "";
  if (!itemLabel) return { error: `Give this item a short name, like “${kind.example}”.` };
  if (itemLabel.length > 200) return { error: "Keep the name to 200 characters or fewer." };
  const start = form.start_at ?? "";
  const end = form.end_at ?? "";
  for (const [value, which] of [[start, kind.start], [end, kind.end]] as const) {
    if (value && !DATETIME.test(value)) return { error: `“${which}” isn't complete. Pick a date and a time.` };
  }
  if (start && end && end < start) return { error: `“${kind.end}” is before “${kind.start}”. Check the two times.` };
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
  const details = Object.fromEntries(kind.details.map((f) => [f.key, form[`d_${f.key}`] ?? ""]).filter(([, v]) => v));
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

// ── Forms ───────────────────────────────────────────────────────────────────

function tripFormValues(trip?: TripRow): Form {
  return {
    title: trip?.title ?? "",
    description: trip?.description ?? "",
    start_date: trip?.start_date ?? "",
    end_date: trip?.end_date ?? "",
    status: trip?.status ?? "draft",
    visibility: trip?.visibility ?? "members",
    imageSelection: "",
  };
}

function tripForm(s: Scope, action: string, values: Form, trip: TripRow | undefined, submit: string, cancel: string, error?: string): string {
  return `${errorBox(error)}<form class="admin-form" method="post" action="${esc(action)}">
    ${field("title", "Trip name", input("title", values.title, 'required maxlength="200" autocomplete="off"'))}
    ${field("description", "Description", textarea("description", values.description, 4000), "Optional. Shown to everyone who can see the trip.")}
    <div class="admin-pair">
      ${field("start_date", "Starts", input("start_date", values.start_date, 'type="date"'))}
      ${field("end_date", "Ends", input("end_date", values.end_date, 'type="date"'))}
    </div>
    ${field("visibility", "Who can see it", select("visibility", VISIBILITIES, values.visibility))}
    ${field("status", "Status", select("status", STATUSES, values.status), "Archive a trip once it's over.")}
    ${imageField("Cover image (optional)", `${ROOT}/image-library`, imageChoice(s, trip?.cover_tag, trip?.cover_revision), values.imageSelection ?? "")}
    <div class="admin-actions"><button class="primary" type="submit">${esc(submit)}</button><a href="${esc(cancel)}">Cancel</a></div>
  </form>`;
}

function segmentFormValues(kind: Kind, seg?: SegmentRow): Form {
  const details = readDetails(seg?.details);
  return {
    type: kind.type,
    label: seg?.label ?? "",
    start_at: seg?.start_at ?? "",
    end_at: seg?.end_at ?? "",
    location: seg?.location ?? "",
    confirmation_ref: seg?.confirmation_ref ?? "",
    notes: seg?.notes ?? "",
    imageSelection: "",
    ...Object.fromEntries(kind.details.map((f) => [`d_${f.key}`, details[f.key] ?? ""])),
  };
}

function imageChoice(s: Scope, tag: string | null | undefined, revision: string | null | undefined) {
  if (!tag) return null;
  return {
    image: { space: s.gn, tag, ...(revision ? { revision } : {}) },
    url: artworkUrl(s.gn, tag, revision, "sm", s.environment),
  };
}

function imageUrl(s: Scope, tag: string, revision: string | null | undefined, size: "sm" | "md" = "sm"): string {
  return artworkUrl(s.gn, tag, revision, size, s.environment);
}

function segmentForm(
  s: Scope,
  action: string,
  kind: Kind,
  values: Form,
  seg: SegmentRow | undefined,
  submit: string,
  cancel: string,
  error?: string,
): string {
  const details = kind.details
    .map((f) => field(`d_${f.key}`, f.label, input(`d_${f.key}`, values[`d_${f.key}`] ?? "", `maxlength="${DETAIL_MAX}" autocomplete="off"`),
      [f.hint, f.private ? "Only travelers on this trip and staff see this." : ""].filter(Boolean).join(" ")))
    .join("");
  return `${errorBox(error)}<form class="admin-form" method="post" action="${esc(action)}">
    <input type="hidden" name="type" value="${esc(kind.type)}">
    ${field("label", "Name", input("label", values.label, 'required maxlength="200" autocomplete="off"'), `For example “${kind.example}”.`)}
    <div class="admin-pair">
      ${field("start_at", kind.start, input("start_at", values.start_at, 'type="datetime-local"'))}
      ${field("end_at", kind.end, input("end_at", values.end_at, 'type="datetime-local"'))}
    </div>
    ${kind.location ? field("location", kind.location, input("location", values.location, 'maxlength="300"')) : ""}
    ${details}
    ${field("confirmation_ref", "Confirmation number", input("confirmation_ref", values.confirmation_ref, 'maxlength="100" autocomplete="off"'), "Only travelers on this trip and staff see this.")}
    ${field("notes", "Notes", textarea("notes", values.notes, 4000), "For staff. Not shown on the trip page.")}
    ${imageField("Image (optional)", `${ROOT}/image-library`, imageChoice(s, seg?.image_tag, seg?.image_revision), values.imageSelection ?? "")}
    <div class="admin-actions"><button class="primary" type="submit">${esc(submit)}</button><a href="${esc(cancel)}">Cancel</a></div>
  </form>`;
}

function confirmPage(
  s: Scope,
  path: string,
  heading: string,
  body: string,
  confirmLabel: string,
  keepLabel: string,
  back: string,
): Response {
  return adminPage(
    s,
    path,
    heading,
    `<h1 class="admin-title">${esc(heading)}</h1>${body}
     <form method="post" action="${esc(path)}"><div class="admin-actions">
       <button class="admin-danger" type="submit">${esc(confirmLabel)}</button>
       <a href="${esc(back)}">${esc(keepLabel)}</a>
     </div></form>`,
    200,
    back,
  );
}

// ── Middleware ──────────────────────────────────────────────────────────────

admin.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "private, no-store");
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
  c.res.headers.set("Referrer-Policy", "same-origin");
});

admin.use("*", async (c, next) => {
  const s = await scope(c);
  if ("error" in s) return s.error;
  c.set("adminScope", s);
  const path = new URL(c.req.url).pathname;
  if (!s.viewer.signedIn) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?return=${encodeURIComponent(path)}`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  if (!canManageTrips(s.viewer.role)) {
    return adminPage(
      s,
      path,
      "Access denied",
      renderState("Access denied", "You need staff access to manage trips.", {
        href: "/trips",
        label: "View trips",
      }),
      403,
    );
  }
  // Every write is a same-origin form post. A missing or foreign Origin never
  // reaches the store.
  if (c.req.method === "POST" && c.req.header("Origin") !== s.origin) {
    return adminPage(
      s,
      path,
      "Nothing was changed",
      renderState("Nothing was changed", "Go back to the page, reload it, and try again.", {
        href: ROOT,
        label: "All trips",
      }),
      403,
    );
  }
  await next();
});

// ── Image field ─────────────────────────────────────────────────────────────
// Same wiring as space-events: the shared field from home, the library behind
// set 284. Registered before "/:id" so these names never read as trip IDs.

const SCRIPT_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" };
admin.get(IMAGE_FIELD_PATH.slice(ROOT.length), (c) => c.body(IMAGE_FIELD_JS, 200, SCRIPT_HEADERS));
admin.get("/image-picker.js", (c) => c.body(IMAGE_PICKER_JS, 200, SCRIPT_HEADERS));
admin.get("/image-library", (c) => imageLibraryRequest(c.env, c.get("adminScope"), c.req.raw));
admin.post("/image-library/pin", (c) => imageLibraryRequest(c.env, c.get("adminScope"), c.req.raw));

// ── Trip list ───────────────────────────────────────────────────────────────

admin.get("/", async (c) => {
  const s = c.get("adminScope");
  const result = await callTrips<TripRow[]>(c.env, s.gn, "list", [s.gn]);
  if (!result.ok) return failure(s, ROOT, result.status);
  const trips = result.value;
  const cards = trips.length
    ? `<ul class="admin-list">${trips
        .map((t) => {
          const dates = dateRange(t);
          return `<li><a class="admin-card" href="${ROOT}/${esc(t.id)}">
          ${t.cover_tag ? `<img class="admin-thumb" src="${esc(imageUrl(s, t.cover_tag, t.cover_revision))}" alt="" width="96" height="64">` : ""}
          <h2>${esc(t.title)}</h2>
          ${dates ? `<p>${esc(dates)}</p>` : ""}
          <span class="admin-status">${esc(statusLabel(t.status))}</span>
          <p>Manage →</p>
        </a></li>`;
        })
        .join("")}</ul>`
    : "<p>No trips in this space yet. Create the first one.</p>";
  return adminPage(
    s,
    ROOT,
    "Manage trips",
    `<h1 class="admin-title">Manage trips</h1>${notice(c)}
     <p class="admin-meta">${trips.length} trip${trips.length === 1 ? "" : "s"} in this space.</p>
     <div class="admin-actions"><a class="primary" href="${ROOT}/new">New trip</a></div>
     ${cards}`,
  );
});

// ── Create ──────────────────────────────────────────────────────────────────

function newTripPage(s: Scope, values: Form, error?: string, status = 200): Response {
  return adminPage(
    s,
    `${ROOT}/new`,
    "New trip",
    `<h1 class="admin-title">New trip</h1>
     <p class="admin-meta">You'll add the itinerary and travelers after it's created. You're added as its owner.</p>
     ${tripForm(s, `${ROOT}/new`, values, undefined, "Create trip", ROOT, error)}`,
    status,
  );
}

admin.get("/new", (c) => newTripPage(c.get("adminScope"), tripFormValues()));

admin.post("/new", async (c) => {
  const s = c.get("adminScope");
  const form = await readForm(c);
  const { write, error } = tripWrite(form, s.gn);
  if (!write) return newTripPage(s, form, error, 400);
  if (!s.viewer.uid) return failure(s, `${ROOT}/new`, 503);
  const id = newId("trp_");
  const result = await callTrips<TripRow>(c.env, s.gn, "create", [id, s.gn, write, s.viewer.uid]);
  if (!result.ok) {
    return fixable(result.status) ? newTripPage(s, form, result.message, 400) : failure(s, `${ROOT}/new`, result.status);
  }
  return c.redirect(`${ROOT}/${id}?done=created`, 303);
});

// ── Trip detail ─────────────────────────────────────────────────────────────

async function names(c: AdminContext, s: Scope, members: MemberRow[]): Promise<Map<string, Person>> {
  const directory = people(c.env, s.gn);
  if (!directory || !members.length) return new Map();
  try {
    return await directory.find(members.map((m) => m.member_id));
  } catch (error) {
    console.error("[trips-admin] member names unavailable", (error as Error).message);
    return new Map();
  }
}

function memberName(m: MemberRow, known: Map<string, Person>): string {
  const p = known.get(m.member_id);
  return p ? `<strong>${esc(p.label)}</strong>` : `<strong>${esc(m.member_id)}</strong> <small>(member ID)</small>`;
}

admin.get("/:id", async (c) => {
  const s = c.get("adminScope");
  const id = c.req.param("id");
  const path = `${ROOT}/${id}`;
  if (!TRP.test(id)) return failure(s, ROOT, 404);
  const result = await loadTrip(c, s, id);
  if (!result.ok) return failure(s, path, result.status);
  if (!result.value) return failure(s, path, 404);
  const { trip, segments, members } = result.value;
  const known = await names(c, s, members);
  const base = `${ROOT}/${esc(id)}`;

  const segHtml = segments.length
    ? segments
        .map(
          (seg) => `<div class="admin-segment">
        ${seg.image_tag ? `<img class="admin-thumb" src="${esc(imageUrl(s, seg.image_tag, seg.image_revision))}" alt="" width="96" height="64">` : ""}
        <p class="type">${esc(kindOf(seg.type)?.name ?? seg.type)}</p>
        <strong>${esc(seg.label)}</strong>
        ${shownDetails(seg, true).map(([k, v]) => `<br><small>${esc(k)}: ${esc(v)}</small>`).join("")}
        ${seg.start_at || seg.end_at ? `<br><small>${esc(when(seg.start_at))}${seg.end_at ? ` → ${esc(when(seg.end_at))}` : ""}</small>` : ""}
        ${seg.location ? `<br><small>📍 ${esc(seg.location)}</small>` : ""}
        ${seg.confirmation_ref ? `<br><small>Confirmation: ${esc(seg.confirmation_ref)}</small>` : ""}
        <div class="admin-actions">
          <a href="${base}/segments/${esc(seg.id)}/edit">Edit</a>
          <a href="${base}/segments/${esc(seg.id)}/remove">Remove</a>
        </div>
      </div>`,
        )
        .join("")
    : "<p>Nothing on the itinerary yet.</p>";

  const memHtml = members.length
    ? `<ul class="admin-people">${members
        .map(
          (m, i) => `<li class="admin-person">${memberName(m, known)}
        <form class="admin-row" method="post" action="${base}/members">
          <input type="hidden" name="member_id" value="${esc(m.member_id)}">
          <label class="visually-hidden" for="role-${i}">Role</label>
          ${select("role", MEMBER_ROLES, m.role, `role-${i}`)}
          <button type="submit">Save role</button>
          <a href="${base}/members/${encodeURIComponent(m.member_id)}/remove">Remove</a>
        </form>
      </li>`,
        )
        .join("")}</ul>`
    : "<p>No one is on this trip yet.</p>";

  return adminPage(
    s,
    path,
    trip.title,
    `${trip.cover_tag ? `<img class="admin-cover" src="${esc(imageUrl(s, trip.cover_tag, trip.cover_revision, "md"))}" alt="">` : ""}
     <h1 class="admin-title">${esc(trip.title)}</h1>${notice(c)}
     <p class="admin-meta">${[dateRange(trip), statusLabel(trip.status), label(VISIBILITIES, trip.visibility)]
       .filter(Boolean)
       .map(esc)
       .join(" · ")}</p>
     ${trip.description ? `<p>${esc(trip.description)}</p>` : ""}
     <div class="admin-actions">
       <a href="${base}/edit">Edit trip</a>
       <a href="/trips/${esc(id)}">View as a visitor</a>
       <a href="${base}/delete">Delete trip</a>
     </div>
     <div class="admin-section"><h2>Itinerary (${segments.length})</h2></div>
     ${segHtml}
     <div class="admin-actions"><a class="primary" href="${base}/segments/new">Add to itinerary</a></div>
     <div class="admin-section"><h2>Travelers (${members.length})</h2></div>
     ${memHtml}
     <div class="admin-actions"><a class="primary" href="${base}/members/add">Add a traveler</a></div>
     <div class="admin-actions"><a href="${ROOT}">Back to all trips</a></div>`,
  );
});

// ── Edit / delete trip ──────────────────────────────────────────────────────

function editTripPage(s: Scope, trip: TripRow, values: Form, error?: string, status = 200): Response {
  const base = `${ROOT}/${trip.id}`;
  return adminPage(
    s,
    `${base}/edit`,
    `Edit ${trip.title}`,
    `<h1 class="admin-title">Edit trip</h1>${tripForm(s, `${base}/edit`, values, trip, "Save trip", base, error)}`,
    status,
    base,
  );
}

admin.get("/:id/edit", async (c) => {
  const s = c.get("adminScope");
  const id = c.req.param("id");
  if (!TRP.test(id)) return failure(s, ROOT, 404);
  const result = await loadTrip(c, s, id);
  if (!result.ok) return failure(s, `${ROOT}/${id}/edit`, result.status);
  if (!result.value) return failure(s, `${ROOT}/${id}/edit`, 404);
  return editTripPage(s, result.value.trip, tripFormValues(result.value.trip));
});

admin.post("/:id/edit", async (c) => {
  const s = c.get("adminScope");
  const id = c.req.param("id");
  const path = `${ROOT}/${id}/edit`;
  if (!TRP.test(id)) return failure(s, ROOT, 404);
  // Loaded first: the form shows the current cover again if it needs fixing.
  const current = await loadTrip(c, s, id);
  if (!current.ok) return failure(s, path, current.status);
  if (!current.value) return failure(s, path, 404);
  const trip = current.value.trip;
  const form = await readForm(c);
  const { write, error } = tripWrite(form, s.gn);
  if (!write) return editTripPage(s, trip, form, error, 400);
  const result = await callTrips<TripRow>(c.env, s.gn, "update", [id, write, s.viewer.uid]);
  if (!result.ok) {
    return fixable(result.status)
      ? editTripPage(s, trip, form, result.message, 400)
      : failure(s, path, result.status);
  }
  return c.redirect(`${ROOT}/${id}?done=saved`, 303);
});

admin.get("/:id/delete", async (c) => {
  const s = c.get("adminScope");
  const id = c.req.param("id");
  const path = `${ROOT}/${id}/delete`;
  if (!TRP.test(id)) return failure(s, ROOT, 404);
  const result = await loadTrip(c, s, id);
  if (!result.ok) return failure(s, path, result.status);
  if (!result.value) return failure(s, path, 404);
  const { trip, segments, members } = result.value;
  const items = `${segments.length} itinerary item${segments.length === 1 ? "" : "s"}`;
  const travelers = `${members.length} traveler${members.length === 1 ? "" : "s"}`;
  return confirmPage(
    s,
    path,
    "Delete this trip?",
    `<p><strong>${esc(trip.title)}</strong> will be deleted with its ${items} and its list of ${travelers}.</p>
     <p>This can't be undone. To keep it for the record instead, edit the trip and set its status to Archived.</p>`,
    "Delete trip",
    "Keep trip",
    `${ROOT}/${id}`,
  );
});

admin.post("/:id/delete", async (c) => {
  const s = c.get("adminScope");
  const id = c.req.param("id");
  if (!TRP.test(id)) return failure(s, ROOT, 404);
  const result = await callTrips<{ deleted: boolean }>(c.env, s.gn, "delete", [id, s.viewer.uid]);
  if (!result.ok) return failure(s, `${ROOT}/${id}/delete`, result.status);
  if (!result.value.deleted) return failure(s, `${ROOT}/${id}/delete`, 404);
  return c.redirect(`${ROOT}?done=deleted`, 303);
});

// ── Itinerary items ─────────────────────────────────────────────────────────

function segmentPage(
  s: Scope,
  trip: TripRow,
  path: string,
  heading: string,
  kind: Kind,
  values: Form,
  seg: SegmentRow | undefined,
  submit: string,
  error?: string,
  status = 200,
): Response {
  const base = `${ROOT}/${trip.id}`;
  return adminPage(
    s,
    path,
    heading,
    `<p class="admin-meta">${esc(trip.title)} · ${esc(kind.name)}</p><h1 class="admin-title">${esc(heading)}</h1>
     ${segmentForm(s, path, kind, values, seg, submit, base, error)}`,
    status,
    base,
  );
}

/** Loads the trip and, when asked, the segment, which must belong to it. */
async function tripAndSegment(c: AdminContext, s: Scope, path: string, withSegment: boolean) {
  const id = c.req.param("id") ?? "";
  const sid = c.req.param("sid") ?? "";
  if (!TRP.test(id) || (withSegment && !TSEG.test(sid))) return { response: failure(s, ROOT, 404) };
  const result = await loadTrip(c, s, id);
  if (!result.ok) return { response: failure(s, path, result.status) };
  if (!result.value) return { response: failure(s, path, 404) };
  const segment = withSegment ? result.value.segments.find((seg) => seg.id === sid) : undefined;
  if (withSegment && !segment) return { response: failure(s, path, 404) };
  return { detail: result.value, segment };
}

/** A kind offered for new items; cars stay editable but aren't offered. */
function newKind(type: string | undefined): Kind | undefined {
  return KINDS.find((k) => k.type === type);
}

admin.get("/:id/segments/new", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail } = await tripAndSegment(c, s, path, false);
  if (response) return response;
  const trip = detail!.trip;
  const kind = newKind(c.req.query("type"));
  if (kind) return segmentPage(s, trip, path, `Add a ${kind.name.toLowerCase()}`, kind, segmentFormValues(kind), undefined, "Add to itinerary");
  // First choose the kind: each asks for different details.
  return adminPage(
    s,
    path,
    "Add to itinerary",
    `<p class="admin-meta">${esc(trip.title)}</p><h1 class="admin-title">What are you adding?</h1>
     <ul class="admin-kinds">${KINDS.map((k) => `<li><a class="admin-card" href="${esc(path)}?type=${k.type}"><h2>${esc(k.name)}</h2>
       <p>${esc([k.start, k.end, ...(k.location ? [k.location] : []), ...k.details.map((f) => f.label)].join(" · "))}</p></a></li>`).join("")}</ul>
     <div class="admin-actions"><a href="${ROOT}/${esc(trip.id)}">Cancel</a></div>`,
    200,
    `${ROOT}/${trip.id}`,
  );
});

admin.post("/:id/segments/new", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail } = await tripAndSegment(c, s, path, false);
  if (response) return response;
  const trip = detail!.trip;
  const form = await readForm(c);
  const kind = newKind(form.type);
  if (!kind) return c.redirect(path, 303);
  const heading = `Add a ${kind.name.toLowerCase()}`;
  const { write, error } = segmentWrite(form, kind, s.gn);
  if (!write) return segmentPage(s, trip, path, heading, kind, form, undefined, "Add to itinerary", error, 400);
  const result = await callTrips<SegmentRow>(c.env, s.gn, "addSegment", [newId("tseg_"), trip.id, write]);
  if (!result.ok) {
    return fixable(result.status)
      ? segmentPage(s, trip, path, heading, kind, form, undefined, "Add to itinerary", result.message, 400)
      : failure(s, path, result.status);
  }
  return c.redirect(`${ROOT}/${trip.id}?done=segment-added`, 303);
});

admin.get("/:id/segments/:sid/edit", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail, segment } = await tripAndSegment(c, s, path, true);
  if (response) return response;
  const kind = kindOf(segment!.type) ?? KINDS[KINDS.length - 1]!;
  return segmentPage(s, detail!.trip, path, "Edit itinerary item", kind, segmentFormValues(kind, segment), segment, "Save item");
});

admin.post("/:id/segments/:sid/edit", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail, segment } = await tripAndSegment(c, s, path, true);
  if (response) return response;
  const trip = detail!.trip;
  const form = await readForm(c);
  // The kind is fixed once an item exists; the form can't change it.
  const kind = kindOf(segment!.type) ?? KINDS[KINDS.length - 1]!;
  const { write, error } = segmentWrite(form, kind, s.gn);
  if (!write) return segmentPage(s, trip, path, "Edit itinerary item", kind, form, segment, "Save item", error, 400);
  const result = await callTrips<SegmentRow>(c.env, s.gn, "updateSegment", [segment!.id, write]);
  if (!result.ok) {
    return fixable(result.status)
      ? segmentPage(s, trip, path, "Edit itinerary item", kind, form, segment, "Save item", result.message, 400)
      : failure(s, path, result.status);
  }
  return c.redirect(`${ROOT}/${trip.id}?done=segment-saved`, 303);
});

admin.get("/:id/segments/:sid/remove", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail, segment } = await tripAndSegment(c, s, path, true);
  if (response) return response;
  return confirmPage(
    s,
    path,
    "Remove from itinerary?",
    `<p><strong>${esc(segment!.label)}</strong> will be removed from <strong>${esc(detail!.trip.title)}</strong>. This can't be undone.</p>`,
    "Remove item",
    "Keep item",
    `${ROOT}/${detail!.trip.id}`,
  );
});

admin.post("/:id/segments/:sid/remove", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail, segment } = await tripAndSegment(c, s, path, true);
  if (response) return response;
  const result = await callTrips<{ deleted: boolean }>(c.env, s.gn, "removeSegment", [segment!.id]);
  if (!result.ok) return failure(s, path, result.status);
  return c.redirect(`${ROOT}/${detail!.trip.id}?done=segment-removed`, 303);
});

// ── Travelers ───────────────────────────────────────────────────────────────

const MEMBER_ID_MAX = 256;

function addTravelerPage(
  s: Scope,
  trip: TripRow,
  members: MemberRow[],
  query: string,
  results: Person[] | null,
  unavailable: boolean,
  error?: string,
  status = 200,
): Response {
  const base = `${ROOT}/${trip.id}`;
  const path = `${base}/members/add`;
  const onTrip = new Set(members.map((m) => m.member_id));
  let body: string;
  if (results === null) {
    // No member directory: enter an ID by hand.
    body = `${unavailable ? '<p class="admin-notice">The member list can\'t be searched right now. You can still add someone by their member ID.</p>' : ""}
      <form class="admin-form" method="post" action="${esc(base)}/members">
        ${field("member_id", "Member ID", input("member_id", "", `required maxlength="${MEMBER_ID_MAX}" autocomplete="off"`), "The person's ID from the space's member list.")}
        ${field("role", "Role", select("role", MEMBER_ROLES, "traveler"))}
        <div class="admin-actions"><button class="primary" type="submit">Add traveler</button><a href="${esc(base)}">Cancel</a></div>
      </form>`;
  } else {
    const list = results.length
      ? `<ul class="admin-people">${results
          .map((p, i) =>
            onTrip.has(p.id)
              ? `<li class="admin-person"><strong>${esc(p.label)}</strong> <small>Already on this trip</small></li>`
              : `<li class="admin-person"><strong>${esc(p.label)}</strong>
            <form class="admin-row" method="post" action="${esc(base)}/members">
              <input type="hidden" name="member_id" value="${esc(p.id)}">
              <label class="visually-hidden" for="add-role-${i}">Role</label>
              ${select("role", MEMBER_ROLES, "traveler", `add-role-${i}`)}
              <button type="submit">Add</button>
            </form></li>`,
          )
          .join("")}</ul>`
      : `<p>No members match “${esc(query)}”. Try part of their username or email.</p>`;
    body = `<form class="admin-form" method="get" action="${esc(path)}" role="search">
        ${field("q", "Find a member", input("q", query, 'type="search" maxlength="100" autocomplete="off"'), "Search by username or email.")}
        <div class="admin-actions"><button type="submit">Search</button></div>
      </form>${list}
      <div class="admin-actions"><a href="${esc(base)}">Done</a></div>`;
  }
  return adminPage(
    s,
    path,
    "Add a traveler",
    `<p class="admin-meta">${esc(trip.title)}</p><h1 class="admin-title">Add a traveler</h1>${errorBox(error)}${body}`,
    status,
    base,
  );
}

async function searchPeople(directory: People | null, query: string): Promise<{ results: Person[] | null; unavailable: boolean }> {
  if (!directory) return { results: null, unavailable: false };
  try {
    return { results: await directory.search(query), unavailable: false };
  } catch (error) {
    console.error("[trips-admin] member search unavailable", (error as Error).message);
    return { results: null, unavailable: true };
  }
}

admin.get("/:id/members/add", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail } = await tripAndSegment(c, s, path, false);
  if (response) return response;
  const query = (c.req.query("q") ?? "").trim().slice(0, 100);
  const { results, unavailable } = await searchPeople(people(c.env, s.gn), query);
  return addTravelerPage(s, detail!.trip, detail!.members, query, results, unavailable);
});

admin.post("/:id/members", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail } = await tripAndSegment(c, s, path, false);
  if (response) return response;
  const { trip, members } = detail!;
  const form = await readForm(c);
  const memberId = form.member_id ?? "";
  const role = form.role ?? "";
  const retry = async (message: string) => {
    const { results, unavailable } = await searchPeople(people(c.env, s.gn), "");
    return addTravelerPage(s, trip, members, "", results, unavailable, message, 400);
  };
  if (!memberId || memberId.length > MEMBER_ID_MAX) return retry("Choose a member to add.");
  if (!MEMBER_ROLES.some(([v]) => v === role)) return retry("Choose a role from the list.");
  // With a directory, only enabled members of this space can be added. A role
  // change for someone already on the trip skips the lookup.
  const directory = people(c.env, s.gn);
  if (directory && !members.some((m) => m.member_id === memberId)) {
    let found: Map<string, Person>;
    try {
      found = await directory.find([memberId]);
    } catch {
      return failure(s, path, 503);
    }
    if (!found.has(memberId)) return retry("That person isn't an active member of this space.");
  }
  const result = await callTrips<MemberRow>(c.env, s.gn, "setMember", [trip.id, memberId, role]);
  if (!result.ok) return fixable(result.status) ? retry(result.message) : failure(s, path, result.status);
  return c.redirect(`${ROOT}/${trip.id}?done=member-saved`, 303);
});

async function memberContext(c: AdminContext, s: Scope, path: string) {
  const { response, detail } = await tripAndSegment(c, s, path, false);
  if (response) return { response };
  const memberId = c.req.param("mid") ?? "";
  const member = detail!.members.find((m) => m.member_id === memberId);
  if (!member) return { response: failure(s, path, 404) };
  return { detail: detail!, member };
}

admin.get("/:id/members/:mid/remove", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail, member } = await memberContext(c, s, path);
  if (response) return response;
  const known = await names(c, s, [member!]);
  return confirmPage(
    s,
    path,
    "Remove from trip?",
    `<p>${memberName(member!, known)} will be removed from <strong>${esc(detail!.trip.title)}</strong>.
     ${detail!.trip.visibility === "private" ? " This trip is private, so they won't be able to see it any more." : ""}</p>`,
    "Remove from trip",
    "Keep on trip",
    `${ROOT}/${detail!.trip.id}`,
  );
});

admin.post("/:id/members/:mid/remove", async (c) => {
  const s = c.get("adminScope");
  const path = new URL(c.req.url).pathname;
  const { response, detail, member } = await memberContext(c, s, path);
  if (response) return response;
  const result = await callTrips<{ deleted: boolean }>(c.env, s.gn, "removeMember", [detail!.trip.id, member!.member_id]);
  if (!result.ok) return failure(s, path, result.status);
  return c.redirect(`${ROOT}/${detail!.trip.id}?done=member-removed`, 303);
});

// ── Fallbacks ───────────────────────────────────────────────────────────────

admin.notFound((c) => failure(c.get("adminScope"), ROOT, 404));

admin.onError((error, c) => {
  console.error("[trips-admin]", error);
  const s = c.get("adminScope") as Scope | undefined;
  return s ? failure(s, ROOT, 503) : c.text("Trip management is temporarily unavailable.", 503);
});
