import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { DEFAULT_LAYOUT, type RoomLayout, type RoomListResponse } from "@omega/shared";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

const VIDEO = "dQw4w9WgXcQ";
const EMBED_URL = `https://www.youtube.com/embed/${VIDEO}`;
const SHARE_BODY = JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}` });

/** The plant moved to the far corner: a layout that is not DEFAULT_LAYOUT. */
const MOVED: RoomLayout = {
  furniture: DEFAULT_LAYOUT.furniture.map((f) => (f.kind === "plant" ? { ...f, col: 9, row: 9 } : f)),
};

let dir: string | null = null;
let t: TestServer | null = null;
let db: Database | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function dbFile(): string {
  dir ??= mkdtempSync(joinPath(tmpdir(), "omega-persist-"));
  return joinPath(dir, "omega.db");
}

/** Opens the file DB and boots a server on it, like `index.ts` does. */
function boot(opts: { rooms?: string[] } = {}): TestServer {
  db = openDatabase(dbFile());
  t = start({ store: new RoomStore(db), ...opts });
  return t;
}

/** Stops the server and closes the DB: a process restart. */
async function stop(): Promise<void> {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
}

async function join(server: TestServer, nickname: string, roomId = "lobby") {
  const r = await Client.join(server.ws(roomId), nickname);
  clients.push(r.client);
  return r;
}

async function roomIds(server: TestServer): Promise<string[]> {
  const body = (await (await fetch(`${server.http}/rooms`)).json()) as RoomListResponse;
  return body.rooms.map((r) => r.id);
}

describe("rooms, layout and last embed survive a restart (OME-280)", () => {
  test("first boot seeds the lobby with DEFAULT_LAYOUT, and the snapshot carries it", async () => {
    const server = boot();
    const { snapshot } = await join(server, "alice");
    expect(snapshot.room.layout).toEqual(DEFAULT_LAYOUT);
    expect(snapshot.room.embed).toBeNull();
    await stop();

    const check = openDatabase(dbFile());
    expect(new RoomStore(check).listRooms()).toMatchObject([{ id: "lobby", layout: DEFAULT_LAYOUT, embed: null }]);
    check.close();
  });

  test("the snapshot carries the stored layout, not the default", async () => {
    boot();
    await stop();
    const edit = openDatabase(dbFile());
    new RoomStore(edit).setLayout("lobby", MOVED);
    edit.close();

    const server = boot();
    const { snapshot } = await join(server, "alice");
    expect(snapshot.room.layout).toEqual(MOVED);
  });

  test("configured rooms missing from the DB are seeded; stored rooms load even when not configured", async () => {
    let server = boot({ rooms: ["lobby", "den"] });
    expect(await roomIds(server)).toEqual(["lobby", "den"]);
    await stop();

    server = boot({ rooms: ["lobby"] });
    expect(new Set(await roomIds(server))).toEqual(new Set(["lobby", "den"]));
    const { snapshot } = await join(server, "alice", "den");
    expect(snapshot.room.layout).toEqual(DEFAULT_LAYOUT);
  });

  test("the last shared embed comes back after a restart, paused at 0", async () => {
    let server = boot();
    const a = await join(server, "alice");
    const res = await postShare(server, SHARE_BODY, { token: tokenOf(a.snapshot) });
    expect(res.status).toBe(200);
    await a.client.next("embed-changed");
    a.client.send({ type: "control", url: EMBED_URL, playing: true, position: 42 });
    await a.client.next("playback");
    await stop();

    server = boot();
    const { snapshot } = await join(server, "bob");
    expect(snapshot.room.embed?.url).toBe(EMBED_URL);
    expect(snapshot.room.playback).toMatchObject({ playing: false, position: 0, rate: 1, by: null });
  });

  test("a restored embed can be played: control applies to it", async () => {
    let server = boot();
    const a = await join(server, "alice");
    await postShare(server, SHARE_BODY, { token: tokenOf(a.snapshot) });
    await stop();

    server = boot();
    const b = await join(server, "bob");
    const rev = b.snapshot.room.playback?.rev ?? -1;
    b.client.send({ type: "control", url: EMBED_URL, playing: true, position: 0 });
    const pb = (await b.client.next("playback")).playback;
    expect(pb).toMatchObject({ playing: true, by: b.snapshot.self });
    expect(pb.rev).toBeGreaterThan(rev);
  });

  test("a corrupt row refuses to boot instead of serving a forged layout (D4)", async () => {
    boot();
    await stop();
    const edit = openDatabase(dbFile());
    edit.run("UPDATE rooms SET layout = ? WHERE id = 'lobby'", [JSON.stringify({ furniture: [] })]);
    edit.close();
    expect(() => boot()).toThrow(/lobby/);
  });

  test("without a store, the snapshot still carries DEFAULT_LAYOUT", async () => {
    t = start();
    const { snapshot } = await join(t, "alice");
    expect(snapshot.room.layout).toEqual(DEFAULT_LAYOUT);
  });
});

describe("the store is never on the relay path (OME-280)", () => {
  test("control, chat, sit, status and ping never touch the store; a share writes the embed once", async () => {
    db = openDatabase(":memory:");
    const real = new RoomStore(db);
    const calls: string[] = [];
    let relaying = false;
    const spy = new Proxy(real, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          if (relaying) throw new Error(`store.${String(prop)} called on the relay path`);
          return Reflect.apply(value, target, args);
        };
      },
    });
    t = start({ store: spy });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    await a.client.next("member-joined");
    const shared = await postShare(t, SHARE_BODY, { token: tokenOf(a.snapshot) });
    expect(shared.status).toBe(200);
    await b.client.next("embed-changed");
    expect(calls.filter((c) => c === "setEmbed")).toHaveLength(1);

    calls.length = 0;
    relaying = true;
    a.client.send({ type: "control", url: EMBED_URL, playing: false, position: 3 });
    await b.client.next("playback");
    a.client.send({ type: "chat", text: "hi" });
    await b.client.next("chat");
    a.client.send({ type: "sit", seat: 0 });
    await b.client.next("seat-changed");
    a.client.send({ type: "ping", id: 1 });
    await a.client.next("pong");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    b.client.close();
    await a.client.next("member-left");
    expect(calls).toEqual([]);
  });
});
