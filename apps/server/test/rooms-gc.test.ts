import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, type Embed, type RoomId } from "@omega/shared";
import { Room } from "../src/room";
import { RoomRegistry } from "../src/rooms";
import { EMPTY_ROOM_TTL_MS, NEVER_JOINED_TTL_MS, ROOM_GC_INTERVAL_MS, startRoomGc, sweepRooms } from "../src/rooms-gc";
import type { RoomPersistence } from "../src/server";
import { openDatabase } from "../src/store/db";
import { RoomStore, type StoredRoom } from "../src/store/rooms";
import { Client, start, type TestServer } from "./helpers";

/** Room GC and `last_active_at` (threat model §1.3, §7 #4; OME-405). Every clock here is injected. */

let t: TestServer | null = null;
let db: Database | null = null;
let dir: string | null = null;
const clients: Client[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const stop of stops.splice(0)) stop();
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1);
function wallClock(ms = T0) {
  const clock = { ms, now: () => clock.ms };
  return clock;
}
const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_C = "cccccccccccccccccccccccccc";
const OWNER = new Uint8Array(32).fill(7);
const YOUTUBE: Embed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };

/** A created room (unpinned, owned) as the store would hand it back. */
function createdRoom(id: RoomId, createdAt: number, lastActiveAt: number | null): Room {
  return new Room(id, { pinned: false, createdAt, lastActiveAt, ownerHash: OWNER, title: "Film club", visibility: "public" });
}

function registryOf(...rooms: Room[]): RoomRegistry {
  const registry = new RoomRegistry();
  for (const room of rooms) registry.addRoom(room);
  return registry;
}

const idle = (): boolean => false;

describe("sweepRooms: what GC collects (threat model §1.3)", () => {
  test("the constants match the threat model: hourly sweep, 1 h for a never-joined room, 14 days for an empty one", () => {
    expect(ROOM_GC_INTERVAL_MS).toBe(HOUR);
    expect(NEVER_JOINED_TTL_MS).toBe(HOUR);
    expect(EMPTY_ROOM_TTL_MS).toBe(14 * DAY);
  });

  test("a created room nobody ever joined is kept for 1 h after created_at, then removed", () => {
    const room = createdRoom(ID_A, T0, null);
    const rooms = registryOf(room);
    expect(sweepRooms({ rooms, wallNow: () => T0 + HOUR - 1, busy: idle, touch: () => undefined })).toEqual([]);
    expect(rooms.get(ID_A)).toBe(room);
    expect(sweepRooms({ rooms, wallNow: () => T0 + HOUR, busy: idle, touch: () => undefined })).toEqual([ID_A]);
    expect(rooms.get(ID_A)).toBeUndefined();
  });

  test("an empty created room is kept for 14 days after it last became empty, however old it is, then removed", () => {
    const emptiedAt = T0 + 30 * DAY;
    const room = createdRoom(ID_A, T0, emptiedAt);
    const rooms = registryOf(room);
    expect(sweepRooms({ rooms, wallNow: () => emptiedAt + 14 * DAY - 1, busy: idle, touch: () => undefined })).toEqual([]);
    expect(rooms.get(ID_A)).toBe(room);
    expect(sweepRooms({ rooms, wallNow: () => emptiedAt + 14 * DAY, busy: idle, touch: () => undefined })).toEqual([ID_A]);
    expect(rooms.get(ID_A)).toBeUndefined();
  });

  test("pinned (seeded) rooms are never collected, however old and unused", () => {
    const lobby = new Room("lobby", { createdAt: 0 });
    const operatorMade = new Room(ID_B, { pinned: true, createdAt: 0, lastActiveAt: 0 });
    const rooms = registryOf(lobby, operatorMade);
    expect(sweepRooms({ rooms, wallNow: () => T0 + 10_000 * DAY, busy: idle, touch: () => undefined })).toEqual([]);
    expect(rooms.size).toBe(2);
  });

  test("a busy room (a member, or a socket still joining) is never collected; an occupied one is touched so a crash can't age it", () => {
    const occupied = createdRoom(ID_A, T0, T0);
    const member = occupied.join("alice", 0);
    expect(member.ok).toBe(true);
    const joining = createdRoom(ID_B, T0, null);
    const stale = createdRoom(ID_C, T0, T0);
    const rooms = registryOf(occupied, joining, stale);
    const touched: RoomId[] = [];
    const now = T0 + 100 * DAY;
    const removed = sweepRooms({
      rooms,
      wallNow: () => now,
      busy: (room) => room === occupied || room === joining,
      touch: (room, at) => {
        expect(at).toBe(now);
        touched.push(room.id);
      },
    });
    expect(removed).toEqual([ID_C]);
    expect(rooms.get(ID_A)).toBe(occupied);
    expect(rooms.get(ID_B)).toBe(joining);
    // Only the room with members: a socket that never joins is not activity.
    expect(touched).toEqual([ID_A]);
  });

  test("removal goes through RoomRegistry.removeRoom: its onRemove hooks run and its per-room state is dropped", () => {
    const room = createdRoom(ID_A, T0, null);
    const rooms = registryOf(room);
    const perRoom = rooms.perRoom(() => ({ n: 1 }));
    perRoom.get(room);
    const ended: Room[] = [];
    rooms.onRemove((r) => ended.push(r));
    sweepRooms({ rooms, wallNow: () => T0 + 2 * HOUR, busy: idle, touch: () => undefined });
    expect(ended).toEqual([room]);
    expect(perRoom.size).toBe(0);
  });
});

describe("startRoomGc: at boot and on every interval", () => {
  test("sweeps once at start, then every intervalMs until stopped", async () => {
    const clock = wallClock();
    const rooms = registryOf(createdRoom(ID_A, T0 - 2 * HOUR, null), createdRoom(ID_B, T0, null));
    const gc = startRoomGc({ rooms, wallNow: clock.now, busy: idle, touch: () => undefined, intervalMs: 20 });
    stops.push(() => {
      gc.stop();
    });
    expect(rooms.get(ID_A)).toBeUndefined();
    expect(rooms.get(ID_B)).toBeDefined();
    clock.ms = T0 + HOUR;
    await Bun.sleep(80);
    expect(rooms.get(ID_B)).toBeUndefined();
    gc.stop();
    rooms.addRoom(createdRoom(ID_C, T0, null));
    await Bun.sleep(80);
    expect(rooms.get(ID_C)).toBeDefined();
  });
});

describe("RoomStore.setLastActive", () => {
  test("writes last_active_at for the room; listRooms reads it back; an unknown room throws", () => {
    dir = mkdtempSync(join(tmpdir(), "omega-gc-"));
    db = openDatabase(join(dir, "omega.db"));
    const store = new RoomStore(db);
    store.createRoom({ id: ID_A, title: "Film club", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    expect(store.listRooms()[0]?.lastActiveAt).toBeNull();
    store.setLastActive(ID_A, T0 + 5);
    expect(store.listRooms()[0]?.lastActiveAt).toBe(T0 + 5);
    expect(() => {
      store.setLastActive(ID_B, T0);
    }).toThrow();
  });
});

/** A RoomPersistence that records every write, over rows held in memory. */
function recordingStore(rows: StoredRoom[]) {
  const writes: string[] = [];
  const store: RoomPersistence = {
    listRooms: () => rows,
    createRoom: (room) => {
      writes.push(`create ${room.id}`);
    },
    deleteRoom: (id) => {
      writes.push(`delete ${id}`);
      return true;
    },
    setEmbed: (id) => {
      writes.push(`embed ${id}`);
    },
    setLastActive: (id, at) => {
      writes.push(`active ${id} ${String(at)}`);
    },
  };
  return { store, writes };
}
const row = (id: RoomId, createdAt: number, lastActiveAt: number | null): StoredRoom => ({
  id,
  title: "Film club",
  createdAt,
  layout: DEFAULT_LAYOUT,
  embed: null,
  visibility: "public",
  pinned: false,
  ownerHash: OWNER,
  inviteHash: null,
  lastActiveAt,
});

describe("last_active_at moves only on the 0→1 and 1→0 transitions (threat model §1.3)", () => {
  test("first join and last leave write it; a second member, chat, control, sit and member-status never touch the store", async () => {
    const clock = wallClock();
    const { store, writes } = recordingStore([{ ...row(ID_A, T0, null), embed: YOUTUBE }]);
    t = start({ store, wallNow: clock.now, rooms: [] });
    clock.ms = T0 + 10;
    const alice = await Client.join(t.ws(ID_A), "alice");
    clients.push(alice.client);
    expect(writes).toEqual([`active ${ID_A} ${String(T0 + 10)}`]);

    clock.ms = T0 + 20;
    const bob = await Client.join(t.ws(ID_A), "bob");
    clients.push(bob.client);
    alice.client.send({ type: "chat", text: "hi" });
    await bob.client.next("chat");
    alice.client.send({ type: "sit", seat: 0 });
    await bob.client.next("seat-changed");
    alice.client.send({ type: "control", url: YOUTUBE.url, playing: true, position: 5 });
    await bob.client.next("playback");
    alice.client.send({ type: "status", catching: true });
    await Bun.sleep(50);
    expect(writes).toEqual([`active ${ID_A} ${String(T0 + 10)}`]);

    clock.ms = T0 + 30;
    bob.client.close();
    await bob.client.closed;
    await alice.client.next("member-left");
    expect(writes).toEqual([`active ${ID_A} ${String(T0 + 10)}`]);

    clock.ms = T0 + 40;
    alice.client.send({ type: "leave" });
    await Bun.sleep(50);
    expect(writes).toEqual([`active ${ID_A} ${String(T0 + 10)}`, `active ${ID_A} ${String(T0 + 40)}`]);
  });

  test("a closed socket counts as leaving: the last one out writes it", async () => {
    const clock = wallClock();
    const { store, writes } = recordingStore([row(ID_A, T0, null)]);
    t = start({ store, wallNow: clock.now, rooms: [] });
    const alice = await Client.join(t.ws(ID_A), "alice");
    clock.ms = T0 + 99;
    alice.client.close();
    await alice.client.closed;
    await Bun.sleep(20);
    expect(writes.at(-1)).toBe(`active ${ID_A} ${String(T0 + 99)}`);
  });
});

describe("the server's GC (startServer)", () => {
  test("the boot sweep deletes expired created rooms from memory and the store, keeps fresh ones and the pinned lobby", async () => {
    const clock = wallClock(T0 + 20 * DAY);
    const { store, writes } = recordingStore([
      row(ID_A, T0, null), // never joined, 20 days old
      row(ID_B, T0, T0 + DAY), // empty for 19 days
      row(ID_C, T0, T0 + 10 * DAY), // empty for 10 days
    ]);
    t = start({ store, wallNow: clock.now });
    expect(writes.sort()).toEqual([`delete ${ID_A}`, `delete ${ID_B}`]);
    expect((await fetch(`${t.http}/rooms/${ID_A}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(404);
    const listed = (await (await fetch(`${t.http}/rooms`)).json()) as { rooms: { id: string }[] };
    expect(listed.rooms.map((r) => r.id)).toEqual(["lobby", ID_C]);
  });

  test("a room created over POST /rooms is stamped with the injected clock, and a later sweep removes the whole row", async () => {
    const clock = wallClock();
    dir = mkdtempSync(join(tmpdir(), "omega-gc-"));
    db = openDatabase(join(dir, "omega.db"));
    const store = new RoomStore(db);
    t = start({ store, wallNow: clock.now, roomGcIntervalMs: 20, trustProxy: true });
    const res = await fetch(`${t.http}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ title: "Pop-up", visibility: "private" }),
    });
    expect(res.status).toBe(201);
    const { room } = (await res.json()) as { room: { id: string } };
    expect(store.listRooms().find((r) => r.id === room.id)?.createdAt).toBe(T0);

    await Bun.sleep(60);
    expect(store.listRooms().map((r) => r.id)).toContain(room.id);
    clock.ms = T0 + NEVER_JOINED_TTL_MS;
    await Bun.sleep(80);
    expect(store.listRooms().map((r) => r.id)).toEqual(["lobby"]);
    expect((await fetch(`${t.http}/rooms/${room.id}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(404);
  });

  test("a socket still joining keeps a due room alive; once everyone has left, the 14-day clock starts from the last leave", async () => {
    const clock = wallClock(T0 + 2 * HOUR);
    const registry = new RoomRegistry();
    const { store, writes } = recordingStore([row(ID_A, T0 + HOUR + 1, null)]);
    t = start({ store, registry, wallNow: clock.now, roomGcIntervalMs: 20, joinTimeoutMs: 5_000 });
    // Not yet due at boot (created 59 min ago); a socket opens, then the hour passes.
    const lurker = await Client.open(t.ws(ID_A));
    clients.push(lurker);
    clock.ms = T0 + 3 * HOUR;
    await Bun.sleep(80);
    expect(registry.get(ID_A)).toBeDefined();
    lurker.send({ type: "join", nickname: "alice", avatar: 0 });
    await lurker.next("snapshot");
    lurker.close();
    await lurker.closed;
    await Bun.sleep(20);
    expect(writes.filter((w) => w.startsWith("active")).at(-1)).toBe(`active ${ID_A} ${String(T0 + 3 * HOUR)}`);
    clock.ms = T0 + 3 * HOUR + 14 * DAY - 1;
    await Bun.sleep(80);
    expect(registry.get(ID_A)).toBeDefined();
    clock.ms = T0 + 3 * HOUR + 14 * DAY;
    await Bun.sleep(80);
    expect(registry.get(ID_A) ?? null).toBeNull();
    expect(writes).toContain(`delete ${ID_A}`);
  });
});
