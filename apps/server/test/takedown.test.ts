import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { CLOSE_CODES, CreateRoomResponseSchema, DEFAULT_LAYOUT, RoomListResponseSchema, canonicalizeEmbed } from "@omega/shared";
import { startAdmin, type AdminServer } from "../src/admin";
import { runCli } from "../src/cli";
import { RoomRegistry } from "../src/rooms";
import * as secrets from "../src/secrets";
import { openDatabase } from "../src/store/db";
import { ReportStore } from "../src/store/reports";
import { RoomStore } from "../src/store/rooms";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** The operator queue and takedowns (ADR 0033 §5, §6): `cli.ts reports list|dismiss`, `cli.ts rooms takedown`. */

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

const T0 = Date.UTC(2026, 9, 9, 12);
const ROOM = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = new Uint8Array(32).fill(7);
const EMBED = canonicalizeEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

interface Fixture {
  t: TestServer;
  db: Database;
  store: RoomStore;
  reportStore: ReportStore;
  rooms: RoomRegistry;
  socket: string;
  wall: { ms: number };
}

function seedRooms(store: RoomStore): void {
  store.createRoom({ id: ROOM, title: "Film club", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
  store.createRoom({ id: OTHER, title: "Quiet room", createdAt: T0, layout: DEFAULT_LAYOUT, visibility: "public", pinned: false, ownerHash: OWNER });
  store.setEmbed(ROOM, EMBED);
}

/** A server on a temp DB with its admin socket, as `index.ts` wires them. `configured` rooms are seeded. */
function boot(configured: string[] = ["lobby"], seed: (store: RoomStore) => void = seedRooms, path?: string): Fixture {
  dir ??= mkdtempSync(join(tmpdir(), "omega-takedown-"));
  const d = openDatabase(path ?? join(dir, "omega.db"));
  db = d;
  const store = new RoomStore(d);
  const reportStore = new ReportStore(d);
  seed(store);
  const wall = { ms: T0 };
  const rooms = new RoomRegistry();
  t = start({ store, reportStore, registry: rooms, rooms: configured, trustProxy: true, wallNow: () => wall.ms });
  const socket = join(dir, "admin.sock");
  admin = startAdmin({ rooms, store, reports: t.server.reports, socketPath: socket });
  return { t, db: d, store, reportStore, rooms, socket, wall };
}

/** Stops the server and its admin socket, keeping the DB file, so the next `boot` is a restart. */
async function restart(): Promise<void> {
  await admin?.stop();
  admin = null;
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
}

async function cli(socket: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { env: { ADMIN_SOCKET: socket }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function report(f: Fixture, roomId: string, body: unknown, ip = "198.51.100.7"): Promise<Response> {
  return fetch(`${f.t.http}/rooms/${roomId}/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const states = (f: Fixture, roomId: string): string[] =>
  f.db.query<{ state: string }, [string]>("SELECT state FROM reports WHERE room_id = ? ORDER BY created_at").all(roomId).map((r) => r.state);

async function listed(f: Fixture): Promise<string[]> {
  return v.parse(RoomListResponseSchema, await (await fetch(`${f.t.http}/rooms`)).json()).rooms.map((r) => r.id);
}

describe("rooms takedown <id>", () => {
  test("closes every member with TAKEN_DOWN, deletes the room, tombstones the id and actions its open reports", async () => {
    const f = boot();
    const a = await Client.join(f.t.ws(ROOM), "Ada");
    const b = await Client.join(f.t.ws(ROOM), "Bob");
    clients.push(a.client, b.client);
    const lurker = await Client.open(f.t.ws(ROOM));
    clients.push(lurker);
    await report(f, ROOM, { reason: "sexual" });
    await report(f, ROOM, { reason: "hate" }, "198.51.100.8");
    await report(f, OTHER, { reason: "spam" });

    const { code, out, err } = await cli(f.socket, "rooms", "takedown", ROOM);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe(`taken down ${ROOM}`);
    for (const c of [a.client, b.client, lurker]) expect((await c.closed).code).toBe(CLOSE_CODES.TAKEN_DOWN);

    expect(f.rooms.get(ROOM)).toBeUndefined();
    expect(f.store.listRooms().map((r) => r.id)).not.toContain(ROOM);
    expect(f.db.query("SELECT room_id FROM takedowns").all()).toEqual([{ room_id: ROOM }]);
    expect(states(f, ROOM)).toEqual(["actioned", "actioned"]);
    expect(states(f, OTHER)).toEqual(["open"]);
    expect(await listed(f)).not.toContain(ROOM);
    const metrics = f.t.server.metricsText();
    expect(metrics).toContain("omega_takedowns_total 1");
    expect(metrics).toContain(`omega_ws_closes_total{code="${String(CLOSE_CODES.TAKEN_DOWN)}"} 3`);
    expect(metrics).toContain("omega_reports_open 1");
  });

  test("revokes share grants: a pending member's share and queue add get room_not_found", async () => {
    const f = boot();
    const a = await Client.join(f.t.ws(ROOM), "Ada");
    clients.push(a.client);
    const token = tokenOf(a.snapshot);
    await cli(f.socket, "rooms", "takedown", ROOM);
    const share = await postShare(f.t, JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), { roomId: ROOM, token });
    expect(share.status).toBe(404);
    const queue = await fetch(`${f.t.http}/rooms/${ROOM}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });
    expect(queue.status).toBe(404);
  });

  test("afterwards the id stays dead: a join is closed with TAKEN_DOWN before any snapshot; reports get room_not_found", async () => {
    const f = boot();
    await cli(f.socket, "rooms", "takedown", ROOM);
    const late = await Client.open(f.t.ws(ROOM));
    clients.push(late);
    expect((await late.closed).code).toBe(CLOSE_CODES.TAKEN_DOWN);
    expect(late.raw.filter((r) => r.includes('"snapshot"'))).toEqual([]);
    expect((await report(f, ROOM, { reason: "spam" }, "198.51.100.99")).status).toBe(404);
    // A never-existing id is still a plain 404 upgrade.
    expect((await fetch(`${f.t.http}/rooms/cccccccccccccccccccccccccc/ws`)).status).toBe(404);
  });

  test("survives a restart: the room isn't loaded or re-seeded, and a leftover row is deleted", async () => {
    let f = boot(["lobby", "cinema"], (store) => {
      seedRooms(store);
    });
    const path = join(dir ?? "", "omega.db");
    expect((await cli(f.socket, "rooms", "takedown", "cinema")).code).toBe(0);
    expect((await cli(f.socket, "rooms", "takedown", ROOM)).code).toBe(0);
    // As if the delete had failed: the row is back.
    f.store.createRoom({ id: ROOM, title: "Film club", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    await restart();
    f = boot(["lobby", "cinema"], () => undefined, path);
    expect(f.rooms.get("cinema")).toBeUndefined();
    expect(f.rooms.get(ROOM)).toBeUndefined();
    expect(f.rooms.get("lobby")).toBeDefined();
    expect(f.store.listRooms().map((r) => r.id).sort()).toEqual(["lobby", OTHER].sort());
    const late = await Client.open(f.t.ws("cinema"));
    clients.push(late);
    expect((await late.closed).code).toBe(CLOSE_CODES.TAKEN_DOWN);
  });

  test("POST /rooms never mints a taken-down id", async () => {
    const f = boot();
    await cli(f.socket, "rooms", "takedown", ROOM);
    const fresh = "dddddddddddddddddddddddddd";
    const mint = spyOn(secrets, "newRoomId").mockReturnValueOnce(ROOM).mockReturnValueOnce(fresh);
    try {
      const res = await fetch(`${f.t.http}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.50" },
        body: JSON.stringify({ title: "New one", visibility: "public" }),
      });
      const body = v.parse(CreateRoomResponseSchema, await res.json());
      expect(body.ok ? body.room.id : null).toBe(fresh);
    } finally {
      mint.mockRestore();
    }
  });

  test("a room that is no longer live is still tombstoned and its reports actioned", async () => {
    const f = boot();
    await report(f, OTHER, { reason: "spam" });
    const room = f.rooms.get(OTHER);
    if (room === undefined) throw new Error("no room");
    f.rooms.removeRoom(room);
    const { code, out } = await cli(f.socket, "rooms", "takedown", OTHER);
    expect(code).toBe(0);
    expect(out).toBe(`taken down ${OTHER} (it was not live)`);
    expect(f.t.server.reports.isTakenDown(OTHER)).toBe(true);
    expect(states(f, OTHER)).toEqual(["actioned"]);
  });

  test("is not on public HTTP", async () => {
    const f = boot();
    for (const [method, path] of [
      ["POST", `/rooms/${ROOM}/takedown`],
      ["GET", "/reports"],
      ["POST", `/rooms/${ROOM}/reports/dismiss`],
    ] as const) {
      const res = await fetch(`${f.t.http}${path}`, { method });
      expect(res.status).toBe(404);
    }
    expect(f.rooms.get(ROOM)).toBeDefined();
  });
});

describe("reports list", () => {
  test("open reports grouped by room, most reported first, newest first within a room", async () => {
    const f = boot();
    f.wall.ms = T0 + 1000;
    await report(f, OTHER, { reason: "spam", note: "buy pills" }, "198.51.100.1");
    f.wall.ms = T0 + 2000;
    await report(f, ROOM, { reason: "sexual" }, "198.51.100.1");
    f.wall.ms = T0 + 3000;
    await report(f, ROOM, { reason: "hate", note: "call me on 555-123-4567" }, "198.51.100.2");
    const a = await Client.join(f.t.ws(ROOM), "Ada");
    clients.push(a.client);

    const { code, out, err } = await cli(f.socket, "reports", "list");
    expect(err).toBe("");
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines).toEqual([
      `${ROOM}\tFilm club\tpublic\tmembers 1\t2 open\thate 1, sexual 1`,
      `  2026-10-09T12:00:03.000Z\thate\t${String(lines[1]?.split("\t")[2])}\tnote: call me on <phone>\ttitle then: Film club\tplaying: ${String(EMBED?.url)}`,
      `  2026-10-09T12:00:02.000Z\tsexual\t${String(lines[2]?.split("\t")[2])}\tnote: -\ttitle then: Film club\tplaying: ${String(EMBED?.url)}`,
      `${OTHER}\tQuiet room\tpublic\tmembers 0\t1 open\tspam 1`,
      `  2026-10-09T12:00:01.000Z\tspam\t${String(lines[4]?.split("\t")[2])}\tnote: buy pills\ttitle then: Quiet room\tplaying: -`,
    ]);
    for (const i of [1, 2, 4]) expect(lines[i]?.split("\t")[2]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("a room that has gone is shown as gone; with nothing open it says so", async () => {
    const f = boot();
    expect((await cli(f.socket, "reports", "list")).out).toBe("no open reports");
    await report(f, OTHER, { reason: "spam" });
    const room = f.rooms.get(OTHER);
    if (room === undefined) throw new Error("no room");
    f.rooms.removeRoom(room);
    expect((await cli(f.socket, "reports", "list")).out.split("\n")[0]).toBe(`${OTHER}\t(gone)\t-\tmembers -\t1 open\tspam 1`);
  });

  test("escapes control and format characters in titles and notes", async () => {
    const f = boot(["lobby"], (store) => {
      store.createRoom({ id: ROOM, title: "Evil‮room", createdAt: T0, layout: DEFAULT_LAYOUT, pinned: false, ownerHash: OWNER });
    });
    await report(f, ROOM, { reason: "other", note: "fine note" });
    const { out } = await cli(f.socket, "reports", "list");
    expect(out).toContain("Evil\\u202eroom");
    expect(out).not.toContain("‮");
  });
});

describe("reports dismiss", () => {
  test("<reportId> dismisses one report; an unknown id exits 1", async () => {
    const f = boot();
    await report(f, ROOM, { reason: "spam" }, "198.51.100.1");
    await report(f, ROOM, { reason: "spam" }, "198.51.100.2");
    const id = f.db.query<{ id: string }, []>("SELECT id FROM reports ORDER BY id LIMIT 1").get()?.id ?? "";
    const done = await cli(f.socket, "reports", "dismiss", id);
    expect([done.code, done.out]).toEqual([0, "dismissed 1"]);
    expect(states(f, ROOM).sort()).toEqual(["dismissed", "open"]);
    const again = await cli(f.socket, "reports", "dismiss", id);
    expect(again.code).toBe(1);
    expect(again.err).toContain("no open report");
  });

  test("--room <id> dismisses the room's open reports, and the room can be reported again", async () => {
    const f = boot();
    await report(f, ROOM, { reason: "spam" }, "198.51.100.1");
    await report(f, ROOM, { reason: "spam" }, "198.51.100.2");
    const done = await cli(f.socket, "reports", "dismiss", "--room", ROOM);
    expect([done.code, done.out]).toEqual([0, "dismissed 2"]);
    expect((await report(f, ROOM, { reason: "hate" }, "198.51.100.1")).status).toBe(202);
    expect(f.rooms.get(ROOM)).toBeDefined();
  });
});

describe("usage", () => {
  test("bad report or room ids exit 2 without calling the server", async () => {
    const f = boot();
    for (const argv of [
      ["reports"],
      ["reports", "list", "x"],
      ["reports", "dismiss"],
      ["reports", "dismiss", "short"],
      ["reports", "dismiss", "--room"],
      ["reports", "dismiss", "--room", "BAD!"],
      ["rooms", "takedown"],
      ["rooms", "takedown", "../lobby"],
    ]) {
      const { code, err } = await cli(f.socket, ...argv);
      expect(code).toBe(2);
      expect(err).toContain("usage:");
    }
    expect(f.rooms.get(ROOM)).toBeDefined();
  });
});
