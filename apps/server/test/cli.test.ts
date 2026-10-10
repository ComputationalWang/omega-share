import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { CLOSE_CODES, CreateRoomResponseSchema, DEFAULT_LAYOUT, RoomListResponseSchema } from "@omega/shared";
import { adminSocketFor } from "../src/config";
import { startAdmin, type AdminServer } from "../src/admin";
import { runCli } from "../src/cli";
import { RoomRegistry } from "../src/rooms";
import { sweepRooms } from "../src/rooms-gc";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, start, type TestServer } from "./helpers";

/** Operator CLI `rooms list|delete|pin|unpin` over the server's admin socket, against a temp store (OME-407). */

let t: TestServer | null = null;
let admin: AdminServer | null = null;
let db: Database | null = null;
let dir: string | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await admin?.stop();
  admin = null;
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = new Uint8Array(32).fill(7);

interface Fixture {
  t: TestServer;
  store: RoomStore;
  rooms: RoomRegistry;
  socket: string;
  clock: { ms: number; now: () => number };
}

/** A server on a temp DB with its admin socket next to it, as `index.ts` wires them. */
function boot(seed: (store: RoomStore) => void = () => undefined): Fixture {
  dir = mkdtempSync(join(tmpdir(), "omega-cli-"));
  db = openDatabase(join(dir, "omega.db"));
  const store = new RoomStore(db);
  seed(store);
  const clock = { ms: T0, now: () => clock.ms };
  const rooms = new RoomRegistry();
  t = start({ store, registry: rooms, trustProxy: true, wallNow: clock.now });
  const socket = join(dir, "admin.sock");
  admin = startAdmin({ rooms, store, socketPath: socket });
  return { t, store, rooms, socket, clock };
}

/** Runs the CLI, collecting what it prints. */
async function cli(socket: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { ADMIN_SOCKET: socket },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** `rooms list` rows keyed by column name. */
function rowsOf(out: string): Record<string, string>[] {
  const [head, ...lines] = out.split("\n");
  const cols = (head ?? "").split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((cell, i) => [cols[i] ?? `?${String(i)}`, cell])));
}

async function createRoom(f: Fixture, title: string, visibility: "public" | "private") {
  const res = await fetch(`${f.t.http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${String(Math.floor(Math.random() * 250))}` },
    body: JSON.stringify({ title, visibility }),
  });
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (!body.ok) throw new Error(`create failed: ${body.error.code}`);
  return body;
}

async function listedIds(f: Fixture): Promise<string[]> {
  return v.parse(RoomListResponseSchema, await (await fetch(`${f.t.http}/rooms`)).json()).rooms.map((r) => r.id);
}

describe("rooms list", () => {
  test("one row per room: id, title, visibility, created, last active, pinned and members, oldest first", async () => {
    const f = boot((store) => {
      store.createRoom({ id: ID_A, title: "Film club", createdAt: T0 - HOUR / 2, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    });
    clients.push((await Client.join(f.t.ws(ID_A), "Ada")).client);

    const { code, out, err } = await cli(f.socket, "rooms", "list");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toBe("id\ttitle\tvisibility\tcreated\tlast active\tpinned\tmembers");
    expect(rowsOf(out)).toEqual([
      {
        id: ID_A,
        title: "Film club",
        visibility: "public",
        created: "2026-09-30T23:30:00.000Z",
        "last active": "2026-10-01T00:00:00.000Z",
        pinned: "no",
        members: "1",
      },
      // The configured lobby, seeded at boot: pinned, untitled, nobody ever joined.
      { id: "lobby", title: "-", visibility: "public", created: "2026-10-01T00:00:00.000Z", "last active": "never", pinned: "yes", members: "0" },
    ]);
  });

  test("lists private rooms too, and never prints an owner or invite secret or its hash", async () => {
    const f = boot();
    const made = await createRoom(f, "Secret club", "private");
    const { code, out } = await cli(f.socket, "rooms", "list");
    expect(code).toBe(0);
    expect(rowsOf(out).find((r) => r["id"] === made.room.id)).toMatchObject({ title: "Secret club", visibility: "private", pinned: "no" });
    for (const secret of [made.ownerToken, made.inviteKey ?? "missing invite key"]) {
      const hash = createHash("sha256").update(secret).digest();
      for (const shape of [secret, hash.toString("hex"), hash.toString("base64"), hash.toString("base64url")]) {
        expect(out).not.toContain(shape);
      }
    }
    expect(out.toLowerCase()).not.toContain("hash");
  });

  test("a title's control and format characters are escaped, so a title can't drive the operator's terminal", async () => {
    const f = boot((store) => {
      store.createRoom({ id: ID_A, title: "", createdAt: T0, layout: DEFAULT_LAYOUT });
    });
    // Seeded rooms may carry any stored title the DB parse accepts; force a hostile one in memory.
    const room = f.rooms.get(ID_A);
    if (room === undefined) throw new Error("no room");
    Object.defineProperty(room, "title", { value: "a\u001b[2Jb\tc\u202ed\ne\u0085f\u2028g\u{e0041}h\u200bi" });
    const { out } = await cli(f.socket, "rooms", "list");
    for (const ch of ["\u001b", "\u202e", "\u0085", "\u2028", "\u{e0041}", "\u200b"]) expect(out).not.toContain(ch);
    expect(rowsOf(out).find((r) => r["id"] === ID_A)?.["title"]).toBe(
      "a\\u001b[2Jb\\u0009c\\u202ed\\u000ae\\u0085f\\u2028g\\u{e0041}h\\u200bi",
    );
  });
});

describe("rooms delete <id>", () => {
  test("ends the room through removeRoom: members are closed with ROOM_CLOSED, the row is deleted, it leaves GET /rooms", async () => {
    const f = boot();
    const made = await createRoom(f, "Takedown me", "public");
    const { client } = await Client.join(f.t.ws(made.room.id), "Ada");
    clients.push(client);
    expect(await listedIds(f)).toContain(made.room.id);

    const { code, out } = await cli(f.socket, "rooms", "delete", made.room.id);
    expect(code).toBe(0);
    expect(out).toBe(`deleted ${made.room.id}`);
    expect((await client.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect(f.rooms.get(made.room.id)).toBeUndefined();
    expect(f.store.listRooms().map((r) => r.id)).not.toContain(made.room.id);
    expect(await listedIds(f)).not.toContain(made.room.id);
    // The id is gone for good: a new socket is closed with ROOM_CLOSED before any snapshot (OME-768: "Room not found").
    const late = await Client.open(f.t.ws(made.room.id));
    clients.push(late);
    expect((await late.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect(late.raw.filter((r) => r.includes('"snapshot"'))).toEqual([]);
  });

  test("an unknown room exits 1 and changes nothing", async () => {
    const f = boot();
    const { code, err } = await cli(f.socket, "rooms", "delete", ID_B);
    expect(code).toBe(1);
    expect(err).toBe(`no room ${ID_B}`);
    expect(f.rooms.get("lobby")).toBeDefined();
  });

  test("deletes a pinned room too; a configured one is seeded again, empty, at the next boot", async () => {
    const f = boot();
    const { code } = await cli(f.socket, "rooms", "delete", "lobby");
    expect(code).toBe(0);
    expect(f.rooms.get("lobby")).toBeUndefined();
    expect(f.store.listRooms()).toEqual([]);
    await f.t.server.stop(true);
    t = start({ store: f.store, registry: new RoomRegistry(), wallNow: f.clock.now });
    expect(f.store.listRooms().map((r) => [r.id, r.pinned, r.embed])).toEqual([["lobby", true, null]]);
  });

  test("deletes a row the live server no longer has (a re-run after a failed store write)", async () => {
    const f = boot();
    // In the store, not in memory: what a removal whose row delete failed leaves behind.
    f.store.createRoom({ id: ID_B, title: "Leftover", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    expect(f.rooms.get(ID_B)).toBeUndefined();
    const { code, out } = await cli(f.socket, "rooms", "delete", ID_B);
    expect(code).toBe(0);
    expect(out).toBe(`deleted ${ID_B}`);
    expect(f.store.listRooms().map((r) => r.id)).not.toContain(ID_B);
  });
});

describe("rooms pin|unpin <id>", () => {
  test("pin keeps an idle created room from GC, in memory and in the store; unpin hands it back to GC", async () => {
    const f = boot((store) => {
      store.createRoom({ id: ID_A, title: "Keep me", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    });
    const gc = (at: number) => sweepRooms({ rooms: f.rooms, wallNow: () => at, busy: () => false, touch: () => undefined });

    const pinned = await cli(f.socket, "rooms", "pin", ID_A);
    expect(pinned.code).toBe(0);
    expect(pinned.out).toBe(`pinned ${ID_A}`);
    expect(f.store.listRooms().find((r) => r.id === ID_A)?.pinned).toBe(true);
    expect(rowsOf((await cli(f.socket, "rooms", "list")).out).find((r) => r["id"] === ID_A)?.["pinned"]).toBe("yes");
    expect(gc(T0 + 2 * HOUR)).toEqual([]);
    expect(f.rooms.get(ID_A)).toBeDefined();

    const unpinned = await cli(f.socket, "rooms", "unpin", ID_A);
    expect(unpinned.code).toBe(0);
    expect(unpinned.out).toBe(`unpinned ${ID_A}`);
    expect(f.store.listRooms().find((r) => r.id === ID_A)?.pinned).toBe(false);
    expect(gc(T0 + 2 * HOUR)).toEqual([ID_A]);
    expect(f.store.listRooms().map((r) => r.id)).not.toContain(ID_A);
  });

  test("a pinned room is listed with the pinned rooms by GET /rooms, ahead of newer ones", async () => {
    const f = boot();
    const older = await createRoom(f, "Older", "public");
    f.clock.ms += 1000;
    const newer = await createRoom(f, "Newer", "public");
    expect(await listedIds(f)).toEqual(["lobby", newer.room.id, older.room.id]);
    await cli(f.socket, "rooms", "pin", older.room.id);
    expect(await listedIds(f)).toEqual(["lobby", older.room.id, newer.room.id]);
  });

  test("unpin refuses a seeded room (no owner): GC would end it and only a restart brings it back", async () => {
    const f = boot();
    const { code, err } = await cli(f.socket, "rooms", "unpin", "lobby");
    expect(code).toBe(1);
    expect(err).toBe("lobby is a seeded room with no owner: it stays pinned (delete it instead)");
    expect(f.rooms.get("lobby")?.pinned).toBe(true);
    expect(f.store.listRooms().find((r) => r.id === "lobby")?.pinned).toBe(true);
  });

  test("pinning an unknown room exits 1", async () => {
    const f = boot();
    for (const verb of ["pin", "unpin"]) {
      const { code, err } = await cli(f.socket, "rooms", verb, ID_B);
      expect(code).toBe(1);
      expect(err).toBe(`no room ${ID_B}`);
    }
  });
});

describe("usage and failures", () => {
  test("a bad command or room id exits 2 with usage, without calling the server", async () => {
    const f = boot();
    for (const argv of [[], ["rooms"], ["rooms", "nuke"], ["rooms", "delete"], ["rooms", "delete", "../lobby"], ["rooms", "pin", "LOBBY"], ["rooms", "list", "extra"]]) {
      const { code, err } = await cli(f.socket, ...argv);
      expect(code).toBe(2);
      expect(err).toContain("usage: cli.ts rooms list | rooms delete <id> | rooms pin <id> | rooms unpin <id>");
    }
    expect(f.rooms.get("lobby")).toBeDefined();
  });

  test("no server on the socket exits 1 and names the socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "omega-cli-"));
    const socket = join(dir, "admin.sock");
    const { code, err } = await cli(socket, "rooms", "list");
    expect(code).toBe(1);
    expect(err).toContain(`no server on ${socket}`);
  });
});

describe("the admin socket", () => {
  test("is owner-only (0600) and replaces a stale socket left by a crash", async () => {
    const f = boot();
    expect(statSync(f.socket).mode & 0o777).toBe(0o600);
    await admin?.stop();
    // A crash leaves the socket file behind; the next boot must still bind.
    admin = startAdmin({ rooms: f.rooms, store: f.store, socketPath: f.socket });
    expect((await cli(f.socket, "rooms", "list")).code).toBe(0);
  });

  test("is bound owner-only, not chmod-ed after the fact, whatever the process umask", () => {
    dir = mkdtempSync(join(tmpdir(), "omega-cli-"));
    db = openDatabase(join(dir, "omega.db"));
    const path = join(dir, "admin.sock");
    const before = process.umask(0o002);
    const chmod = spyOn(fs, "chmodSync").mockImplementation(() => undefined);
    let after: number;
    try {
      admin = startAdmin({ rooms: new RoomRegistry(), store: new RoomStore(db), socketPath: path });
    } finally {
      chmod.mockRestore();
      after = process.umask(before);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The process umask is back as it was: only the bind ran under 0177.
    expect(after).toBe(0o002);
  });

  test("if the socket can't be secured, nothing is left listening and the socket file is gone", () => {
    dir = mkdtempSync(join(tmpdir(), "omega-cli-"));
    const store = new RoomStore((db = openDatabase(join(dir, "omega.db"))));
    const path = join(dir, "admin.sock");
    const chmod = spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("EPERM");
    });
    try {
      expect(() => startAdmin({ rooms: new RoomRegistry(), store, socketPath: path })).toThrow(/EPERM/);
    } finally {
      chmod.mockRestore();
    }
    expect(existsSync(path)).toBe(false);
  });

  test("answers only its four routes: other methods 405, other paths 404, bodies over 1 KB refused", async () => {
    const f = boot();
    const call = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { ...init, unix: f.socket });
    expect((await call("/rooms", { method: "PUT" })).status).toBe(405);
    expect((await call("/rooms/lobby")).status).toBe(405);
    expect((await call("/rooms/lobby/pin")).status).toBe(405);
    expect((await call("/rooms/lobby/frob", { method: "POST" })).status).toBe(404);
    expect((await call("/rooms/LOBBY", { method: "DELETE" })).status).toBe(404);
    expect((await call("/")).status).toBe(404);
    expect((await call("/rooms/lobby/pin", { method: "POST", body: "x".repeat(2048) })).status).toBe(413);
    expect(f.rooms.get("lobby")?.pinned).toBe(true);
  });

  test("refuses to replace a path that isn't a socket", () => {
    dir = mkdtempSync(join(tmpdir(), "omega-cli-"));
    db = openDatabase(join(dir, "omega.db"));
    const path = join(dir, "admin.sock");
    writeFileSync(path, "not a socket");
    expect(() => startAdmin({ rooms: new RoomRegistry(), store: new RoomStore(db ?? openDatabase(":memory:")), socketPath: path })).toThrow(
      /not a socket/,
    );
    expect(existsSync(path)).toBe(true);
  });

  test("ADMIN_SOCKET defaults to admin.sock beside DB_PATH, can be set or turned off, and is off for :memory:", () => {
    expect(adminSocketFor({ DB_PATH: "/var/lib/omega-share/omega.db" })).toBe("/var/lib/omega-share/admin.sock");
    expect(adminSocketFor({ DB_PATH: "/var/lib/omega-share/omega.db", ADMIN_SOCKET: "/run/omega/a.sock" })).toBe("/run/omega/a.sock");
    expect(adminSocketFor({ DB_PATH: "/var/lib/omega-share/omega.db", ADMIN_SOCKET: "off" })).toBeNull();
    expect(adminSocketFor({ DB_PATH: ":memory:" })).toBeNull();
  });
});
