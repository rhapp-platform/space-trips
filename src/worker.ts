// The Worker's entry: the pages, plus the RPC entrypoint the gateway binds.
// Kept apart from index.ts so tests can load the app without the Workers runtime.
import { WorkerEntrypoint } from "cloudflare:workers";
import { cliOp, type CliResult } from "./cli";
import { people } from "./people";
import { callTrips } from "./trips";
import app from "./index";
import type { Env } from "./types";

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

export default app;
