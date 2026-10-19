import { Hono } from "hono";
import {
  defineSurface,
  escapeHtml as esc,
  renderDocument,
  renderState,
} from "../../space-surface/src";
import { roleLevel } from "../../sets/sets/auth/shared/role-hierarchy";
import { callTrips } from "./trips";
import { scope, type Scope } from "./scope";
import { SURFACE } from "./surface";
import type { Env, SegmentRow, MemberRow, TripRow } from "./types";

export function canManageTrips(role: string | null): boolean {
  return role !== null && role !== "owner" && roleLevel(role) >= roleLevel("staff");
}

const ADMIN_SURFACE = defineSurface({
  ...SURFACE,
  profiles: [],
  backLink: false,
  indexable: false,
  forms: true,
});

const ROOT = "/trips/admin";
const TRP = /^trp_[0-9A-Za-z]{26}$/;

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
.admin-actions a{min-height:48px;display:inline-flex;align-items:center;justify-content:center;
  padding:10px 16px;border:1px solid var(--rule);border-radius:12px;text-decoration:none;
  background:var(--raised);color:var(--ink);font-weight:650}
.admin-segment{border:1px solid var(--rule);border-radius:12px;padding:12px;margin:8px 0}
.admin-segment .type{font-size:11px;font-weight:800;letter-spacing:.08em;
  text-transform:uppercase;color:var(--brand);margin:0 0 4px}
.admin-members{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.admin-member{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;
  border:1px solid var(--rule);border-radius:999px;background:var(--raised);font-size:14px}
a:focus-visible,button:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
`.trim();

type AdminEnv = { Bindings: Env; Variables: { adminScope: Scope } };
export const admin = new Hono<AdminEnv>();

function adminPage(
  s: Scope,
  path: string,
  title: string,
  content: string,
  status = 200,
): Response {
  return renderDocument({
    management: "trips",
    surface: ADMIN_SURFACE,
    space: s.space,
    viewer: s.viewer,
    origin: s.origin,
    menu: s.menu,
    title,
    barTitle: "Manage trips",
    canonicalPath: path,
    backPath: ROOT,
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
  await next();
});

admin.get("/", async (c) => {
  const s = c.get("adminScope") as Scope;
  const result = await callTrips<TripRow[]>(c.env, s.gn, "list", [s.gn]);
  if (!result.ok) {
    return adminPage(
      s,
      ROOT,
      "Trips unavailable",
      renderState("Trips unavailable", "Could not load trips right now."),
      result.status,
    );
  }
  const trips = result.value;
  const cards = trips.length
    ? `<ul class="admin-list">${trips.map(t => {
        const dates = dateRange(t);
        return `<li><a class="admin-card" href="${ROOT}/${esc(t.id)}">
          <h2>${esc(t.title)}</h2>
          ${dates ? `<p>${esc(dates)}</p>` : ""}
          <span class="admin-status">${esc(statusLabel(t.status))}</span>
          <p>View details →</p>
        </a></li>`;
      }).join("")}</ul>`
    : "<p>No trips in this space yet.</p>";
  return adminPage(
    s,
    ROOT,
    "Manage trips",
    `<h1 class="admin-title">Manage trips</h1>
     <p class="admin-meta">${trips.length} trip${trips.length === 1 ? "" : "s"} in this space.</p>
     ${cards}`,
  );
});

admin.get("/:id", async (c) => {
  const s = c.get("adminScope") as Scope;
  const id = c.req.param("id");
  if (!TRP.test(id)) {
    return adminPage(
      s,
      ROOT,
      "Trip unavailable",
      renderState("Trip unavailable", "That trip does not exist.", { href: ROOT, label: "All trips" }),
      404,
    );
  }
  const path = `${ROOT}/${id}`;
  const result = await callTrips<{ trip: TripRow; segments: SegmentRow[]; members: MemberRow[] } | null>(
    c.env,
    s.gn,
    "get",
    [id],
  );
  if (!result.ok || !result.value) {
    return adminPage(
      s,
      path,
      "Trip unavailable",
      renderState("Trip unavailable", "That trip could not be loaded.", { href: ROOT, label: "All trips" }),
      result.ok ? 404 : (result as { status: number }).status,
    );
  }
  const { trip, segments, members } = result.value;
  const dates = dateRange(trip);
  const segHtml = segments.length
    ? segments.map(seg => `<div class="admin-segment">
        <p class="type">${esc(seg.type)}</p>
        <strong>${esc(seg.label)}</strong>
        ${seg.start_at
          ? `<br><small>${esc(seg.start_at)}${seg.end_at ? ` → ${esc(seg.end_at)}` : ""}</small>`
          : ""}
        ${seg.location ? `<br><small>📍 ${esc(seg.location)}</small>` : ""}
        ${seg.confirmation_ref ? `<br><small>Ref: ${esc(seg.confirmation_ref)}</small>` : ""}
      </div>`).join("")
    : "<p>No segments.</p>";
  const memHtml = members.length
    ? `<div class="admin-members">${members.map(m =>
        `<span class="admin-member">${esc(m.member_id)} <em>${esc(m.role)}</em></span>`
      ).join("")}</div>`
    : "<p>No members.</p>";
  return adminPage(
    s,
    path,
    trip.title,
    `<h1 class="admin-title">${esc(trip.title)}</h1>
     <p class="admin-meta">${[dates, statusLabel(trip.status), trip.visibility].filter(Boolean).map(esc).join(" · ")}</p>
     ${trip.description ? `<p>${esc(trip.description)}</p>` : ""}
     <h2>Segments (${segments.length})</h2>${segHtml}
     <h2>Members (${members.length})</h2>${memHtml}
     <div class="admin-actions"><a href="${ROOT}">Back to all trips</a></div>`,
  );
});

admin.notFound((c) => {
  const s = c.get("adminScope") as Scope;
  return adminPage(
    s,
    ROOT,
    "Not found",
    renderState("Not found", "That page does not exist.", { href: ROOT, label: "All trips" }),
    404,
  );
});

admin.onError((error, c) => {
  console.error("[trips-admin]", error);
  const s = c.get("adminScope") as Scope | undefined;
  return s
    ? adminPage(s, ROOT, "Error", renderState("Error", "Trip management is temporarily unavailable."), 503)
    : c.text("Trip management is temporarily unavailable.", 503);
});
