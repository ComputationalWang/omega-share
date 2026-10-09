import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  CLOSE_CODES,
  CreateRoomResponseSchema,
  DEFAULT_LAYOUT,
  ROOM_EDIT_BURST,
  ROOM_EDIT_REFILL_MS,
  type CreateRoomResponse,
  type RoomLayout,
  type RoomVisibility,
} from "@omega/shared";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, start, type TestServer } from "./helpers";

/** Owner and invite auth on `join`, owner-only `layout-set` / `title-set` (ADR 0028 §3, §4, §6; OME-406). */

let t: TestServer | null = null;
let db: Database | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
});

function fail(): never {
  throw new Error("no server");
}
const server = (): TestServer => t ?? fail();
function fakeClock() {
  const clock = { ms: 1_000_000, now: () => clock.ms };
  return clock;
}

let nextAddress = 1;
/** A fresh client address each call, so tests don't share per-key buckets. */
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

type Created = Extract<CreateRoomResponse, { ok: true }>;
async function createRoom(visibility: RoomVisibility, title = "Friday films"): Promise<Created> {
  const res = await fetch(`${server().http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
    body: JSON.stringify({ title, visibility }),
  });
  expect(res.status).toBe(201);
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (!body.ok) throw new Error(`create failed: ${body.error.code}`);
  return body;
}

async function open(roomId: string, address = freshAddress()): Promise<Client> {
  const c = await Client.open(server().ws(roomId), undefined, { "x-forwarded-for": address });
  clients.push(c);
  return c;
}

interface JoinInit {
  ownerToken?: string;
  inviteKey?: string;
  address?: string;
}
async function joined(roomId: string, nickname: string, init: JoinInit = {}) {
  const client = await open(roomId, init.address);
  client.send({ type: "join", nickname, avatar: 0, ...pick(init) });
  return { client, snapshot: await client.next("snapshot") };
}
const pick = ({ ownerToken, inviteKey }: JoinInit) => ({
  ...(ownerToken === undefined ? {} : { ownerToken }),
  ...(inviteKey === undefined ? {} : { inviteKey }),
});

/**
 * Sends one frame at a time, waiting for its reply, until the server closes the socket (at most 40
 * frames). With a fake clock, advances it `stepMs` per frame so the per-socket and per-key limiters refill.
 */
async function untilClosed(c: Client, stepMs: number, send: () => void, clock?: { ms: number }): Promise<void> {
  for (let i = 0; i < 40 && c.socket.readyState === WebSocket.OPEN; i++) {
    if (clock !== undefined) clock.ms += stepMs;
    send();
    await Promise.race([c.next("error").catch(() => undefined), c.closed]);
  }
}

/** "snapshot", or the error code, whichever reply comes first. */
async function snapshotOrError(c: Client): Promise<string> {
  for (let waited = 0; waited < 1000; waited += 5) {
    for (const frame of c.raw) {
      const msg = JSON.parse(frame) as { type: string; code?: string };
      if (msg.type === "snapshot") return "snapshot";
      if (msg.type === "error" && msg.code !== undefined) return msg.code;
    }
    await Bun.sleep(5);
  }
  throw new Error("no snapshot or error");
}

/** A function, so the compiler doesn't narrow `readyState` across awaits. */
const isOpen = (c: Client): boolean => c.socket.readyState === WebSocket.OPEN;

/** A well-formed secret that matches nothing: 22 base64url chars. */
const WRONG = "AAAAAAAAAAAAAAAAAAAAAA";

/** DEFAULT_LAYOUT with its first piece moved: a different, still valid, layout. */
function movedLayout(): RoomLayout {
  const pieces = DEFAULT_LAYOUT.furniture.map((p) => ({ ...p }));
  const first = pieces[0];
  if (first === undefined) throw new Error("DEFAULT_LAYOUT has no furniture");
  return { ...DEFAULT_LAYOUT, furniture: [...pieces.slice(1), first] };
}

describe("join a private room (ADR 0028 §4)", () => {
  test("without an invite key: invite_required, the socket stays open and unjoined, and members hear nothing", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const inside = await joined(room.room.id, "alice", { inviteKey: room.inviteKey ?? fail() });
    const c = await open(room.room.id);
    c.send({ type: "join", nickname: "mallory", avatar: 0 });
    expect((await c.next("error")).code).toBe("invite_required");
    await inside.client.none("member-joined", 100);
    // Still unjoined: anything else is not_joined, and the socket is open.
    c.send({ type: "chat", text: "hi" });
    expect((await c.next("error")).code).toBe("not_joined");
    expect(c.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("with a wrong invite key: invite_required", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const c = await open(room.room.id);
    c.send({ type: "join", nickname: "mallory", avatar: 0, inviteKey: WRONG });
    expect((await c.next("error")).code).toBe("invite_required");
  });

  test("with the invite key: joins as a guest, and can then retry after a refusal on the same socket", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const c = await open(room.room.id);
    c.send({ type: "join", nickname: "bob", avatar: 0 });
    expect((await c.next("error")).code).toBe("invite_required");
    c.send({ type: "join", nickname: "bob", avatar: 0, inviteKey: room.inviteKey });
    const snap = await c.next("snapshot");
    expect(snap.room.id).toBe(room.room.id);
    expect(snap.owner).toBeUndefined();
  });

  test("with the owner token and no invite key: joins as the owner", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const { snapshot } = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    expect(snapshot.owner).toBe(true);
  });

  test("a public room needs no invite key", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const { snapshot } = await joined(room.room.id, "bob");
    expect(snapshot.owner).toBeUndefined();
  });

  test("failed invite keys come out of their own per-key bucket: once it is empty the join is rate_limited, and other keys still get in", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const room = await createRoom("private");
    const address = "203.0.113.50";
    const codes: string[] = [];
    // Fresh sockets, and 5 s apart so the join and upgrade limiters refill: only the failed-invite bucket runs dry.
    for (let i = 0; i < 12; i++) {
      clock.ms += 5000;
      const c = await open(room.room.id, address);
      c.send({ type: "join", nickname: `m${String(i)}`, avatar: 0, inviteKey: WRONG });
      codes.push((await c.next("error")).code);
      c.close();
      await c.closed;
    }
    expect(codes[0]).toBe("invite_required");
    expect(codes.at(-1)).toBe("rate_limited");
    const other = await open(room.room.id, "203.0.113.51");
    other.send({ type: "join", nickname: "bob", avatar: 0, inviteKey: room.inviteKey });
    await other.next("snapshot");
  });

  test("failed invite keys count toward the 4400 bad-message close", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const room = await createRoom("private");
    const c = await open(room.room.id);
    await untilClosed(c, 5000, () => {
      c.send({ type: "join", nickname: "mallory", avatar: 0, inviteKey: WRONG });
    }, clock);
    expect((await c.closed).code).toBe(CLOSE_CODES.BAD_MESSAGES);
  });
});

describe("join with an owner token (ADR 0028 §3)", () => {
  test("the matching token makes this socket the owner; nobody else's snapshot says owner", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob");
    expect(owner.snapshot.owner).toBe(true);
    expect(guest.snapshot.owner).toBeUndefined();
    // The flag is never broadcast: the member-joined others get for the owner carries nothing extra.
    const other = await joined(room.room.id, "carol");
    const late = await joined(room.room.id, "dave", { ownerToken: room.ownerToken });
    expect(late.snapshot.owner).toBe(true);
    const announced = await other.client.next("member-joined");
    expect(Object.keys(announced.member).sort()).toEqual(["avatar", "id", "nickname"]);
    expect(other.client.raw.some((f) => f.includes('"owner"'))).toBe(false);
  });

  test("a wrong but well-formed token joins as a guest", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const { snapshot } = await joined(room.room.id, "mallory", { ownerToken: WRONG });
    expect(snapshot.owner).toBeUndefined();
  });

  test("another room's owner token doesn't make you this room's owner", async () => {
    t = start({ trustProxy: true });
    const a = await createRoom("public", "Room A");
    const b = await createRoom("public", "Room B");
    const { snapshot } = await joined(b.room.id, "olive", { ownerToken: a.ownerToken });
    expect(snapshot.owner).toBeUndefined();
  });

  test("a pinned room (the lobby) has no owner, whatever the token", async () => {
    t = start({ trustProxy: true });
    const { snapshot } = await joined("lobby", "olive", { ownerToken: WRONG });
    expect(snapshot.owner).toBeUndefined();
  });

  test("a malformed owner token or invite key fails the strict parse: bad_message", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const c = await open(room.room.id);
    c.send({ type: "join", nickname: "mallory", avatar: 0, ownerToken: "short" });
    expect((await c.next("error")).code).toBe("bad_message");
    c.send({ type: "join", nickname: "mallory", avatar: 0, inviteKey: "x".repeat(23) });
    expect((await c.next("error")).code).toBe("bad_message");
  });

  test("failed owner tokens come out of their own per-key bucket: once it is empty the join is rate_limited", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const room = await createRoom("public");
    const address = "203.0.113.60";
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) {
      clock.ms += 5000;
      const c = await open(room.room.id, address);
      c.send({ type: "join", nickname: `m${String(i)}`, avatar: 0, ownerToken: WRONG });
      codes.push(await snapshotOrError(c));
      c.close();
      await c.closed;
    }
    expect(codes[0]).toBe("snapshot");
    expect(codes.at(-1)).toBe("rate_limited");
    // The failed-invite bucket is separate: a private room still answers invite_required, not rate_limited.
    const priv = await createRoom("private");
    clock.ms += 5000;
    const c = await open(priv.room.id, address);
    c.send({ type: "join", nickname: "mallory", avatar: 0 });
    expect((await c.next("error")).code).toBe("invite_required");
  });
});

describe("failed secrets: 4400 and retryAfterMs (QA notes on OME-447)", () => {
  test("wrong owner tokens count toward the 4400 bad-message close, even while they still join as a guest", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const room = await createRoom("public");
    const c = await open(room.room.id);
    for (let i = 0; i < 40 && isOpen(c); i++) {
      clock.ms += 5000;
      const seen = c.raw.length;
      c.send({ type: "leave" });
      c.send({ type: "join", nickname: "mallory", avatar: 0, ownerToken: WRONG });
      // The leave has no reply; wait for the join's (snapshot, rate_limited) or the close.
      for (let w = 0; w < 200 && c.raw.length === seen && isOpen(c); w++) await Bun.sleep(5);
    }
    expect((await c.closed).code).toBe(CLOSE_CODES.BAD_MESSAGES);
  });

  test("a join refused by a dry failed-invite bucket carries retryAfterMs, at most 30 s", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const c = await open(room.room.id);
    let err = await (async () => {
      c.send({ type: "join", nickname: "mallory", avatar: 0, inviteKey: WRONG });
      return c.next("error");
    })();
    for (let i = 0; i < 10 && err.code !== "rate_limited"; i++) {
      c.send({ type: "join", nickname: "mallory", avatar: 0, inviteKey: WRONG });
      err = await c.next("error");
    }
    expect(err.code).toBe("rate_limited");
    expect(err.message).toContain("wrong invite keys");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(30_000);
  });
});

describe("layout-set and title-set (ADR 0028 §6)", () => {
  test("the owner's layout-set is broadcast as layout-changed to everyone, seats are kept, and it survives a restart", async () => {
    db = openDatabase(":memory:");
    t = start({ trustProxy: true, store: new RoomStore(db) });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob");
    guest.client.send({ type: "sit", seat: 3 });
    await owner.client.next("seat-changed");
    const layout = movedLayout();
    owner.client.send({ type: "layout-set", layout });
    const seen = await guest.client.next("layout-changed");
    expect(seen.layout).toEqual(layout);
    expect(seen.by).toBe(owner.snapshot.self);
    expect((await owner.client.next("layout-changed")).layout).toEqual(layout);
    await guest.client.none("seat-changed", 50);
    // A later joiner sees the new layout and bob still on seat 3.
    const late = await joined(room.room.id, "carol");
    expect(late.snapshot.room.layout).toEqual(layout);
    expect(late.snapshot.room.seats[3]).toBe(guest.snapshot.self);
    // Written to the store.
    const row = new RoomStore(db).listRooms().find((r) => r.id === room.room.id);
    expect(row?.layout).toEqual(layout);
  });

  test("the owner's title-set is broadcast as title-changed, written to the store and shown in GET /rooms", async () => {
    db = openDatabase(":memory:");
    t = start({ trustProxy: true, store: new RoomStore(db) });
    const room = await createRoom("public", "Old title");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob");
    owner.client.send({ type: "title-set", title: "  New title " });
    const seen = await guest.client.next("title-changed");
    expect(seen.title).toBe("New title");
    expect(seen.by).toBe(owner.snapshot.self);
    expect(new RoomStore(db).listRooms().find((r) => r.id === room.room.id)?.title).toBe("New title");
    const list = (await (await fetch(`${server().http}/rooms`)).json()) as { rooms: { id: string; title?: string }[] };
    expect(list.rooms.find((r) => r.id === room.room.id)?.title).toBe("New title");
  });

  test("a guest gets not_owner and nothing changes; repeats count toward 4400", async () => {
    const clock = fakeClock();
    db = openDatabase(":memory:");
    t = start({ trustProxy: true, store: new RoomStore(db), now: clock.now });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob", { ownerToken: WRONG });
    guest.client.send({ type: "layout-set", layout: movedLayout() });
    expect((await guest.client.next("error")).code).toBe("not_owner");
    guest.client.send({ type: "title-set", title: "Hijacked" });
    expect((await guest.client.next("error")).code).toBe("not_owner");
    await owner.client.none("layout-changed", 100);
    await owner.client.none("title-changed", 0);
    const row = new RoomStore(db).listRooms().find((r) => r.id === room.room.id);
    expect(row?.title).toBe("Friday films");
    expect(row?.layout).toEqual(DEFAULT_LAYOUT);
    await untilClosed(guest.client, 1000, () => {
      guest.client.send({ type: "title-set", title: "Hijacked" });
    }, clock);
    expect((await guest.client.closed).code).toBe(CLOSE_CODES.BAD_MESSAGES);
  });

  test("layout-set refuses unknown keys on the layout and on a piece (strictObject input schema)", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    owner.client.send({ type: "layout-set", layout: { ...DEFAULT_LAYOUT, extra: 1 } });
    expect((await owner.client.next("error")).code).toBe("bad_message");
    const pieces = DEFAULT_LAYOUT.furniture.map((p, i) => (i === 0 ? { ...p, extra: 1 } : p));
    owner.client.send({ type: "layout-set", layout: { ...DEFAULT_LAYOUT, furniture: pieces } });
    expect((await owner.client.next("error")).code).toBe("bad_message");
    await owner.client.none("layout-changed", 50);
  });

  test("owner edits are limited to ROOM_EDIT_BURST at once, then one every ROOM_EDIT_REFILL_MS", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    for (let i = 0; i < ROOM_EDIT_BURST; i++) {
      owner.client.send({ type: "title-set", title: `Title ${String(i)}` });
      await owner.client.next("title-changed");
    }
    owner.client.send({ type: "title-set", title: "One too many" });
    const err = await owner.client.next("error");
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(ROOM_EDIT_REFILL_MS);
    clock.ms += ROOM_EDIT_REFILL_MS;
    owner.client.send({ type: "layout-set", layout: movedLayout() });
    await owner.client.next("layout-changed");
  });

  test("a title-set to a blocklisted title is refused like at creation: nothing is stored or broadcast", async () => {
    db = openDatabase(":memory:");
    t = start({ trustProxy: true, store: new RoomStore(db), roomTitleBlocklist: ["forbidden"] });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob");
    owner.client.send({ type: "title-set", title: "Forbidden films" });
    const err = await owner.client.next("error");
    expect(err.code).toBe("bad_message");
    expect(err.message).toBe("that title isn't allowed");
    await guest.client.none("title-changed", 100);
    expect(new RoomStore(db).listRooms().find((r) => r.id === room.room.id)?.title).toBe("Friday films");
    // The owner may still rename it to something allowed.
    owner.client.send({ type: "title-set", title: "Saturday films" });
    expect((await guest.client.next("title-changed")).title).toBe("Saturday films");
  });

  test("a stored room whose title a later blocklist hides is listed again once the owner renames it to a clean title", async () => {
    db = openDatabase(":memory:");
    t = start({ trustProxy: true, store: new RoomStore(db) });
    const room = await createRoom("public", "Friday films");
    await server().server.stop(true);
    // Restarted with "friday" now on ROOM_TITLE_BLOCKLIST: the stored room is kept but unlisted.
    t = start({ trustProxy: true, store: new RoomStore(db), roomTitleBlocklist: ["friday"] });
    const ids = async () => ((await (await fetch(`${server().http}/rooms`)).json()) as { rooms: { id: string }[] }).rooms.map((r) => r.id);
    expect(await ids()).not.toContain(room.room.id);
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    owner.client.send({ type: "title-set", title: "Saturday films" });
    await owner.client.next("title-changed");
    expect(await ids()).toContain(room.room.id);
  });

  test("an unchanged title or layout is a no-op: no broadcast, no write", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob");
    owner.client.send({ type: "title-set", title: "Friday films" });
    owner.client.send({ type: "layout-set", layout: DEFAULT_LAYOUT });
    await guest.client.none("title-changed", 100);
    await guest.client.none("layout-changed", 0);
  });

  test("a store write failure changes nothing and broadcasts nothing", async () => {
    db = openDatabase(":memory:");
    const store = new RoomStore(db);
    t = start({ trustProxy: true, store });
    const room = await createRoom("public");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    const guest = await joined(room.room.id, "bob");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const setTitle = spyOn(store, "setTitle").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      owner.client.send({ type: "title-set", title: "Never stored" });
      await guest.client.none("title-changed", 100);
      const list = (await (await fetch(`${server().http}/rooms`)).json()) as { rooms: { id: string; title?: string }[] };
      expect(list.rooms.find((r) => r.id === room.room.id)?.title).toBe("Friday films");
    } finally {
      setTitle.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("secrets never leave (ADR 0028 §3)", () => {
  test("owner tokens and invite keys appear in no frame any socket receives and in no log line", async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : String(a))).join(" "));
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(record));
    db = openDatabase(":memory:");
    const store = new RoomStore(db);
    t = start({ trustProxy: true, store });
    try {
      const room = await createRoom("private");
      const secrets = [room.ownerToken, room.inviteKey ?? fail()];
      const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
      const guest = await joined(room.room.id, "bob", { inviteKey: room.inviteKey ?? fail() });
      const refused = await open(room.room.id);
      refused.send({ type: "join", nickname: "mallory", avatar: 0, inviteKey: WRONG });
      await refused.next("error");
      const wrongOwner = await joined(room.room.id, "eve", { ownerToken: WRONG, inviteKey: room.inviteKey ?? fail() });
      owner.client.send({ type: "title-set", title: "Renamed" });
      owner.client.send({ type: "layout-set", layout: movedLayout() });
      await guest.client.next("title-changed");
      await guest.client.next("layout-changed");
      wrongOwner.client.send({ type: "title-set", title: "Hijack" });
      await wrongOwner.client.next("error");
      // A failing write logs, and the log must not carry a secret either.
      const setLayout = spyOn(store, "setLayout").mockImplementation(() => {
        throw new Error("disk full");
      });
      owner.client.send({ type: "layout-set", layout: DEFAULT_LAYOUT });
      await guest.client.none("layout-changed", 100);
      setLayout.mockRestore();
      const frames = [owner.client, guest.client, refused, wrongOwner.client].flatMap((c) => c.raw);
      expect(frames.length).toBeGreaterThan(5);
      for (const s of secrets) {
        expect(frames.filter((f) => f.includes(s))).toEqual([]);
        expect(lines.filter((l) => l.includes(s))).toEqual([]);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("the snapshot carries the room title (ADR 0028 §6, OME-473)", () => {
  /** The `room` object of the raw snapshot frame, before any schema strips or fills a key. */
  function rawRoom(c: Client): Record<string, unknown> {
    for (const frame of c.raw) {
      const msg = JSON.parse(frame) as { type: string; room?: Record<string, unknown> };
      if (msg.type === "snapshot" && msg.room !== undefined) return msg.room;
    }
    throw new Error("no snapshot frame");
  }

  test("a titled room's snapshot has its title", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public", "Friday films");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    expect(owner.snapshot.room.title).toBe("Friday films");
    const guest = await joined(room.room.id, "bob");
    expect(guest.snapshot.room.title).toBe("Friday films");
  });

  test("an untitled seeded room (the lobby) sends no title key at all", async () => {
    t = start({ trustProxy: true });
    const { client, snapshot } = await joined("lobby", "alice");
    expect(snapshot.room.title).toBeUndefined();
    expect("title" in rawRoom(client)).toBe(false);
  });

  test("after a title-set, a later joiner's snapshot carries the new title", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public", "Old title");
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken });
    owner.client.send({ type: "title-set", title: "New title" });
    await owner.client.next("title-changed");
    const late = await joined(room.room.id, "carol");
    expect(late.snapshot.room.title).toBe("New title");
  });

  test("a private room's guest, joined with the invite key, gets the title", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private", "Secret screening");
    const guest = await joined(room.room.id, "bob", { inviteKey: room.inviteKey ?? fail() });
    expect(guest.snapshot.room.title).toBe("Secret screening");
  });
});
