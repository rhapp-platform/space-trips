// The Worker's entry: the pages, plus the RPC entrypoint the gateway binds.
// Kept apart from index.ts so tests can load the app without the Workers runtime.
import { WorkerEntrypoint } from "cloudflare:workers";
import { cliOp, type CliResult } from "./cli";
import { people } from "./people";
import { callTrips } from "./trips";
import { tripChoices, tripView, type AccessOptions, type Looker, type TripChoice, type TripView } from "./view";
import app from "./index";
import type { Env, TripsResult } from "./types";

/**
 * `rhap trips`, bound by the my-rhapp-app gateway only. The gateway has
 * verified the caller and that they may manage `gn`; this entrypoint trusts
 * both and nothing in `input`.
 */
export class TripsCli extends WorkerEntrypoint<Env> {
  async trips(gn: string, actor: string, op: string, input: Record<string, unknown> = {}): Promise<CliResult> {
    if (typeof gn !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(gn)) return { ok: false, status: 400, message: "Invalid space name." };
    if (typeof actor !== "string" || !actor.trim()) return { ok: false, status: 400, message: "An actor is required." };
    const env = this.env;
    return cliOp(
      { call: (operation, args = []) => callTrips(env, gn, operation, args), people: people(env, gn) },
      gn, actor, String(op), input && typeof input === "object" && !Array.isArray(input) ? input : {},
    );
  }
}

const GN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TRP = /^trp_[0-9A-Za-z]{26}$/;

/**
 * The finished trip for one viewer, for the registry's `trip/1` reference
 * (app-design-registry ADR 0007). Bound by rhapp-app only, which has read the
 * viewer's role session for `gn`: this entrypoint trusts `viewer` and decides
 * everything else through the same gate as the trip page. `null` = missing or
 * not for this viewer, deliberately indistinguishable.
 */
export class TripsView extends WorkerEntrypoint<Env> {
  async view(gn: string, viewer: Looker, tripId: string, options: AccessOptions = {}): Promise<TripsResult<TripView | null>> {
    if (typeof gn !== "string" || !GN.test(gn)) return { ok: false, status: 400, message: "Invalid space name." };
    if (typeof tripId !== "string" || !TRP.test(tripId)) return { ok: true, value: null };
    const looker: Looker = {
      uid: typeof viewer?.uid === "string" && viewer.uid ? viewer.uid : null,
      role: typeof viewer?.role === "string" && viewer.role ? viewer.role : null,
      signedIn: viewer?.signedIn === true,
    };
    const env = this.env;
    return tripView(
      { call: (op, args) => callTrips(env, gn, op, args), people: people(env, gn), gn, environment: env.ENVIRONMENT },
      looker, tripId, { hideArchived: options?.hideArchived !== false },
    );
  }

  /** The space's trips for the editor's trip picker: staff only, otherwise empty. */
  async list(gn: string, viewer: Looker): Promise<TripsResult<TripChoice[]>> {
    if (typeof gn !== "string" || !GN.test(gn)) return { ok: false, status: 400, message: "Invalid space name." };
    const looker: Looker = {
      uid: typeof viewer?.uid === "string" && viewer.uid ? viewer.uid : null,
      role: typeof viewer?.role === "string" && viewer.role ? viewer.role : null,
      signedIn: viewer?.signedIn === true,
    };
    const env = this.env;
    return tripChoices({ call: (op, args) => callTrips(env, gn, op, args), gn }, looker);
  }
}

export default app;
