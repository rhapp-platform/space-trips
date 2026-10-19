import type { SurfaceEnv } from "../../space-surface/src";

export type TripsResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export interface TripsService {
  trips(gn: string, op: string, args?: unknown[]): Promise<TripsResult<unknown>>;
}

export interface Env extends SurfaceEnv {
  TRIPS_WORKER: TripsService;
  MANAGE_WORKER?: Fetcher;
}

export interface TripRow {
  id: string;
  gn: string;
  title: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  start_date: string | null;
  end_date: string | null;
  visibility: "private" | "members" | "public";
  created_by: string;
  created_at: string;
}

export interface SegmentRow {
  id: string;
  trip_id: string;
  type: "flight" | "hotel" | "car" | "activity" | "other";
  label: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  confirmation_ref: string | null;
  notes: string | null;
  position: number;
  created_at: string;
}

export interface MemberRow {
  trip_id: string;
  member_id: string;
  role: "owner" | "traveler" | "viewer";
  added_at: string;
}

export interface TripDetail {
  trip: TripRow;
  segments: SegmentRow[];
  members: MemberRow[];
}
