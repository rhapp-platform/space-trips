import {
  buildMenu,
  hasSessionCookie,
  readSpaceRecord,
  readViewer,
  renderDocument,
  renderState,
  resolveIdentity,
  resolveSpaceName,
} from "../../space-surface/src";
import type {
  CachePolicy,
  NavItem,
  SpaceIdentity,
  SpaceRecord,
  Viewer,
} from "../../space-surface/src";
import { roleLevel } from "../../sets/sets/auth/shared/role-hierarchy";
import { SURFACE, TRIPS_CSS, TRIPS_NAV } from "./surface";
import type { Env } from "./types";

export interface Scope {
  gn: string;
  instance: string;
  space: SpaceIdentity;
  viewer: Viewer;
  origin: string;
  menu: NavItem[];
  cache: CachePolicy;
  environment: string;
}

export async function scope(c: any): Promise<Scope | { error: Response }> {
  const url = new URL(c.req.url);
  const origin = `${url.protocol}//${url.host}`;
  const gn = resolveSpaceName(url);
  if (!gn) return { error: c.text("No space in this hostname.", 400) };

  const record: SpaceRecord | null = await readSpaceRecord(c.env as Env, gn);
  const space = resolveIdentity(gn, record);
  const viewer = await readViewer(c.req.raw, c.env as Env, gn, space.instance);
  const cache: CachePolicy = hasSessionCookie(c.req.raw) ? "private" : "public";
  const menu = buildMenu(record, SURFACE.slug);

  if (!space.instance) {
    return {
      error: renderDocument({
        surface: SURFACE,
        space,
        viewer,
        origin,
        menu,
        css: TRIPS_CSS,
        environment: (c.env as Env).ENVIRONMENT,
        title: "Trips unavailable",
        canonicalPath: "/trips",
        cache: "no-store",
        status: 503,
        content: renderState(
          "Trips unavailable",
          "This space is not ready to show its trips yet.",
        ),
      }),
    };
  }
  return {
    gn,
    instance: space.instance,
    space,
    viewer,
    origin,
    menu,
    cache,
    environment: (c.env as Env).ENVIRONMENT,
  };
}

export interface PageInput {
  title: string;
  barTitle?: string;
  canonicalPath: string;
  content: string;
  description?: string;
  backPath?: string;
  head?: string;
  cache?: CachePolicy;
  status?: number;
  localNavActive?: string;
}

export function page(s: Scope, input: PageInput): Response {
  const { description, ...rest } = input;
  return renderDocument({
    surface: SURFACE,
    space: s.space,
    viewer: s.viewer,
    origin: s.origin,
    menu: s.menu,
    css: TRIPS_CSS,
    environment: s.environment,
    localNav:
      s.viewer.role !== null &&
      s.viewer.role !== "owner" &&
      roleLevel(s.viewer.role) >= roleLevel("staff")
        ? [...TRIPS_NAV, { href: "/trips/admin", label: "Manage trips" }]
        : TRIPS_NAV,
    localNavActive: input.localNavActive ?? "/trips",
    description: description ?? `Trips at ${s.space.name}.`,
    ...rest,
  });
}

export function unavailable(s: Scope, canonicalPath: string, status = 503): Response {
  return page(s, {
    title: "Trips unavailable",
    canonicalPath,
    cache: "no-store",
    status,
    content: renderState(
      "Trips unavailable",
      "We could not load trips right now. Please try again.",
    ),
  });
}

export function notAvailable(s: Scope, canonicalPath: string): Response {
  return page(s, {
    title: "Trip unavailable",
    canonicalPath,
    backPath: "/trips",
    cache: "no-store",
    status: 404,
    content: renderState(
      "Trip unavailable",
      "This trip could not be found, or is not available to you.",
      s.viewer.signedIn
        ? { href: "/trips", label: "All trips" }
        : { href: `/login?return=${encodeURIComponent(canonicalPath)}`, label: "Sign in" },
    ),
  });
}
