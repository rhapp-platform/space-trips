/**
 * What each kind of itinerary item asks for. The store keeps `details` as a
 * flat object of short text; the keys and their meaning live here, so a new
 * field needs no schema step.
 */
import type { SegmentRow } from "./types";

export interface DetailField {
  key: string;
  label: string;
  hint?: string;
  /** Shown only to the trip's travelers and to staff, never on a public page. */
  private?: boolean;
}

export interface Kind {
  type: SegmentRow["type"];
  name: string;
  /** An `mdi:` icon name, for designs that show one per kind. */
  icon: string;
  /** Placeholder-style example for the item's name. */
  example: string;
  start: string;
  end: string;
  /** Label for the `location` column, or null when the kind doesn't use it. */
  location: string | null;
  details: DetailField[];
}

export const DETAIL_MAX = 300;

/** Offered when adding an item, in this order. */
export const KINDS: Kind[] = [
  {
    type: "flight",
    icon: "mdi:airplane",
    name: "Flight",
    example: "Flight to Denver",
    start: "Departs",
    end: "Arrives",
    location: null,
    details: [
      { key: "airline", label: "Airline" },
      { key: "flight_number", label: "Flight number", hint: "For example UA 512." },
      { key: "from", label: "From", hint: "Airport or city, like ORD or Chicago." },
      { key: "to", label: "To", hint: "Airport or city, like DEN or Denver." },
      { key: "seat", label: "Seat", private: true },
    ],
  },
  {
    type: "hotel",
    icon: "mdi:bed",
    name: "Hotel",
    example: "Hotel Monaco",
    start: "Check-in",
    end: "Check-out",
    location: "Address",
    details: [
      { key: "phone", label: "Phone" },
      { key: "room", label: "Room", private: true },
    ],
  },
  {
    type: "activity",
    icon: "mdi:ticket",
    name: "Activity",
    example: "Museum tour",
    start: "Starts",
    end: "Ends",
    location: "Place",
    details: [
      { key: "host", label: "Run by", hint: "The company, guide or venue." },
      { key: "meeting_point", label: "Where to meet" },
    ],
  },
  {
    type: "other",
    icon: "mdi:map-marker",
    name: "Other",
    example: "Free afternoon",
    start: "Starts",
    end: "Ends",
    location: "Place",
    details: [],
  },
];

/** Not offered for new items; kept so items saved as cars still edit and show. */
const CAR: Kind = {
  type: "car",
  icon: "mdi:car",
  name: "Car",
  example: "Rental car",
  start: "Pick-up",
  end: "Drop-off",
  location: "Pick-up place",
  details: [],
};

export function kindOf(type: string): Kind | undefined {
  return KINDS.find((k) => k.type === type) ?? (type === "car" ? CAR : undefined);
}

/** The stored JSON as a plain object; anything unreadable is treated as empty. */
export function readDetails(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** Labelled details in the kind's order, leaving out private ones unless allowed. */
export function shownDetails(seg: SegmentRow, insider: boolean): [string, string][] {
  const kind = kindOf(seg.type);
  const values = readDetails(seg.details);
  return (kind?.details ?? [])
    .filter((f) => values[f.key] && (insider || !f.private))
    .map((f) => [f.label, values[f.key]!]);
}
