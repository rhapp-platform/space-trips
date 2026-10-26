/**
 * Member lookups: the admin searches the space's people, and the admin and
 * the trip page (for travelers and staff only) name the people on a trip.
 *
 * Reads go through the space store's member accounts entrypoint, with the same
 * begin/finish permit as home/src/members.ts. That entrypoint returns full
 * `space_users` rows, credentials included, so this module projects each row
 * to an id and a display name at once and nothing else leaves it.
 *
 * Without the MEMBER_ACCOUNTS binding, `people()` returns null and the admin
 * falls back to entering a member ID by hand.
 *
 * The CLI (admin-only, see cli.ts) also needs a person's email and username:
 * a trip file names travelers by email. `Contact` adds those two and nothing else.
 */
import type { Env, MemberAccounts, MemberPermit, MemberResult } from "./types";

export interface Person {
  id: string;
  label: string;
}

/** A person as the admin CLI names them: never credentials. */
export interface Contact extends Person {
  email: string | null;
  username: string;
}

export interface People {
  /** Enabled members whose username, email or external id contains `query`. */
  search(query: string): Promise<Person[]>;
  /** Names for the given ids; unknown or disabled ids are left out. */
  find(ids: string[]): Promise<Map<string, Person>>;
  /** The enabled member with this email, username or member ID, or null. */
  resolve(ref: string): Promise<Contact | null>;
  /** Email and username for the given ids; unknown or disabled ids are left out. */
  contacts(ids: string[]): Promise<Map<string, Contact>>;
}

interface UserRow {
  id: string;
  username: string;
  directory_name: string | null;
  email?: string | null;
  status: string;
}

export const SEARCH_LIMIT = 20;
const FIND_LIMIT = 50;

function unwrap<T>(result: MemberResult<T>): T {
  if (!result.ok) throw new Error("The member list is unavailable right now.");
  return result.value;
}

function person(row: UserRow | null): Person | null {
  if (!row || row.status !== "enabled") return null;
  return { id: row.id, label: row.directory_name?.trim() || row.username };
}

async function withPermit<T>(
  binding: MemberAccounts,
  gn: string,
  work: (call: (operation: string, args: unknown[]) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const permit: MemberPermit = unwrap(await binding.begin(gn, "read"));
  if (permit.backend !== "store") {
    unwrap(await binding.finish(gn, permit));
    throw new Error("This space's members are not in its space store.");
  }
  const value = await work(async (operation, args) => unwrap(await binding.account(gn, permit, operation, args)));
  unwrap(await binding.finish(gn, permit));
  return value;
}

function contact(row: UserRow | null): Contact | null {
  const p = person(row);
  return p && { ...p, email: row!.email?.trim() || null, username: row!.username };
}

export function people(env: Env, gn: string): People | null {
  const binding = env.MEMBER_ACCOUNTS;
  if (!binding) return null;
  return {
    search: (query) =>
      withPermit(binding, gn, async (call) => {
        const { rows } = (await call("listUsers", [
          { q: query, limit: SEARCH_LIMIT, sort: "username", dir: "asc" },
        ])) as { rows: UserRow[] };
        return rows.map(person).filter((p): p is Person => p !== null);
      }),
    find: (ids) =>
      withPermit(binding, gn, async (call) => {
        const found = new Map<string, Person>();
        for (const id of [...new Set(ids)].slice(0, FIND_LIMIT)) {
          const p = person((await call("findUserById", [id])) as UserRow | null);
          if (p) found.set(id, p);
        }
        return found;
      }),
    resolve: (ref) =>
      withPermit(binding, gn, async (call) => {
        const value = ref.trim();
        if (!value || value.length > 256) return null;
        // findUserByIdentifier matches a username as given, or a lowercased email.
        const byIdentifier = contact((await call("findUserByIdentifier", [value.includes("@") ? value.toLowerCase() : value])) as UserRow | null);
        return byIdentifier ?? contact((await call("findUserById", [value])) as UserRow | null);
      }),
    contacts: (ids) =>
      withPermit(binding, gn, async (call) => {
        const found = new Map<string, Contact>();
        for (const id of [...new Set(ids)].slice(0, FIND_LIMIT)) {
          const p = contact((await call("findUserById", [id])) as UserRow | null);
          if (p) found.set(id, p);
        }
        return found;
      }),
  };
}
