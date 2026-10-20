import { defineSurface } from "../../space-surface/src";

export const SURFACE = defineSurface({
  slug: "trips",
  label: "Trips",
  glyph: "✈",

  aid: "rhp_space_trips",
  certName: "space/trips",
  setId: 256,
  binding: "TRIPS_WORKER",

  forms: true,
  // A referrer back link needs a client script, which this surface does not ship.
  backLink: false,

  indexable: false,
  ogType: "website",

  cache: { maxAge: 0, sMaxAge: 0 },

  profiles: [],
});

export const TRIPS_CSS = `
:root{--wrap:720px}
.intro h1{font:700 clamp(26px,7vw,36px)/1.08 var(--heading);letter-spacing:-.035em;margin:2px 0 6px}
.intro p{color:var(--muted);margin:0 0 20px}

.trip-list{display:grid;gap:12px;list-style:none;padding:0;margin:0}
.trip-card{display:block;border:1px solid var(--rule);border-radius:18px;padding:18px;
  background:var(--raised);text-decoration:none;box-shadow:0 8px 22px -22px #000}
.trip-card h2{font:700 18px/1.3 var(--heading);margin:0 0 4px;letter-spacing:-.015em}
.trip-card .dates{color:var(--muted);font-size:14px;margin:0 0 6px}
.trip-card .status{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--brand)}

.draft-note{margin:0 0 16px;padding:10px 14px;border:1px dashed var(--rule);border-radius:12px;
  background:var(--soft);font-size:14px}

.trip-cover{display:block;width:100%;aspect-ratio:2/1;object-fit:cover;border-radius:18px;margin:0 0 18px}
.trip-card-cover{display:block;width:calc(100% + 36px);margin:-18px -18px 14px;aspect-ratio:3/1;object-fit:cover;
  border-radius:18px 18px 0 0}
.trip-head h1{font:700 clamp(25px,7.5vw,38px)/1.12 var(--heading);letter-spacing:-.03em;margin:0 0 12px}
.trip-meta{display:grid;gap:8px;margin:0 0 20px;padding:0 0 18px;border-bottom:1px solid var(--rule)}
.trip-meta .row{display:flex;gap:10px;font-size:15px;align-items:flex-start}
.trip-meta .k{flex:none;width:20px;text-align:center;opacity:.6}

.segments{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.segment{border:1px solid var(--rule);border-radius:14px;padding:14px;background:var(--raised)}
.segment-image{display:block;width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:10px;margin:0 0 10px}
.segment .type{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;
  color:var(--brand);margin:0 0 4px}
.segment h3{font:700 16px/1.3 var(--heading);margin:0 0 4px}
.segment .when{color:var(--muted);font-size:14px;margin:0}

.members{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0 0}
.member-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;
  border:1px solid var(--rule);border-radius:999px;background:var(--raised);font-size:14px}
.member-chip .role{color:var(--muted);font-size:12px}

.pager{display:flex;gap:10px;justify-content:space-between;margin-top:24px}
.pager a{min-height:46px;display:inline-flex;align-items:center;padding:0 18px;
  border:1px solid var(--rule);border-radius:14px;background:var(--raised);
  text-decoration:none;font-weight:650}
`.trim();

export const TRIPS_NAV = [
  { href: "/trips", label: "My trips" },
];
