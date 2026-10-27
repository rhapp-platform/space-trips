import { describe, expect, test } from "bun:test";
import { cliOp, type CliDeps, type CliResult } from "./cli";
import { people } from "./people";
import { SEG, TRIP, fakeMemberAccounts, fakeTrips } from "./testing";
import type { Env } from "./types";

const GN = "renner";
const ACTOR = "account:glenn";

function setup(options: Parameters<typeof fakeTrips>[0] & { directory?: boolean } = {}) {
  const store = fakeTrips(options);
  const accounts = fakeMemberAccounts();
  const env = { TRIPS_WORKER: store.service, MEMBER_ACCOUNTS: options.directory === false ? undefined : accounts.binding } as unknown as Env;
  const deps: CliDeps = {
    call: (op, args = []) => store.service.trips(GN, op, args) as never,
    people: people(env, GN),
  };
  const run = (op: string, input: Record<string, unknown> = {}) => cliOp(deps, GN, ACTOR, op, input);
  return { store, run };
}

function value(r: CliResult): any {
  if (!r.ok) throw new Error(`expected ok, got ${r.status}: ${r.message}`);
  return r.value;
}

function failure(r: CliResult): { status: number; message: string } {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.value)}`);
  return r;
}

const DENVER = {
  title: "Denver offsite",
  start_date: "2027-03-14",
  end_date: "2027-03-17",
  visibility: "members",
  item: [
    {
      kind: "flight", name: "Flight to Denver",
      start: "2027-03-14T08:05", start_tz: "america/chicago",
      end: "2027-03-14T09:40", end_tz: "America/Denver",
      airline: "United", flight_number: "UA 512", from: "ORD", to: "DEN", seat: "14C",
    },
    { kind: "hotel", name: "Hotel Monaco", start: "2027-03-14T15:00", end: "2027-03-17T11:00", address: "1717 Champa St, Denver", room: "412" },
  ],
  traveler: [{ member: "Lee@Example.com", role: "traveler" }],
};

async function applied(run: ReturnType<typeof setup>["run"], document: unknown, extra: Record<string, unknown> = {}) {
  const dry = value(await run("apply", { document, dryRun: true, ...extra }));
  return { dry, done: value(await run("apply", { document, expect: dry.hash, ...extra })) };
}

describe("kinds", () => {
  test("come from kinds.ts, with the file's name for each location", async () => {
    const { run } = setup();
    const { kinds } = value(await run("kinds"));
    expect(kinds.map((k: any) => k.kind)).toEqual(["flight", "hotel", "activity", "other"]);
    expect(kinds.find((k: any) => k.kind === "hotel").location).toBe("address");
    expect(kinds.find((k: any) => k.kind === "flight").location).toBeNull();
    expect(kinds.find((k: any) => k.kind === "flight").fields.find((f: any) => f.key === "seat").private).toBe(true);
  });
});

describe("apply: a new trip", () => {
  test("plans, then creates the trip, its items in order, and its travelers", async () => {
    const { run, store } = setup();
    const { dry, done } = await applied(run, DENVER);
    expect(dry.plan.steps.map((s: any) => s.op)).toEqual(["create-trip", "add-item", "add-item", "set-traveler"]);
    // The plan never carries private details.
    expect(JSON.stringify(dry.plan)).not.toContain("14C");
    expect(done.changes).toBe(4);
    const trip = store.trips.get(done.id)!;
    expect(trip).toMatchObject({ title: "Denver offsite", status: "draft", visibility: "members", created_by: ACTOR });
    const items = [...store.segments.values()].filter((s) => s.trip_id === done.id);
    expect(items.map((s) => s.label)).toEqual(["Flight to Denver", "Hotel Monaco"]);
    expect(JSON.parse(items[0]!.details!)).toMatchObject({ seat: "14C", start_tz: "America/Chicago", end_tz: "America/Denver" });
    expect(items[1]).toMatchObject({ location: "1717 Champa St, Denver" });
    // The creating account isn't left on the trip; the file says who is.
    expect(store.members.filter((m) => m.trip_id === done.id)).toEqual([expect.objectContaining({ member_id: "su_lee", role: "traveler" })]);
  });

  test("the same file again is refused while a trip has that name, unless --new", async () => {
    const { run } = setup();
    await applied(run, DENVER);
    const again = failure(await run("apply", { document: DENVER, dryRun: true }));
    expect(again.message).toContain('A trip called “Denver offsite” already exists');
    expect(again.message).toContain("--new");
    expect(value(await run("apply", { document: DENVER, dryRun: true, new: true })).plan.steps[0].op).toBe("create-trip");
  });
});

describe("apply: round trip", () => {
  test("an exported trip applies with nothing to change", async () => {
    const { run } = setup();
    const { done } = await applied(run, DENVER);
    const { document } = value(await run("show", { trip: done.id }));
    expect(document.traveler).toEqual([{ member: "lee@example.com", role: "traveler" }]);
    expect(document.item[1]).toMatchObject({ kind: "hotel", address: "1717 Champa St, Denver", room: "412" });
    const dry = value(await run("apply", { document, dryRun: true }));
    expect(dry.plan.steps).toEqual([]);
    expect(dry.plan.kept).toEqual([]);
  });

  test("items without ids match by kind, name and start, so applying twice adds nothing", async () => {
    const { run } = setup();
    const { done } = await applied(run, DENVER);
    const dry = value(await run("apply", { document: { ...DENVER, id: done.id }, dryRun: true }));
    expect(dry.plan.steps).toEqual([]);
  });

  test("edits show the fields that change, by their file names", async () => {
    const { run, store } = setup();
    const { done } = await applied(run, DENVER);
    const { document } = value(await run("show", { trip: done.id }));
    document.item[0].seat = "2A";
    delete document.item[1].room;
    document.title = "Denver offsite 2027";
    const { dry } = await applied(run, document);
    expect(dry.plan.steps).toEqual([
      { op: "update-trip", what: "trip", changes: ["title"] },
      { op: "update-item", what: "Item 1 (Flight to Denver)", changes: ["seat"] },
      { op: "update-item", what: "Item 2 (Hotel Monaco)", changes: ["room"] },
    ]);
    const hotel = [...store.segments.values()].find((s) => s.label === "Hotel Monaco")!;
    expect(hotel.details).toBeNull();
  });

  test("reordering writes positions; keeping the order leaves them alone", async () => {
    const { run } = setup();
    const { done } = await applied(run, DENVER);
    const { document } = value(await run("show", { trip: done.id }));
    document.item.reverse();
    const { dry } = await applied(run, document);
    expect(dry.plan.steps.map((s: any) => s.changes)).toEqual([["order"], ["order"]]);
    const after = value(await run("show", { trip: done.id }));
    expect(after.document.item.map((i: any) => i.name)).toEqual(["Hotel Monaco", "Flight to Denver"]);
  });
});

describe("apply: what isn't in the file", () => {
  test("is kept without --prune and removed with it", async () => {
    const { run, store } = setup();
    const { done } = await applied(run, DENVER);
    const short = { id: done.id, title: DENVER.title, start_date: DENVER.start_date, end_date: DENVER.end_date, item: [DENVER.item[0]] };
    const kept = value(await run("apply", { document: short, dryRun: true }));
    expect(kept.plan.steps).toEqual([]);
    expect(kept.plan.kept).toEqual(["Hotel “Hotel Monaco”", "traveler lee@example.com"]);
    const { dry } = await applied(run, short, { prune: true });
    expect(dry.plan.steps.map((s: any) => s.op)).toEqual(["remove-item", "remove-traveler"]);
    expect([...store.segments.values()].filter((s) => s.trip_id === done.id)).toHaveLength(1);
    expect(store.members.filter((m) => m.trip_id === done.id)).toEqual([]);
  });
});

describe("apply: refusals", () => {
  test("lists every problem at once, in the file's own words", async () => {
    const { run, store } = setup();
    const r = failure(await run("apply", {
      document: {
        title: "Bad trip", colour: "blue", start_date: "2027-02-30",
        item: [
          { kind: "hotel", name: "Hotel", rooom: "4" },
          { kind: "flight", name: "Back", start: "2027-03-17T18:00", start_tz: "America/Denver", end: "2027-03-17T18:30", end_tz: "America/Chicago" },
          { kind: "boat", name: "Ferry" },
          { kind: "other", name: "Lunch", start: "2027-03-15 12:00" },
          { kind: "hotel", name: "Room", room: 412 },
        ],
        traveler: [{ member: "nobody@example.com" }, { member: "lee", role: "captain" }],
      },
      dryRun: true,
    }));
    expect(r.status).toBe(400);
    expect(r.message).toContain("things need fixing before anything is saved");
    expect(r.message).toContain("“colour” isn't a trip field");
    expect(r.message).toContain("Item 1 (Hotel): “rooom” isn't a field of a hotel. A hotel takes: id, kind, name, start, start_tz, end, end_tz, address, phone, room, confirmation, notes, image.");
    expect(r.message).toContain("Item 2 (Back): “end” is before “start”. Check the two times and their time zones.");
    expect(r.message).toContain("Item 3 (Ferry): kind must be flight, hotel, activity, other.");
    expect(r.message).toContain("Item 4 (Lunch): “start” isn't complete. Write it as a date and a 24-hour time, like 2027-03-14T08:05.");
    expect(r.message).toContain('Item 5: put “room” in quotes, like room = "412".');
    expect(r.message).toContain("Traveler 1: no active member of this space has the email or username “nobody@example.com”.");
    expect(r.message).toContain("Traveler 2 (lee): role must be traveler, owner, viewer.");
    // Nothing reached the store but reads.
    expect(store.calls.every((c) => ["list", "get"].includes(c.op))).toBe(true);
  });

  test("a bad trip date says how to write one", async () => {
    const { run } = setup();
    const r = failure(await run("apply", { document: { title: "T", start_date: "2027-02-30" }, dryRun: true }));
    expect(r.message).toContain("The start date isn't a real date. Write it as year-month-day, like 2027-03-14.");
  });

  test("an item's kind can't change", async () => {
    const { run } = setup();
    const { document } = value(await run("show", { trip: TRIP }));
    document.item[0].kind = "hotel";
    const r = failure(await run("apply", { document, dryRun: true }));
    expect(r.message).toContain("this item is a flight, and an item's kind can't change");
  });

  test("an id from another trip is refused", async () => {
    const { run } = setup();
    const r = failure(await run("apply", { document: { title: "New", item: [{ id: SEG, kind: "flight", name: "x" }] }, dryRun: true, new: true }));
    expect(r.message).toContain(`the id ${SEG} isn't an item on this trip`);
  });

  test("a plan that changed after it was shown is refused", async () => {
    const { run, store } = setup();
    const dry = value(await run("apply", { document: DENVER, dryRun: true }));
    const r = failure(await run("apply", { document: { ...DENVER, title: "Other name" }, expect: dry.hash }));
    expect(r.status).toBe(409);
    expect(r.message).toContain("changed after you looked at the plan");
    expect(store.calls.some((c) => c.op === "create")).toBe(false);
  });

  test("a store failure part way through a new trip names the trip, and the file with its id finishes it", async () => {
    const { run, store } = setup({ fail: { op: "setMember", status: 503, message: "Trips storage is not ready." } });
    const r = failure(await run("apply", { document: DENVER }));
    const id = store.calls.find((c) => c.op === "create")!.args[0] as string;
    expect(r.message).toBe(`Stopped after 3 changes of 4: Trips storage is not ready. The trip was created as ${id}. To finish, add  id = "${id}"  at the top of the file and run the same command again; it shows only what is left.`);
    // The same file again, without the id, is refused as a twin; with it, only the traveler is left.
    expect(failure(await run("apply", { document: DENVER, dryRun: true })).message).toContain(`A trip called “Denver offsite” already exists (${id})`);
    const steps = value(await run("apply", { document: { id, ...DENVER }, dryRun: true })).plan.steps;
    expect(steps.map((s: any) => s.op)).toEqual(["set-traveler"]);
  });

  test("a store failure part way through an existing trip says to run it again", async () => {
    const { run } = setup({ fail: { op: "setMember", status: 503, message: "Trips storage is not ready." } });
    const { document } = value(await run("show", { trip: TRIP }));
    document.title = "Spring tour, renamed";
    document.traveler.push({ member: "Lee@Example.com" });
    const r = failure(await run("apply", { document }));
    expect(r.message).toBe("Stopped after 1 change of 2: Trips storage is not ready. Run the same command again to finish; it shows only what is left.");
  });
});

describe("single changes", () => {
  test("a trip by its title; edit clears a field with empty text", async () => {
    const { run, store } = setup();
    value(await run("edit", { trip: "spring <TOUR>", set: { description: "Ten days", end_date: "" } }));
    expect(store.trips.get(TRIP)).toMatchObject({ description: "Ten days", end_date: null });
  });

  test("item add, edit by number, remove", async () => {
    const { run, store } = setup();
    value(await run("item-add", { trip: TRIP, item: { kind: "activity", name: "Museum tour", start: "2026-11-02T10:00", host: "City Museum" } }));
    const { document } = value(await run("show", { trip: TRIP }));
    expect(document.item.map((i: any) => i.name)).toEqual(["Flight to Denver", "Museum tour"]);
    value(await run("item-edit", { trip: TRIP, item: "2", set: { meeting_point: "Front steps", host: "" } }));
    const museum = [...store.segments.values()].find((s) => s.label === "Museum tour")!;
    expect(JSON.parse(museum.details!)).toEqual({ meeting_point: "Front steps" });
    expect(failure(await run("item-edit", { trip: TRIP, item: "2", set: { kind: "hotel" } })).message).toContain("kind can't change");
    expect(failure(await run("item-edit", { trip: TRIP, item: "2", set: { start: "soon" } })).message).toContain("“start” isn't complete");
    value(await run("item-remove", { trip: TRIP, item: museum.id }));
    expect(store.segments.has(museum.id)).toBe(false);
    expect(failure(await run("item-remove", { trip: TRIP, item: "7" })).status).toBe(404);
  });

  test("travelers by email or username; remove --if-exists", async () => {
    const { run, store } = setup();
    expect(value(await run("traveler-add", { trip: TRIP, member: "lee", role: "viewer" }))).toEqual({ member: "lee", role: "viewer" });
    expect(store.members.find((m) => m.member_id === "su_lee")?.role).toBe("viewer");
    expect(failure(await run("traveler-add", { trip: TRIP, member: "gone@example.com" })).message).toContain("No active member");
    value(await run("traveler-remove", { trip: TRIP, member: "LEE@example.com" }));
    expect(store.members.some((m) => m.member_id === "su_lee")).toBe(false);
    expect(value(await run("traveler-remove", { trip: TRIP, member: "lee", ifExists: true }))).toEqual({ removed: 0 });
  });

  test("delete reports what went with the trip", async () => {
    const { run, store } = setup();
    expect(value(await run("delete", { trip: TRIP }))).toEqual({ id: TRIP, title: "Spring <tour>", items: 1, travelers: 1 });
    expect(store.trips.has(TRIP)).toBe(false);
  });

  test("an unknown trip says how to find one", async () => {
    const { run } = setup();
    expect(failure(await run("show", { trip: "Nowhere" })).message).toBe("No trip is called “Nowhere”. See the trips with: rhap trips list");
  });
});

describe("without a member directory", () => {
  test("travelers are member IDs, and export writes them as IDs", async () => {
    const { run } = setup({ directory: false });
    const { document } = value(await run("show", { trip: TRIP }));
    expect(document.traveler).toEqual([{ member: "su_dana", role: "owner" }]);
    expect(value(await run("apply", { document, dryRun: true })).plan.steps).toEqual([]);
  });

  test("a new traveler is refused rather than stored unchecked", async () => {
    const { run, store } = setup({ directory: false });
    const { document } = value(await run("show", { trip: TRIP }));
    document.traveler.push({ member: "lee@example.com" });
    expect(failure(await run("apply", { document, dryRun: true })).message).toContain("the member list can't be searched right now");
    expect(failure(await run("traveler-add", { trip: TRIP, member: "lee@example.com" })).status).toBe(503);
    expect(store.calls.some((c) => c.op === "setMember")).toBe(false);
  });
});

describe("images", () => {
  const REV = "a".repeat(64);
  const REV2 = "b".repeat(64);
  const withImages = (store: ReturnType<typeof fakeTrips>) => {
    store.trips.set(TRIP, { ...store.trips.get(TRIP)!, cover_tag: "spring-cover", cover_revision: REV });
    store.segments.set(SEG, { ...store.segments.get(SEG)!, image_tag: "plane", image_revision: REV });
  };

  test("export writes the cover and each item's image by tag, and the export applies with no changes", async () => {
    const { run, store } = setup();
    withImages(store);
    const { document } = value(await run("show", { trip: TRIP }));
    expect(document.cover).toBe("spring-cover");
    expect(document.item[0].image).toBe("plane");
    const dry = value(await run("apply", { document, dryRun: true }));
    expect(dry.plan.steps).toEqual([]);
    expect(dry.needs).toEqual([]);
  });

  test("a new tag needs a revision: the plan names it, then sets it once the CLI has pinned it", async () => {
    const { run, store } = setup();
    const { document } = value(await run("show", { trip: TRIP }));
    document.cover = "denver-skyline";
    document.item[0].image = "plane";
    const first = value(await run("apply", { document, dryRun: true }));
    expect(first.needs).toEqual(["denver-skyline", "plane"]);
    expect(first.plan.steps).toEqual([]);
    // Writing without the revisions is refused, and nothing is saved.
    expect(failure(await run("apply", { document, expect: first.hash })).message).toContain("rhap images pin: denver-skyline, plane");
    const revisions = { "denver-skyline": REV, plane: REV2 };
    const second = value(await run("apply", { document, dryRun: true, revisions }));
    expect(second.needs).toEqual([]);
    expect(second.plan.steps.map((s: any) => [s.op, s.changes])).toEqual([["update-trip", ["cover"]], ["update-item", ["image"]]]);
    value(await run("apply", { document, expect: second.hash, revisions }));
    expect(store.trips.get(TRIP)).toMatchObject({ cover_tag: "denver-skyline", cover_revision: REV });
    expect(store.segments.get(SEG)).toMatchObject({ image_tag: "plane", image_revision: REV2 });
  });

  test("the same tag is not a change, even with a newer revision; a missing line keeps the image", async () => {
    const { run, store } = setup();
    withImages(store);
    const { document } = value(await run("show", { trip: TRIP }));
    const dry = value(await run("apply", { document, dryRun: true, revisions: { plane: REV2, "spring-cover": REV2 } }));
    expect(dry.plan.steps).toEqual([]);
    delete document.cover;
    delete document.item[0].image;
    expect(value(await run("apply", { document, dryRun: true })).plan.steps).toEqual([]);
  });

  test("empty text removes an image", async () => {
    const { run, store } = setup();
    withImages(store);
    const { document } = value(await run("show", { trip: TRIP }));
    document.cover = "";
    document.item[0].image = "";
    await applied(run, document);
    expect(store.trips.get(TRIP)).toMatchObject({ cover_tag: null, cover_revision: null });
    expect(store.segments.get(SEG)).toMatchObject({ image_tag: null, image_revision: null });
  });

  test("a name that can't be a tag is refused, and a revision for the wrong shape is ignored", async () => {
    const { run } = setup();
    const { document } = value(await run("show", { trip: TRIP }));
    document.item[0].image = "Hotel Monaco.jpg";
    expect(failure(await run("apply", { document, dryRun: true })).message).toContain("image “Hotel Monaco.jpg” isn't an image name");
    document.item[0].image = "monaco";
    expect(value(await run("apply", { document, dryRun: true, revisions: { monaco: "not-a-revision" } })).needs).toEqual(["monaco"]);
  });

  test("single changes: an item and the trip take an image; empty text removes it", async () => {
    const { run, store } = setup();
    expect(failure(await run("item-edit", { trip: TRIP, item: "1", set: { image: "plane" } })).message).toContain("rhap images pin: plane");
    value(await run("item-edit", { trip: TRIP, item: "1", set: { image: "plane" }, revisions: { plane: REV } }));
    expect(store.segments.get(SEG)).toMatchObject({ image_tag: "plane", image_revision: REV });
    value(await run("item-edit", { trip: TRIP, item: "1", set: { image: "" } }));
    expect(store.segments.get(SEG)).toMatchObject({ image_tag: null, image_revision: null });
    value(await run("edit", { trip: TRIP, set: { cover: "spring" }, revisions: { spring: REV } }));
    expect(store.trips.get(TRIP)).toMatchObject({ cover_tag: "spring", cover_revision: REV });
    value(await run("item-add", { trip: TRIP, item: { kind: "hotel", name: "Hotel Monaco", image: "monaco" }, revisions: { monaco: REV2 } }));
    expect([...store.segments.values()].find((s) => s.label === "Hotel Monaco")).toMatchObject({ image_tag: "monaco", image_revision: REV2 });
  });

  test("a single change that names the same tag takes its newer frozen revision; other changes leave it", async () => {
    const { run, store } = setup();
    withImages(store);
    // The library picture was replaced and frozen again: naming it moves the trip to the new one.
    expect(value(await run("edit", { trip: TRIP, set: { cover: "spring-cover" }, revisions: { "spring-cover": REV2 } })).changes).toBe(1);
    expect(store.trips.get(TRIP)).toMatchObject({ cover_tag: "spring-cover", cover_revision: REV2 });
    expect(value(await run("item-edit", { trip: TRIP, item: "1", set: { image: "plane" }, revisions: { plane: REV2 } })).changes).toBe(1);
    expect(store.segments.get(SEG)).toMatchObject({ image_tag: "plane", image_revision: REV2 });
    // The revision it already shows is nothing to change.
    expect(value(await run("item-edit", { trip: TRIP, item: "1", set: { image: "plane" }, revisions: { plane: REV2 } })).changes).toBe(0);
    // A change that doesn't name the picture never moves it.
    store.segments.set(SEG, { ...store.segments.get(SEG)!, image_revision: REV });
    value(await run("item-edit", { trip: TRIP, item: "1", set: { notes: "Window seat" }, revisions: { plane: REV2 } }));
    expect(store.segments.get(SEG)).toMatchObject({ image_tag: "plane", image_revision: REV });
    value(await run("edit", { trip: TRIP, set: { title: "Spring 2027" }, revisions: { "spring-cover": REV } }));
    expect(store.trips.get(TRIP)).toMatchObject({ cover_tag: "spring-cover", cover_revision: REV2 });
  });

  test("an item without an id that matches a stored one keeps its image", async () => {
    const { run, store } = setup();
    withImages(store);
    const { document } = value(await run("show", { trip: TRIP }));
    delete document.item[0].id;
    const dry = value(await run("apply", { document, dryRun: true }));
    expect(dry.needs).toEqual([]);
    expect(dry.plan.steps).toEqual([]);
  });
});
