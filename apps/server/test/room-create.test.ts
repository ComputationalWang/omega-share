import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import * as confusables from "@omega/shared/confusables";
import {
  CLOSE_CODES,
  CreateRoomResponseSchema,
  DeleteRoomResponseSchema,
  MAX_ROOMS,
  ROOM_CREATE_GLOBAL_BURST,
  ROOM_CREATE_GLOBAL_REFILL_MS,
  ROOM_CREATE_KEY_BURST,
  ROOM_CREATE_KEY_REFILL_MS,
  ROOM_CREATE_RETRY_AFTER_MAX_MS,
  RoomListResponseSchema,
  type CreateRoomResponse,
  type RoomListResponse,
} from "@omega/shared";
import { Room } from "../src/room";
import { RoomRegistry } from "../src/rooms";
import { openDatabase } from "../src/store/db";
import { RoomStore, type NewRoom } from "../src/store/rooms";
import type { RoomPersistence } from "../src/server";
import { Client, SITE_ORIGIN, postShare, start, tokenOf, type TestServer } from "./helpers";

/** `POST /rooms`, `DELETE /rooms/:id`, the public list and `/r/*` headers (ADR 0028 §1, §2, §4, §7; OME-404). */

let t: TestServer | null = null;
let db: Database | null = null;
let dir: string | null = null;
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

function fail(): never {
  throw new Error("no server");
}
const server = (): TestServer => t ?? fail();
function fakeClock() {
  const clock = { ms: 1_000_000, now: () => clock.ms };
  return clock;
}

let nextAddress = 1;
/** A fresh client address each call, so tests don't share the per-key creation bucket. */
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

interface CreateInit {
  address?: string;
  origin?: string;
}
function create(body: unknown, init: CreateInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": init.address ?? freshAddress() };
  if (init.origin !== undefined) headers["origin"] = init.origin;
  return fetch(`${server().http}/rooms`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function created(res: Response): Promise<Extract<CreateRoomResponse, { ok: true }>> {
  expect(res.status).toBe(201);
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (!body.ok) throw new Error(`create failed: ${body.error.code}`);
  return body;
}
async function errorOf(res: Response): Promise<string> {
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (body.ok) throw new Error("expected an error");
  return body.error.code;
}
function del(roomId: string, authorization?: string, address = "203.0.113.9"): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": address };
  if (authorization !== undefined) headers["authorization"] = authorization;
  return fetch(`${server().http}/rooms/${roomId}`, { method: "DELETE", headers });
}
async function listed(): Promise<RoomListResponse["rooms"]> {
  return v.parse(RoomListResponseSchema, await (await fetch(`${server().http}/rooms`)).json()).rooms;
}

const BASE32_ID = /^[a-z2-7]{26}$/;

describe("POST /rooms creates a room (ADR 0028 §1)", () => {
  test("201 with a server-chosen 26-char base32 id, the title and visibility, an owner token and no invite key for a public room", async () => {
    t = start({ trustProxy: true });
    const res = await create({ title: "Friday films", visibility: "public" });
    const body = await created(res);
    expect(body.room.id).toMatch(BASE32_ID);
    expect(body.room).toEqual({ id: body.room.id, title: "Friday films", visibility: "public" });
    expect(body.ownerToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.inviteKey).toBeUndefined();
    // The secrets are only in the body: never in a header, and never cached.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    for (const [, value] of res.headers) expect(value).not.toContain(body.ownerToken);
  });

  test("a private room also gets an invite key; ids, tokens and keys are all distinct", async () => {
    t = start({ trustProxy: true });
    const a = await created(await create({ title: "Den", visibility: "private" }));
    const b = await created(await create({ title: "Den", visibility: "private" }));
    expect(a.inviteKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const all = [a.room.id, b.room.id, a.ownerToken, b.ownerToken, a.inviteKey, b.inviteKey];
    expect(new Set(all).size).toBe(6);
  });

  test("the room starts from DEFAULT_LAYOUT with no embed, and anyone can join it", async () => {
    t = start({ trustProxy: true });
    const { room } = await created(await create({ title: "Den", visibility: "public" }));
    const joined = await Client.join(server().ws(room.id), "alice");
    clients.push(joined.client);
    expect(joined.snapshot.room.id).toBe(room.id);
    expect(joined.snapshot.room.embed).toBeNull();
    // An owner token never shows up in a snapshot.
    expect(joined.snapshot.owner).toBeUndefined();
  });

  test("the title is normalised by RoomTitleSchema (NFKC, trimmed)", async () => {
    t = start({ trustProxy: true });
    const { room } = await created(await create({ title: "  Ｆｒｉｄａｙ films ", visibility: "public" }));
    expect(room.title).toBe("Friday films");
  });

  test("a bad body is 400 invalid_body: not JSON, a bad title, an unknown visibility, extra keys", async () => {
    t = start({ trustProxy: true });
    for (const body of [
      "not json",
      { title: "", visibility: "public" },
      { title: "<script>", visibility: "public" },
      { title: "Den", visibility: "secret" },
      { title: "Den", visibility: "public", id: "lobby2" },
      { title: "Den" },
    ]) {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("invalid_body");
    }
  });

  test("a body over MAX_CREATE_BODY_BYTES is 413 payload_too_large", async () => {
    t = start({ trustProxy: true });
    const res = await create(JSON.stringify({ title: "Den", visibility: "public", pad: "x".repeat(2000) }));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toBe("payload_too_large");
  });

  test("a foreign Origin is refused; the site origin may create", async () => {
    t = start({ trustProxy: true });
    expect((await create({ title: "Den", visibility: "public" }, { origin: "https://evil.example" })).status).toBe(403);
    const ok = await create({ title: "Den", visibility: "public" }, { origin: SITE_ORIGIN });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
  });

  test("a CORS preflight from the site allows POST and DELETE with an Authorization header", async () => {
    t = start();
    const res = await fetch(`${server().http}/rooms/abc`, {
      method: "OPTIONS",
      headers: { origin: SITE_ORIGIN, "access-control-request-method": "DELETE", "access-control-request-headers": "authorization" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    const root = await fetch(`${server().http}/rooms`, {
      method: "OPTIONS",
      headers: { origin: SITE_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(root.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
    expect(root.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("a blocklisted title (ROOM_TITLE_BLOCKLIST, case and lookalikes folded) is 400 invalid_body", async () => {
    t = start({ trustProxy: true, roomTitleBlocklist: ["badword"] });
    for (const title of ["badword", "My BADWORD room", "Badw0rd"]) {
      const res = await create({ title, visibility: "public" });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("invalid_body");
    }
    expect((await create({ title: "Good room", visibility: "public" })).status).toBe(201);
  });

  test("the blocklist ignores whitespace and punctuation between letters: 'bad word', 'b.a.d-w_o r d' are refused", async () => {
    t = start({ trustProxy: true, roomTitleBlocklist: ["badword"] });
    for (const title of ["bad word", "b.a.d-w_o r d", "Bad, Word!"]) {
      const res = await create({ title, visibility: "public" });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("invalid_body");
    }
    expect((await create({ title: "Bade word", visibility: "public" })).status).toBe(201);
  });

  test("a store that can't write answers a typed 503 unavailable (no-store, nothing created) and gives the creation back", async () => {
    let failing = false;
    const writes: NewRoom[] = [];
    const store: RoomPersistence = {
      listRooms: () => [],
      createRoom: (room) => {
        if (failing) throw new Error("database is locked");
        writes.push(room);
      },
      deleteRoom: () => true,
      setEmbed: () => undefined,
      setLayout: () => undefined,
      setTitle: () => undefined,
      setLastActive: () => undefined,
    };
    const registry = new RoomRegistry();
    t = start({ trustProxy: true, store, registry });
    const size = registry.size;
    const address = "198.51.100.220";
    failing = true;
    for (let i = 0; i < ROOM_CREATE_KEY_BURST + 1; i++) {
      const res = await create({ title: "Den", visibility: "public" }, { address });
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await errorOf(res)).toBe("unavailable");
    }
    expect(registry.size).toBe(size);
    // The failed writes cost the client nothing: its whole burst is still there.
    failing = false;
    for (let i = 0; i < ROOM_CREATE_KEY_BURST; i++) expect((await create({ title: "Den", visibility: "public" }, { address })).status).toBe(201);
  });
});

describe("creation limits (ADR 0028 §1)", () => {
  test(`per key: ${String(ROOM_CREATE_KEY_BURST)} at once, then 429 rate_limited with Retry-After until one refills; other keys unaffected`, async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const address = "198.51.100.200";
    for (let i = 0; i < ROOM_CREATE_KEY_BURST; i++) expect((await create({ title: "Den", visibility: "public" }, { address })).status).toBe(201);
    const refused = await create({ title: "Den", visibility: "public" }, { address });
    expect(refused.status).toBe(429);
    const body = v.parse(CreateRoomResponseSchema, await refused.json());
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.retryAfterMs).toBeGreaterThan(0);
    }
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await create({ title: "Den", visibility: "public" }, { address: "198.51.100.201" })).status).toBe(201);
    clock.ms += ROOM_CREATE_KEY_REFILL_MS;
    expect((await create({ title: "Den", visibility: "public" }, { address })).status).toBe(201);
  });

  test("the per-key 429 gives the real wait, past the 60 s cap of other limits: the full refill, then what's left of it", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const address = "198.51.100.230";
    for (let i = 0; i < ROOM_CREATE_KEY_BURST; i++) expect((await create({ title: "Den", visibility: "public" }, { address })).status).toBe(201);
    const waitOf = async (): Promise<{ header: string | null; ms: number | undefined }> => {
      const res = await create({ title: "Den", visibility: "public" }, { address });
      expect(res.status).toBe(429);
      const body = v.parse(CreateRoomResponseSchema, await res.json());
      return { header: res.headers.get("retry-after"), ms: body.ok ? undefined : body.error.retryAfterMs };
    };
    expect(ROOM_CREATE_RETRY_AFTER_MAX_MS).toBe(600_000);
    expect(await waitOf()).toEqual({ header: "600", ms: 600_000 });
    clock.ms += 4 * 60_000;
    expect(await waitOf()).toEqual({ header: "360", ms: 360_000 });
  });

  test("malformed bodies take from the same per-key bucket", async () => {
    t = start({ trustProxy: true });
    const address = "198.51.100.210";
    for (let i = 0; i < ROOM_CREATE_KEY_BURST; i++) expect((await create("garbage", { address })).status).toBe(400);
    expect((await create({ title: "Den", visibility: "public" }, { address })).status).toBe(429);
  });

  test(`server-wide: ${String(ROOM_CREATE_GLOBAL_BURST)} at once from many keys, then 429 until one refills`, async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    for (let i = 0; i < ROOM_CREATE_GLOBAL_BURST; i++) expect((await create({ title: "Den", visibility: "public" })).status).toBe(201);
    const refused = await create({ title: "Den", visibility: "public" });
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toBe("rate_limited");
    clock.ms += ROOM_CREATE_GLOBAL_REFILL_MS;
    expect((await create({ title: "Den", visibility: "public" })).status).toBe(201);
  });

  test(`at MAX_ROOMS (${String(MAX_ROOMS)}, pinned included) creation is 503 too_many_rooms and no room is evicted`, async () => {
    const registry = new RoomRegistry();
    t = start({ trustProxy: true, registry });
    // The lobby is one; fill to one short of the cap.
    for (let i = registry.size; i < MAX_ROOMS - 1; i++) registry.addRoom(new Room(`seed-${String(i)}`));
    expect((await create({ title: "Last", visibility: "public" })).status).toBe(201);
    expect(registry.size).toBe(MAX_ROOMS);
    const refused = await create({ title: "One too many", visibility: "public" });
    expect(refused.status).toBe(503);
    expect(await errorOf(refused)).toBe("too_many_rooms");
    expect(registry.size).toBe(MAX_ROOMS);
    expect(registry.get("lobby")).toBeDefined();
    expect(registry.get("seed-1")).toBeDefined();
  });
});

describe("DELETE /rooms/:id (ADR 0028 §1, §2)", () => {
  test("the owner deletes: 200 ok, sockets close with ROOM_CLOSED (4004), the room leaves the list and its share tokens stop working", async () => {
    t = start({ trustProxy: true });
    const { room, ownerToken } = await created(await create({ title: "Den", visibility: "public" }));
    const a = await Client.join(server().ws(room.id), "alice");
    const lurker = await Client.open(server().ws(room.id));
    clients.push(a.client, lurker);
    lurker.send({ type: "ping", id: 1 });
    await lurker.next("pong");

    const res = await del(room.id, `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(v.parse(DeleteRoomResponseSchema, await res.json())).toEqual({ ok: true });
    expect((await a.client.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect((await lurker.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect((await listed()).map((r) => r.id)).toEqual(["lobby"]);
    const share = await postShare(server(), JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }), { roomId: room.id, token: tokenOf(a.snapshot) });
    expect(share.status).toBe(404);
    expect((await del(room.id, `Bearer ${ownerToken}`)).status).toBe(404);
  });

  test("a store that can't delete the row answers 503 unavailable and keeps the room: its sockets stay open, the owner can try again", async () => {
    let failing = false;
    const store: RoomPersistence = {
      listRooms: () => [],
      createRoom: () => undefined,
      deleteRoom: () => {
        if (failing) throw new Error("disk I/O error");
        return true;
      },
      setEmbed: () => undefined,
      setLayout: () => undefined,
      setTitle: () => undefined,
      setLastActive: () => undefined,
    };
    t = start({ trustProxy: true, store });
    const { room, ownerToken } = await created(await create({ title: "Den", visibility: "public" }));
    const a = await Client.join(server().ws(room.id), "alice");
    clients.push(a.client);
    failing = true;
    const res = await del(room.id, `Bearer ${ownerToken}`);
    expect(res.status).toBe(503);
    expect(v.parse(DeleteRoomResponseSchema, await res.json())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    // Nothing changed: the room is still listed and its members are still in it.
    expect((await listed()).map((r) => r.id)).toContain(room.id);
    a.client.send({ type: "ping", id: 7 });
    await a.client.next("pong");
    failing = false;
    expect((await del(room.id, `Bearer ${ownerToken}`)).status).toBe(200);
    expect((await a.client.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
  });

  test("unknown room is 404 room_not_found; a missing, malformed or wrong bearer is 401 unauthorized; another room's token doesn't work", async () => {
    t = start({ trustProxy: true });
    const a = await created(await create({ title: "One", visibility: "public" }));
    const b = await created(await create({ title: "Two", visibility: "private" }));
    const code = async (res: Response) => v.parse(DeleteRoomResponseSchema, await res.json());

    const unknown = await del("abcdefghijklmnopqrstuvwxyz", `Bearer ${a.ownerToken}`);
    expect(unknown.status).toBe(404);
    expect(await code(unknown)).toMatchObject({ ok: false, error: { code: "room_not_found" } });
    for (const auth of [undefined, "Bearer short", `Basic ${a.ownerToken}`, `Bearer ${b.ownerToken}`, `Bearer ${b.inviteKey ?? ""}`]) {
      const res = await del(a.room.id, auth);
      expect(res.status).toBe(401);
      expect(await code(res)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    }
    // The invite key admits; it never owns.
    expect((await del(b.room.id, `Bearer ${b.inviteKey ?? ""}`)).status).toBe(401);
    expect((await del(a.room.id, `Bearer ${a.ownerToken}`)).status).toBe(200);
    expect((await del(b.room.id, `Bearer ${b.ownerToken}`)).status).toBe(200);
  });

  test("a seeded (pinned) room has no owner: nobody can delete the lobby", async () => {
    t = start({ trustProxy: true });
    const { ownerToken } = await created(await create({ title: "Den", visibility: "public" }));
    expect((await del("lobby", `Bearer ${ownerToken}`)).status).toBe(401);
    expect((await listed()).map((r) => r.id)).toContain("lobby");
  });

  test("failed deletes take from a per-key bucket: guessing is 429 rate_limited after a burst", async () => {
    t = start({ trustProxy: true });
    const { room, ownerToken } = await created(await create({ title: "Den", visibility: "public" }));
    const wrong = `Bearer ${"A".repeat(22)}`;
    let status = 401;
    let tries = 0;
    while (status === 401 && tries < 100) {
      status = (await del(room.id, wrong, "203.0.113.50")).status;
      tries++;
    }
    expect(status).toBe(429);
    // Another key is unaffected, and the owner still can.
    expect((await del(room.id, `Bearer ${ownerToken}`, "203.0.113.51")).status).toBe(200);
  });
});

describe("GET /rooms lists public rooms only (ADR 0028 §4, research §3.5)", () => {
  test("private rooms are never listed; created rooms show their titles; seeded rooms without one carry no title", async () => {
    t = start({ trustProxy: true });
    const pub = await created(await create({ title: "Open house", visibility: "public" }));
    await created(await create({ title: "Hidden", visibility: "private" }));
    const rooms = await listed();
    expect(rooms).toEqual([
      { id: "lobby", memberCount: 0, seatedCount: 0 },
      { id: pub.room.id, title: "Open house", memberCount: 0, seatedCount: 0 },
    ]);
  });

  test("pinned rooms first, then by members, then newest first", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const old = await created(await create({ title: "Old", visibility: "public" }));
    await Bun.sleep(5);
    const busy = await created(await create({ title: "Busy", visibility: "public" }));
    await Bun.sleep(5);
    const fresh = await created(await create({ title: "Fresh", visibility: "public" }));
    const a = await Client.join(server().ws(busy.room.id), "alice");
    clients.push(a.client);
    expect((await listed()).map((r) => r.id)).toEqual(["lobby", busy.room.id, fresh.room.id, old.room.id]);
  });

  test("a room whose title is on the blocklist is left out of the list", async () => {
    const registry = new RoomRegistry();
    t = start({ registry, roomTitleBlocklist: ["spam"] });
    registry.addRoom(new Room("aaaaaaaaaaaaaaaaaaaaaaaaaa", { title: "Spam palace", pinned: false }));
    expect((await listed()).map((r) => r.id)).toEqual(["lobby"]);
  });

  test("titles are checked against the blocklist once per room, not on every list request", async () => {
    const registry = new RoomRegistry();
    t = start({ registry, roomTitleBlocklist: ["spam"] });
    for (let i = 0; i < 50; i++) registry.addRoom(new Room(`room-${String(i).padStart(21, "0")}`, { title: `Room ${String(i)}`, pinned: false }));
    registry.addRoom(new Room("aaaaaaaaaaaaaaaaaaaaaaaaaa", { title: "Spam palace", pinned: false }));
    expect(await listed()).toHaveLength(51);
    const fold = spyOn(confusables, "nicknameKey");
    try {
      for (let i = 0; i < 3; i++) expect((await listed()).map((r) => r.id)).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(fold).toHaveBeenCalledTimes(0);
    } finally {
      fold.mockRestore();
    }
  });
});

describe("headers (ADR 0028 §4)", () => {
  test("/r/* carries X-Robots-Tag: noindex, nofollow and Referrer-Policy strict-origin-when-cross-origin; the API doesn't get the robots tag", async () => {
    t = start();
    for (const path of ["/r/lobby", "/r/abcdefghijklmnopqrstuvwxyz"]) {
      const res = await fetch(`${server().http}${path}`);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
    const api = await fetch(`${server().http}/rooms`);
    expect(api.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(api.headers.get("x-robots-tag")).toBeNull();
  });
});

describe("persistence of created rooms (migration 0002)", () => {
  function boot(): TestServer {
    dir ??= mkdtempSync(join(tmpdir(), "omega-create-"));
    db = openDatabase(join(dir, "omega.db"));
    t = start({ store: new RoomStore(db), trustProxy: true });
    return t;
  }
  async function restart(): Promise<TestServer> {
    await t?.server.stop(true);
    db?.close();
    return boot();
  }

  test("a created room survives a restart with its title and visibility, and its owner token still deletes it", async () => {
    boot();
    const pub = await created(await create({ title: "Open house", visibility: "public" }));
    const priv = await created(await create({ title: "Hidden", visibility: "private" }));
    await restart();
    expect(await listed()).toContainEqual({ id: pub.room.id, title: "Open house", memberCount: 0, seatedCount: 0 });
    expect((await listed()).map((r) => r.id)).not.toContain(priv.room.id);
    expect((await del(priv.room.id, `Bearer ${pub.ownerToken}`)).status).toBe(401);
    expect((await del(priv.room.id, `Bearer ${priv.ownerToken}`)).status).toBe(200);
    // Deleted means the row is gone: it doesn't come back after the next restart.
    await restart();
    expect((await fetch(`${server().http}/rooms/${priv.room.id}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(404);
    expect((await del(pub.room.id, `Bearer ${pub.ownerToken}`)).status).toBe(200);
  });

  test("no address, creator or hash of one is written to disk; the owner token and invite key are stored only as SHA-256", async () => {
    boot();
    const address = "198.51.100.77";
    const body = await created(await create({ title: "Hidden", visibility: "private" }, { address }));
    await t?.server.stop(true);
    t = null;
    // Everything SQLite wrote: the main file, the WAL and its index.
    const files = readdirSync(dir ?? fail()).map((f) => readFileSync(join(dir ?? fail(), f)));
    const disk = Buffer.concat(files);
    const sha = (s: string) => createHash("sha256").update(s).digest();
    for (const secret of [address, body.ownerToken, body.inviteKey ?? fail()]) {
      expect(disk.includes(Buffer.from(secret))).toBe(false);
    }
    expect(disk.includes(sha(address))).toBe(false);
    expect(disk.includes(Buffer.from(sha(address).toString("hex")))).toBe(false);
    expect(disk.includes(sha(body.ownerToken))).toBe(true);
    expect(disk.includes(sha(body.inviteKey ?? fail()))).toBe(true);
    // And no column could hold one.
    const columns = (db ?? fail()).query<{ name: string }, []>("SELECT name FROM pragma_table_info('rooms')").all().map((c) => c.name);
    expect(columns.sort()).toEqual(["created_at", "embed", "id", "invite_hash", "last_active_at", "layout", "owner_hash", "pinned", "title", "visibility"]);
  });
});
