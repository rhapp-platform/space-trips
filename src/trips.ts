import type { Env, TripsResult } from "./types";

export async function callTrips<T>(
  env: Env,
  gn: string,
  op: string,
  args: unknown[] = [],
): Promise<TripsResult<T>> {
  try {
    return await (env.TRIPS_WORKER.trips(gn, op, args) as Promise<TripsResult<T>>);
  } catch (err: any) {
    return { ok: false, status: 503, message: err?.message ?? "Service temporarily unavailable." };
  }
}
