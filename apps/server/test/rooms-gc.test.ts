import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, type Embed, type RoomId } from "@omega/shared";
import { Room } from "../src/room";
import { RoomRegistry } from "../src/rooms";
import { ROOM_GC_INTERVAL_MS, ROOM_IDLE_TTL_MS, startRoomGc, sweepRooms } from "../src/rooms-gc";
import type { RoomPersistence } from "../src/server";
import { openDatabase } from "../src/store/db";
import { RoomStore, type StoredRoom } from "../src/store/rooms";
import { Client, start, type TestServer } from "./helpers";

/** Room GC and `last_active_at` (threat model §1.3, §7 #4; OME-405; 20-minute idle rule OME-904). Every clock here is injected. */

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

const MIN = 60_000;
const HOUR = 60 * MIN;
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
  test("one idle rule: a room with nobody in it for 20 min goes; the sweep runs every minute, so it goes within 20-21 min", () => {
    expect(ROOM_IDLE_TTL_MS).toBe(20 * MIN);
    expect(ROOM_GC_INTERVAL_MS).toBe(MIN);
  });

  test("a room nobody ever joined is kept for 20 min after created_at, then removed", () => {
    const room = createdRoom(ID_A, T0, null);
    const rooms = registryOf(room);
    expect(sweepRooms({ rooms, wallNow: () => T0 + 19 * MIN, busy: idle, touch: () => undefined })).toEqual([]);
    expect(sweepRooms({ rooms, wallNow: () => T0 + 20 * MIN - 1, busy: idle, touch: () => undefined })).toEqual([]);
    expect(rooms.get(ID_A)).toBe(room);
    expect(sweepRooms({ rooms, wallNow: () => T0 + 20 * MIN, busy: idle, touch: () => undefined })).toEqual([ID_A]);
    expect(rooms.get(ID_A)).toBeUndefined();
  });

  test("an empty room is kept for 20 min after the last member left, however old it is: 19 min kept, 20 min gone", () => {
    const emptiedAt = T0 + 30 * DAY;
    const room = createdRoom(ID_A, T0, emptiedAt);
    const rooms = registryOf(room);
    expect(sweepRooms({ rooms, wallNow: () => emptiedAt + 19 * MIN, busy: idle, touch: () => undefined })).toEqual([]);
    expect(rooms.get(ID_A)).toBe(room);
    expect(sweepRooms({ rooms, wallNow: () => emptiedAt + 20 * MIN, busy: idle, touch: () => undefined })).toEqual([ID_A]);
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
  test("a removal that throws is logged and the sweep goes on to the other due rooms (QA2 note on OME-450)", () => {
    const first = createdRoom(ID_A, T0, null);
    const second = createdRoom(ID_B, T0, null);
    const rooms = registryOf(first, second);
    rooms.onRemove((r) => {
      if (r === first) throw new Error("disk I/O error");
    });
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let removed: RoomId[] = [];
      expect(() => {
        removed = sweepRooms({ rooms, wallNow: () => T0 + 2 * HOUR, busy: idle, touch: () => undefined });
      }).not.toThrow();
      expect(removed).toEqual([ID_B]);
      expect(rooms.get(ID_B)).toBeUndefined();
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
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
    setLayout: (id) => {
      writes.push(`layout ${id}`);
    },
    setTitle: (id) => {
      writes.push(`title ${id}`);
    },
    setControlPolicy: (id) => {
      writes.push(`policy ${id}`);
    },
    setLastActive: (id, at) => {
      writes.push(`active ${id} ${String(at)}`);
    },
    addQueueItem: (id) => {
      writes.push(`queue-add ${id}`);
    },
    removeQueueItem: (id) => {
      writes.push(`queue-remove ${id}`);
      return true;
    },
    advanceQueue: (id) => {
      writes.push(`advance ${id}`);
    },
    addQueueItemAndStart: (id) => {
      writes.push(`queue-start ${id}`);
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
  controlPolicy: "everyone",
  itemId: null,
  queue: [],
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
    const clock = wallClock(T0 + DAY);
    const { store, writes } = recordingStore([
      row(ID_A, T0 + DAY - 20 * MIN, null), // never joined, 20 min old
      row(ID_B, T0, T0 + DAY - 25 * MIN), // empty for 25 min
      row(ID_C, T0, T0 + DAY - 19 * MIN), // empty for 19 min
    ]);
    t = start({ store, wallNow: clock.now });
    expect(writes.filter((w) => w.startsWith("delete")).sort()).toEqual([`delete ${ID_A}`, `delete ${ID_B}`]);
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
    clock.ms = T0 + 20 * MIN;
    await Bun.sleep(80);
    expect(store.listRooms().map((r) => r.id)).toEqual(["lobby"]);
    expect((await fetch(`${t.http}/rooms/${room.id}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(404);
  });

  test("a socket still joining keeps a due room alive; once everyone has left, the 20-min clock starts from the last leave", async () => {
    const clock = wallClock(T0 + 30 * MIN);
    const registry = new RoomRegistry();
    const { store, writes } = recordingStore([row(ID_A, T0 + 11 * MIN, null)]);
    t = start({ store, registry, wallNow: clock.now, roomGcIntervalMs: 20, joinTimeoutMs: 5_000 });
    // Not yet due at boot (created 19 min ago); a socket opens, then the minute passes.
    const lurker = await Client.open(t.ws(ID_A));
    clients.push(lurker);
    clock.ms = T0 + 40 * MIN;
    await Bun.sleep(80);
    expect(registry.get(ID_A)).toBeDefined();
    lurker.send({ type: "join", nickname: "alice", avatar: 0 });
    await lurker.next("snapshot");
    lurker.close();
    await lurker.closed;
    await Bun.sleep(20);
    expect(writes.filter((w) => w.startsWith("active")).at(-1)).toBe(`active ${ID_A} ${String(T0 + 40 * MIN)}`);
    clock.ms = T0 + 60 * MIN - 1;
    await Bun.sleep(80);
    expect(registry.get(ID_A)).toBeDefined();
    clock.ms = T0 + 60 * MIN;
    await Bun.sleep(80);
    expect(registry.get(ID_A) ?? null).toBeNull();
    expect(writes).toContain(`delete ${ID_A}`);
  });

  test("someone joins at 19 min: the timer resets, and the room goes 20 min after they leave", async () => {
    const clock = wallClock(T0);
    const registry = new RoomRegistry();
    const { store } = recordingStore([row(ID_A, T0 - DAY, T0)]); // empty since T0
    t = start({ store, registry, wallNow: clock.now, roomGcIntervalMs: 20 });
    clock.ms = T0 + 19 * MIN;
    await Bun.sleep(60);
    const alice = await Client.join(t.ws(ID_A), "alice");
    clients.push(alice.client);
    clock.ms = T0 + 25 * MIN; // past the old deadline, with alice in the room
    await Bun.sleep(60);
    expect(registry.get(ID_A)).toBeDefined();
    clock.ms = T0 + 30 * MIN;
    alice.client.close();
    await alice.client.closed;
    await Bun.sleep(60);
    clock.ms = T0 + 49 * MIN; // 19 min after she left
    await Bun.sleep(60);
    expect(registry.get(ID_A)).toBeDefined();
    clock.ms = T0 + 50 * MIN;
    await Bun.sleep(60);
    expect(registry.get(ID_A) ?? null).toBeNull();
  });

  test("a restart mid-idle keeps the clock: the room goes 20 min after it emptied, not 20 min after the restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "omega-gc-"));
    db = openDatabase(join(dir, "omega.db"));
    const store = new RoomStore(db);
    store.createRoom({ id: ID_A, title: "Film club", createdAt: T0 - DAY, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    store.setLastActive(ID_A, T0); // the last member left at T0
    const clock = wallClock(T0 + 10 * MIN);
    const first = start({ store, wallNow: clock.now, roomGcIntervalMs: 20 });
    await Bun.sleep(60);
    expect(store.listRooms().map((r) => r.id)).toContain(ID_A);
    await first.server.stop(true);
    clock.ms = T0 + 19 * MIN;
    t = start({ store, wallNow: clock.now, roomGcIntervalMs: 20 });
    expect(store.listRooms().map((r) => r.id)).toContain(ID_A);
    clock.ms = T0 + 20 * MIN;
    await Bun.sleep(80);
    expect(store.listRooms().map((r) => r.id)).toEqual(["lobby"]);
    expect((await fetch(`${t.http}/rooms/${ID_A}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(404);
  });

  test("server.stop() also stops the GC: a stopped server's store is never swept again (QA2 note on OME-450)", async () => {
    const clock = wallClock();
    const { store, writes } = recordingStore([row(ID_A, T0, null)]);
    const stopped = start({ store, wallNow: clock.now, roomGcIntervalMs: 20 });
    await stopped.server.stop(true);
    clock.ms = T0 + 2 * HOUR;
    await Bun.sleep(80);
    expect(writes.filter((w) => w.startsWith("delete"))).toEqual([]);
  });
});
