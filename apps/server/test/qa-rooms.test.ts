import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  CLOSE_CODES,
  CreateRoomResponseSchema,
  DEFAULT_LAYOUT,
  DeleteRoomResponseSchema,
  MAX_ROOMS,
  ROOM_CREATE_GLOBAL_BURST,
  ROOM_CREATE_GLOBAL_REFILL_MS,
  ROOM_CREATE_KEY_BURST,
  ROOM_CREATE_KEY_REFILL_MS,
  ROOM_CREATE_RETRY_AFTER_MAX_MS,
  ROOM_EDIT_BURST,
  ROOM_EDIT_REFILL_MS,
  ROOM_GC_EMPTY_MS,
  ROOM_GC_NEVER_JOINED_MS,
  RoomListResponseSchema,
  type CreateRoomResponse,
  type RoomLayout,
  type RoomVisibility,
} from "@omega/shared";
import { hashSecret, mintSecret, newRoomId } from "../src/secrets";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, start, postShare, tokenOf, type TestServer } from "./helpers";

/**
 * QA's independent, black-box check of M5 rooms (OME-417): creation limits, private rooms, owner-token
 * secrecy, delete, GC, `layout-set` and enumeration probes, all over the wire (ADR 0028; threat model
 * docs/research/m4-rooms-threat-model.md §1-§3, §5, §6.2). Limiter and GC time is injected, never slept.
 */

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

function fail(msg = "no server"): never {
  throw new Error(msg);
}
const server = (): TestServer => t ?? fail();

function fakeClock(ms = 1_000_000) {
  const clock = { ms, now: () => clock.ms };
  return clock;
}

let nextAddress = 1;
/** A fresh client key each call (needs `trustProxy`), so tests don't share per-key buckets. */
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;
/** Never-reused WRONG secrets: well formed (22 base64url chars) but matching nothing. */
const WRONG = "AAAAAAAAAAAAAAAAAAAAAA";
const YOUTUBE = JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" });

type Created = Extract<CreateRoomResponse, { ok: true }>;

function create(body: unknown, address = freshAddress(), extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server().http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address, ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function createRoom(visibility: RoomVisibility = "public", title = "Friday films", address = freshAddress()): Promise<Created> {
  const res = await create({ title, visibility }, address);
  expect(res.status).toBe(201);
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (!body.ok) throw new Error(`create failed: ${body.error.code}`);
  return body;
}
async function errorOf(res: Response): Promise<{ code: string; retryAfterMs?: number | undefined }> {
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (body.ok) throw new Error("expected an error");
  return body.error;
}
function del(roomId: string, authorization?: string, address = freshAddress()): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": address };
  if (authorization !== undefined) headers["authorization"] = authorization;
  return fetch(`${server().http}/rooms/${roomId}`, { method: "DELETE", headers });
}
async function listedIds(): Promise<string[]> {
  const res = await fetch(`${server().http}/rooms`, { headers: { "x-forwarded-for": freshAddress() } });
  return v.parse(RoomListResponseSchema, await res.json()).rooms.map((r) => r.id);
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
  client.send({
    type: "join",
    nickname,
    avatar: 0,
    ...(init.ownerToken === undefined ? {} : { ownerToken: init.ownerToken }),
    ...(init.inviteKey === undefined ? {} : { inviteKey: init.inviteKey }),
  });
  return { client, snapshot: await client.next("snapshot") };
}
/** First reply to a join: "snapshot" or the error code. */
async function joinOutcome(roomId: string, nickname: string, init: JoinInit = {}): Promise<{ client: Client; outcome: string }> {
  const client = await open(roomId, init.address);
  client.send({
    type: "join",
    nickname,
    avatar: 0,
    ...(init.ownerToken === undefined ? {} : { ownerToken: init.ownerToken }),
    ...(init.inviteKey === undefined ? {} : { inviteKey: init.inviteKey }),
  });
  for (let waited = 0; waited < 1000; waited += 5) {
    for (const frame of client.raw) {
      const msg = JSON.parse(frame) as { type: string; code?: string };
      if (msg.type === "snapshot") return { client, outcome: "snapshot" };
      if (msg.type === "error" && msg.code !== undefined) return { client, outcome: msg.code };
    }
    await Bun.sleep(5);
  }
  throw new Error("no reply to join");
}
/** Whether a WebSocket upgrade to the room fails (the room does not exist). */
async function upgradeRefused(roomId: string): Promise<boolean> {
  try {
    const c = await Client.open(server().ws(roomId), undefined, { "x-forwarded-for": freshAddress() });
    clients.push(c);
    return false;
  } catch {
    return true;
  }
}
/** Round trip, so everything the server did for earlier frames has happened. */
async function sync(c: Client, id = 1): Promise<void> {
  c.send({ type: "ping", id });
  await c.next("pong");
}
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await cond()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out: ${what}`);
}

/** DEFAULT_LAYOUT with its first piece moved to the end: a different, still valid, layout. */
function movedLayout(): RoomLayout {
  const [first, ...rest] = DEFAULT_LAYOUT.furniture;
  if (first === undefined) throw new Error("DEFAULT_LAYOUT has no furniture");
  return { furniture: [...rest, first] };
}
const layoutsEqual = (a: RoomLayout, b: RoomLayout): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A store seeded with the lobby plus `n` created rooms, as a restart would find them. */
function seedStore(path: string, n: number): { store: RoomStore; rooms: { id: string; ownerToken: string }[] } {
  db = openDatabase(path);
  const store = new RoomStore(db);
  store.createRoom({ id: "lobby", title: "", createdAt: 1000, layout: DEFAULT_LAYOUT });
  const rooms: { id: string; ownerToken: string }[] = [];
  for (let i = 0; i < n; i++) {
    const ownerToken = mintSecret();
    const id = newRoomId();
    store.createRoom({
      id,
      title: `Room ${String(i)}`,
      createdAt: 2000 + i,
      layout: DEFAULT_LAYOUT,
      visibility: "public",
      pinned: false,
      ownerHash: hashSecret(ownerToken),
      inviteHash: null,
    });
    rooms.push({ id, ownerToken });
  }
  return { store, rooms };
}

// ---------------------------------------------------------------------------------------------------

describe("1. creation limits (ADR 0028 §1, threat model §1.2)", () => {
  test("per key: the burst succeeds, then 429 rate_limited with Retry-After and retryAfterMs; another key is unaffected; the refill restores it", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const address = "203.0.113.5";
    for (let i = 0; i < ROOM_CREATE_KEY_BURST; i++) expect((await create({ title: `Den ${String(i)}`, visibility: "public" }, address)).status).toBe(201);
    const limited = await create({ title: "Den X", visibility: "public" }, address);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(ROOM_CREATE_RETRY_AFTER_MAX_MS / 1000);
    const err = await errorOf(limited);
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(ROOM_CREATE_RETRY_AFTER_MAX_MS);
    // A different key has its own bucket.
    expect((await create({ title: "Den Y", visibility: "public" }, "203.0.113.6")).status).toBe(201);
    // Not before the refill, then one more.
    clock.ms += ROOM_CREATE_KEY_REFILL_MS - 1000;
    expect((await create({ title: "Den Z", visibility: "public" }, address)).status).toBe(429);
    clock.ms += 1000;
    expect((await create({ title: "Den Z", visibility: "public" }, address)).status).toBe(201);
  });

  test("a refused creation makes no room; a malformed body and an oversize body still take from the key's bucket", async () => {
    t = start({ trustProxy: true });
    const address = "203.0.113.7";
    expect((await create("{not json", address)).status).toBe(400);
    expect((await create({ title: "x".repeat(2000), visibility: "public" }, address)).status).toBe(413);
    const res = await create({ title: "Den", visibility: "public" }, address);
    expect(res.status).toBe(429);
    expect(await listedIds()).toEqual(["lobby"]);
  });

  test("globally: many keys together hit 429 rate_limited after ROOM_CREATE_GLOBAL_BURST, and the refill restores one", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    for (let i = 0; i < ROOM_CREATE_GLOBAL_BURST; i++) expect((await create({ title: `Den ${String(i)}`, visibility: "public" })).status).toBe(201);
    const res = await create({ title: "Late", visibility: "public" });
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe("rate_limited");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await listedIds()).length).toBe(1 + ROOM_CREATE_GLOBAL_BURST);
    clock.ms += ROOM_CREATE_GLOBAL_REFILL_MS;
    expect((await create({ title: "Later", visibility: "public" })).status).toBe(201);
    expect((await create({ title: "Latest", visibility: "public" })).status).toBe(429);
  });

  test("at MAX_ROOMS: 503 too_many_rooms, and NO room is evicted: every room, the least recently active included, is still joinable and still deletable by its owner (also after a restart)", async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-rooms-"));
    const path = join(dir, "omega.db");
    const { store, rooms } = seedStore(path, MAX_ROOMS - 1);
    // The first room is the least recently active of all; the second the most recent.
    // Inside every seeded room's 1 h never-joined window, so the boot GC sweep leaves them alone.
    const NOW = 100_000;
    const oldest = rooms[0] ?? fail("no seeded rooms");
    const newest = rooms.at(-1) ?? fail("no seeded rooms");
    store.setLastActive(oldest.id, 1);
    store.setLastActive(newest.id, NOW - 1000);
    t = start({ trustProxy: true, store, wallNow: () => NOW });

    const refused = await create({ title: "One too many", visibility: "public" });
    expect(refused.status).toBe(503);
    expect((await errorOf(refused)).code).toBe("too_many_rooms");
    // Again, and a private one: still refused.
    expect((await create({ title: "And another", visibility: "private" })).status).toBe(503);

    const joinable = async (id: string): Promise<boolean> => {
      const { outcome } = await joinOutcome(id, "visitor");
      return outcome === "snapshot";
    };
    expect(await joinable(oldest.id)).toBe(true);
    expect(await joinable(newest.id)).toBe(true);
    expect(await joinable("lobby")).toBe(true);

    // Restart on the same DB file: nothing was evicted from disk either.
    await server().server.stop(true);
    db?.close();
    db = openDatabase(path);
    const store2 = new RoomStore(db);
    expect(store2.listRooms().length).toBe(MAX_ROOMS);
    t = start({ trustProxy: true, store: store2, wallNow: () => NOW });
    expect((await create({ title: "Still too many", visibility: "public" })).status).toBe(503);
    expect(await joinable(oldest.id)).toBe(true);

    // The owner of the least-active room can still delete it; that frees exactly one slot.
    expect((await del(oldest.id, `Bearer ${oldest.ownerToken}`)).status).toBe(200);
    expect((await joinOutcome(oldest.id, "late").catch(() => ({ outcome: "refused" }))).outcome).toBe("refused");
    expect((await create({ title: "Fits now", visibility: "public" })).status).toBe(201);
    expect((await create({ title: "Full again", visibility: "public" })).status).toBe(503);
  });

  test("with TRUST_PROXY off a spoofed X-Forwarded-For does not reset the per-key bucket", async () => {
    t = start({ trustProxy: false });
    const codes: number[] = [];
    for (let i = 0; i < ROOM_CREATE_KEY_BURST + 3; i++) {
      codes.push((await create({ title: `Den ${String(i)}`, visibility: "public" }, `192.0.2.${String(i + 1)}`)).status);
    }
    expect(codes).toEqual([...Array.from({ length: ROOM_CREATE_KEY_BURST }, () => 201), 429, 429, 429]);
  });

  test("with a trusted proxy the key is the rightmost forwarded entry: a client-chosen prefix does not reset it, a different client gets its own", async () => {
    t = start({ trustProxy: true });
    const codes: number[] = [];
    for (let i = 0; i < ROOM_CREATE_KEY_BURST + 2; i++) {
      // The tunnel appends the real client; whatever the client put in front is ignored.
      codes.push((await create({ title: `Den ${String(i)}`, visibility: "public" }, `10.9.8.${String(i)}, 203.0.113.77`)).status);
    }
    expect(codes).toEqual([...Array.from({ length: ROOM_CREATE_KEY_BURST }, () => 201), 429, 429]);
    expect((await create({ title: "Other", visibility: "public" }, "203.0.113.78")).status).toBe(201);
    // A non-address header value is not a key of its own: they all share one bucket.
    const junk: number[] = [];
    for (let i = 0; i < ROOM_CREATE_KEY_BURST + 1; i++) junk.push((await create({ title: `J${String(i)}`, visibility: "public" }, `junk-${String(i)}`)).status);
    expect(junk.at(-1)).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------------

describe("2. private rooms (ADR 0028 §4, threat model §3)", () => {
  test("a private room is never in GET /rooms: not new, not with members, not titled, not after a title-set", async () => {
    t = start({ trustProxy: true });
    const pub = await createRoom("public", "Open house");
    const priv = await createRoom("private", "Secret club");
    const check = async (): Promise<void> => {
      const res = await fetch(`${server().http}/rooms`, { headers: { "x-forwarded-for": freshAddress() } });
      const text = await res.text();
      const ids = v.parse(RoomListResponseSchema, JSON.parse(text)).rooms.map((r) => r.id);
      expect(ids).toContain(pub.room.id);
      expect(ids).not.toContain(priv.room.id);
      // No hint in the body at all: id, title, key.
      expect(text).not.toContain(priv.room.id);
      expect(text).not.toContain("Secret club");
      expect(text).not.toContain("Renamed secret");
    };
    await check();
    const owner = await joined(priv.room.id, "olive", { ownerToken: priv.ownerToken });
    const guest = await joined(priv.room.id, "gus", { inviteKey: priv.inviteKey ?? fail() });
    await check();
    owner.client.send({ type: "title-set", title: "Renamed secret" });
    expect((await guest.client.next("title-changed")).title).toBe("Renamed secret");
    await check();
    // Its member count must not shift the public list either.
    const res = await fetch(`${server().http}/rooms`, { headers: { "x-forwarded-for": freshAddress() } });
    expect(v.parse(RoomListResponseSchema, await res.json()).rooms.find((r) => r.id === pub.room.id)?.memberCount).toBe(0);
  });

  test("a join without the invite key, with a wrong one, or with another private room's key is refused: invite_required, no snapshot, no broadcasts, socket stays open", async () => {
    t = start({ trustProxy: true });
    const a = await createRoom("private", "Room A");
    const b = await createRoom("private", "Room B");
    const inside = await joined(a.room.id, "alice", { inviteKey: a.inviteKey ?? fail() });
    const attempts: JoinInit[] = [{}, { inviteKey: WRONG }, { inviteKey: b.inviteKey ?? fail() }, { inviteKey: a.room.id.slice(0, 22).padEnd(22, "a") }];
    for (const [i, init] of attempts.entries()) {
      const { client, outcome } = await joinOutcome(a.room.id, `mallory${String(i)}`, init);
      expect(outcome).toBe("invite_required");
      expect(client.raw.some((f) => f.includes('"snapshot"'))).toBe(false);
      expect((await client.next("error")).code).toBe("invite_required");
      client.send({ type: "chat", text: "let me in" });
      expect((await client.next("error")).code).toBe("not_joined");
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    }
    await inside.client.none("member-joined", 100);
    await inside.client.none("chat", 10);
    // B's owner token is not A's either.
    expect((await joinOutcome(a.room.id, "mallory9", { ownerToken: b.ownerToken })).outcome).toBe("invite_required");
    // An invite key is for its own room only: and A's key opens nothing in B.
    expect((await joinOutcome(b.room.id, "mallory8", { inviteKey: a.inviteKey ?? fail() })).outcome).toBe("invite_required");
  });

  test("with the right invite key the join works as a guest; the owner token admits too, as the owner", async () => {
    t = start({ trustProxy: true });
    const priv = await createRoom("private");
    const guest = await joined(priv.room.id, "gus", { inviteKey: priv.inviteKey ?? fail() });
    expect(guest.snapshot.room.id).toBe(priv.room.id);
    expect(guest.snapshot.owner).toBeUndefined();
    const owner = await joined(priv.room.id, "olive", { ownerToken: priv.ownerToken });
    expect(owner.snapshot.owner).toBe(true);
    expect(owner.snapshot.room.members.map((m) => m.nickname).sort()).toEqual(["gus", "olive"]);
  });

  test("a failed attempt does not lock the right key out: after refusals the invite key still joins", async () => {
    t = start({ trustProxy: true });
    const priv = await createRoom("private");
    const address = freshAddress();
    expect((await joinOutcome(priv.room.id, "m1", { address })).outcome).toBe("invite_required");
    expect((await joinOutcome(priv.room.id, "m2", { address, inviteKey: priv.inviteKey ?? fail() })).outcome).toBe("snapshot");
  });

  test("visibility cannot be changed by a client: the create body is strict and the id format is the same for public and private", async () => {
    t = start({ trustProxy: true });
    expect((await create({ title: "Den", visibility: "private", inviteKey: WRONG })).status).toBe(400);
    expect((await create({ title: "Den", visibility: "secret" })).status).toBe(400);
    expect((await create({ title: "Den", visibility: "private", id: "mine" })).status).toBe(400);
    const pub = await createRoom("public");
    const priv = await createRoom("private");
    expect(pub.room.id).toMatch(/^[a-z2-7]{26}$/);
    expect(priv.room.id).toMatch(/^[a-z2-7]{26}$/);
    expect(pub.inviteKey).toBeUndefined();
    expect(priv.inviteKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(priv.ownerToken).not.toBe(priv.inviteKey);
  });
});

// ---------------------------------------------------------------------------------------------------

describe("3. the owner token and invite key never leave (ADR 0028 §3, threat model §2, §6.2 S2)", () => {
  test("no frame any client receives, and no HTTP response but the create one, ever carries the owner token or the invite key", async () => {
    t = start({ trustProxy: true });
    const priv = await createRoom("private", "Secret club");
    const inviteKey = priv.inviteKey ?? fail("no invite key");
    const secrets = [priv.ownerToken, inviteKey];
    const http: string[] = [];
    const text = async (res: Response): Promise<void> => {
      http.push(`${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`);
    };

    const owner = await joined(priv.room.id, "olive", { ownerToken: priv.ownerToken });
    const guest = await joined(priv.room.id, "gus", { inviteKey });
    const wrongOwner = await joined(priv.room.id, "wanda", { inviteKey, ownerToken: WRONG });

    // Everything an owner and a guest can do.
    owner.client.send({ type: "layout-set", layout: movedLayout() });
    await guest.client.next("layout-changed");
    owner.client.send({ type: "title-set", title: "Renamed club" });
    await guest.client.next("title-changed");
    owner.client.send({ type: "chat", text: "welcome" });
    guest.client.send({ type: "chat", text: "thanks" });
    guest.client.send({ type: "sit", seat: 0 });
    guest.client.send({ type: "emote", kind: "wave" });
    guest.client.send({ type: "layout-set", layout: DEFAULT_LAYOUT });
    await guest.client.next("error");
    await text(await postShare(server(), YOUTUBE, { roomId: priv.room.id, token: tokenOf(guest.snapshot), headers: { "x-forwarded-for": freshAddress() } }));
    await owner.client.next("embed-changed");
    guest.client.send({ type: "control", action: "pause", position: 1 });
    await sync(owner.client);
    await sync(guest.client);
    const late = await joined(priv.room.id, "lena", { inviteKey });
    guest.client.send({ type: "leave" });
    await sync(owner.client, 2);

    // HTTP surface.
    const h = { "x-forwarded-for": freshAddress() };
    await text(await fetch(`${server().http}/rooms`, { headers: h }));
    await text(await fetch(`${server().http}/rooms/${priv.room.id}`, { headers: h }));
    await text(await fetch(`${server().http}/rooms/${priv.room.id}/ws`, { headers: h }));
    await text(await del(priv.room.id, `Bearer ${WRONG}`));
    await text(await del(priv.room.id));
    await text(await del(priv.room.id, `Bearer ${inviteKey}`));
    await text(await postShare(server(), YOUTUBE, { roomId: priv.room.id, token: priv.ownerToken, headers: h }));
    await text(await postShare(server(), "{}", { roomId: priv.room.id, headers: h }));
    await text(await create({ title: "Other", visibility: "private" }));
    const other = http.pop() ?? fail();
    expect(other).not.toContain(priv.ownerToken);

    const frames = [owner, guest, wrongOwner, late].flatMap((p) => p.client.raw);
    expect(frames.length).toBeGreaterThan(10);
    for (const frame of frames) for (const s of secrets) expect(frame).not.toContain(s);
    for (const body of http) for (const s of secrets) expect(body).not.toContain(s);
    // A share token authorises nothing else: the owner token is not one.
    expect(http.some((r) => r.startsWith("401"))).toBe(true);
  });

  test("snapshot `owner` is a boolean true, only in the owner's own snapshot: never in a guest's frames, a wrong-token joiner's, or any member record", async () => {
    t = start({ trustProxy: true });
    const priv = await createRoom("public");
    const owner = await joined(priv.room.id, "olive", { ownerToken: priv.ownerToken });
    const guest = await joined(priv.room.id, "gus");
    const wrong = await joined(priv.room.id, "wanda", { ownerToken: WRONG });
    const late = await joined(priv.room.id, "lena");
    expect(owner.snapshot.owner).toBe(true);
    for (const p of [guest, wrong, late]) {
      expect(p.snapshot.owner).toBeUndefined();
      expect(p.client.raw.some((f) => f.includes('"owner"'))).toBe(false);
    }
    // The owner's own frames mention it exactly once: in the snapshot.
    expect(owner.client.raw.filter((f) => f.includes('"owner"')).length).toBe(1);
    expect((JSON.parse(owner.client.raw[0] ?? fail()) as { type: string }).type).toBe("snapshot");
    // Who the owner is, is not in any member record, nor in a broadcast.
    for (const p of [owner, guest, wrong, late]) {
      for (const m of p.snapshot.room.members) expect(Object.keys(m)).not.toContain("owner");
    }
    // Nor the hash of the token.
    const hex = new Bun.CryptoHasher("sha256").update(priv.ownerToken).digest("hex");
    const b64 = Buffer.from(hashSecret(priv.ownerToken)).toString("base64");
    for (const p of [owner, guest, wrong, late]) for (const f of p.client.raw) {
      expect(f).not.toContain(hex);
      expect(f).not.toContain(b64);
    }
  });

  test("the owner token is a secret of its own room: it makes nobody the owner of another room", async () => {
    t = start({ trustProxy: true });
    const a = await createRoom("public");
    const b = await createRoom("public");
    const j = await joined(b.room.id, "mallory", { ownerToken: a.ownerToken });
    expect(j.snapshot.owner).toBeUndefined();
    j.client.send({ type: "title-set", title: "Hijacked" });
    expect((await j.client.next("error")).code).toBe("not_owner");
    expect((await del(b.room.id, `Bearer ${a.ownerToken}`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------

describe("4. delete (ADR 0028 §2)", () => {
  test("owner DELETE closes every socket in the room with 4004, joined or not; their share tokens stop working; a re-join is refused; the id is not reissued", async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-rooms-"));
    db = openDatabase(join(dir, "omega.db"));
    const store = new RoomStore(db);
    t = start({ trustProxy: true, store });
    const room = await createRoom("public");
    expect(store.listRooms().some((r) => r.id === room.room.id)).toBe(true);
    const a = await joined(room.room.id, "alice");
    const b = await joined(room.room.id, "bob", { ownerToken: room.ownerToken });
    const lurker = await open(room.room.id);
    await sync(lurker);
    // A bystander in another room must be untouched.
    const lobby = await joined("lobby", "carol");

    const res = await del(room.room.id, `Bearer ${room.ownerToken}`);
    expect(res.status).toBe(200);
    expect(v.parse(DeleteRoomResponseSchema, await res.json())).toEqual({ ok: true });
    for (const c of [a.client, b.client, lurker]) expect((await c.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect(lobby.client.socket.readyState).toBe(WebSocket.OPEN);

    // Grants are revoked: neither member's share token works, here (room gone) or against another room.
    for (const p of [a, b]) {
      const share = await postShare(server(), YOUTUBE, { roomId: room.room.id, token: tokenOf(p.snapshot), headers: { "x-forwarded-for": freshAddress() } });
      expect(share.status).toBe(404);
      const cross = await postShare(server(), YOUTUBE, { roomId: "lobby", token: tokenOf(p.snapshot), headers: { "x-forwarded-for": freshAddress() } });
      expect(cross.status).toBe(401);
    }
    // Gone from the list, the store, and refused on join.
    expect(await listedIds()).toEqual(["lobby"]);
    expect(store.listRooms().some((r) => r.id === room.room.id)).toBe(false);
    expect(await upgradeRefused(room.room.id)).toBe(true);
    const upgrade = await fetch(`${server().http}/rooms/${room.room.id}/ws`, { headers: { "x-forwarded-for": freshAddress() } });
    expect(upgrade.status).toBe(404);
    // The token is dead, and the id is never given to a later room (128 random bits; fresh ids differ).
    expect((await del(room.room.id, `Bearer ${room.ownerToken}`)).status).toBe(404);
    const later = new Set<string>();
    for (let i = 0; i < ROOM_CREATE_KEY_BURST; i++) later.add((await createRoom("public", `Later ${String(i)}`)).room.id);
    expect(later.has(room.room.id)).toBe(false);
    expect((await joinOutcome(room.room.id, "again").catch(() => ({ outcome: "refused" }))).outcome).toBe("refused");
  });

  test("a member's share token cannot delete; neither can a wrong or missing bearer; the room survives them all", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const a = await joined(room.room.id, "alice");
    for (const auth of [undefined, "Bearer", `Bearer ${WRONG}`, `Bearer ${tokenOf(a.snapshot)}`, room.ownerToken, `Basic ${room.ownerToken}`, `Bearer ${room.ownerToken} x`]) {
      const res = await del(room.room.id, auth);
      expect(res.status).toBe(401);
    }
    expect(await listedIds()).toContain(room.room.id);
    expect(a.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("seeded rooms have no owner: nobody can delete the lobby", async () => {
    t = start({ trustProxy: true });
    for (const auth of [undefined, `Bearer ${WRONG}`]) expect((await del("lobby", auth)).status).toBe(401);
    expect(await listedIds()).toEqual(["lobby"]);
  });

  test("a deleted private room: its invite key and owner token stop admitting anyone", async () => {
    t = start({ trustProxy: true });
    const priv = await createRoom("private");
    expect((await del(priv.room.id, `Bearer ${priv.ownerToken}`)).status).toBe(200);
    expect(await upgradeRefused(priv.room.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------

describe("5. GC with an injected clock (ADR 0028 §2, threat model §1.3)", () => {
  const T0 = Date.UTC(2026, 9, 1);
  /** A server whose wall clock is `clock`, sweeping every 15 ms of real time over a fresh store. */
  function gcServer(clock: { ms: number; now: () => number }): RoomStore {
    db = openDatabase(":memory:");
    const store = new RoomStore(db);
    t = start({ trustProxy: true, store, wallNow: clock.now, roomGcIntervalMs: 15 });
    return store;
  }
  const settle = (): Promise<void> => Bun.sleep(80);
  const inStore = (store: RoomStore, id: string): boolean => store.listRooms().some((r) => r.id === id);

  test("the constants are the ADR's: 1 h never joined, 14 days empty", () => {
    expect(ROOM_GC_NEVER_JOINED_MS).toBe(3_600_000);
    expect(ROOM_GC_EMPTY_MS).toBe(14 * 86_400_000);
  });

  test("a created room nobody joined is kept for 1 h, then removed from the list, the store and the join path", async () => {
    const clock = fakeClock(T0);
    const store = gcServer(clock);
    const room = await createRoom("public");
    clock.ms = T0 + ROOM_GC_NEVER_JOINED_MS - 1;
    await settle();
    expect(await listedIds()).toContain(room.room.id);
    clock.ms = T0 + ROOM_GC_NEVER_JOINED_MS;
    await until(async () => !(await listedIds()).includes(room.room.id), "never-joined room is collected");
    expect(inStore(store, room.room.id)).toBe(false);
    expect(await upgradeRefused(room.room.id)).toBe(true);
    expect((await del(room.room.id, `Bearer ${room.ownerToken}`)).status).toBe(404);
  });

  test("a room with a member is never collected, however old; its member stays connected", async () => {
    const clock = fakeClock(T0);
    const store = gcServer(clock);
    const room = await createRoom("private");
    const m = await joined(room.room.id, "alice", { inviteKey: room.inviteKey ?? fail() });
    clock.ms = T0 + 60 * 86_400_000;
    await settle();
    expect(inStore(store, room.room.id)).toBe(true);
    expect(m.client.socket.readyState).toBe(WebSocket.OPEN);
    await sync(m.client);
    // The sweep records that someone is still there.
    expect(store.listRooms().find((r) => r.id === room.room.id)?.lastActiveAt).toBe(clock.ms);
  });

  test("a room with an open, still-unjoined socket is in use too", async () => {
    const clock = fakeClock(T0);
    const store = gcServer(clock);
    const room = await createRoom("public");
    const lurker = await open(room.room.id);
    await sync(lurker);
    clock.ms = T0 + 3 * ROOM_GC_NEVER_JOINED_MS;
    await settle();
    expect(inStore(store, room.room.id)).toBe(true);
    lurker.close();
    await until(() => !inStore(store, room.room.id), "collected once the lurker leaves");
  });

  test("activity resets the idle timer: an empty room goes 14 days after its last member left, not after its creation", async () => {
    const clock = fakeClock(T0);
    const store = gcServer(clock);
    const room = await createRoom("public");
    const m = await joined(room.room.id, "alice");
    clock.ms = T0 + 10 * 86_400_000;
    m.client.close();
    await until(() => store.listRooms().find((r) => r.id === room.room.id)?.lastActiveAt === clock.ms, "leave is recorded");
    const left = clock.ms;
    // 23 days after creation, 13 after the leave: kept. (Not a never-joined room any more.)
    clock.ms = left + ROOM_GC_EMPTY_MS - 1;
    await settle();
    expect(inStore(store, room.room.id)).toBe(true);
    // Someone comes back and leaves later: the timer restarts again.
    const again = await joined(room.room.id, "bob");
    clock.ms += 5 * 86_400_000;
    again.client.close();
    const left2 = clock.ms;
    await until(() => store.listRooms().find((r) => r.id === room.room.id)?.lastActiveAt === left2, "second leave is recorded");
    clock.ms = left2 + ROOM_GC_EMPTY_MS - 1;
    await settle();
    expect(inStore(store, room.room.id)).toBe(true);
    clock.ms = left2 + ROOM_GC_EMPTY_MS;
    await until(() => !inStore(store, room.room.id), "empty room is collected after 14 days");
    expect(await listedIds()).toEqual(["lobby"]);
  });

  test("the seeded lobby is pinned: never collected, however long it sits empty", async () => {
    const clock = fakeClock(T0);
    const store = gcServer(clock);
    const room = await createRoom("public");
    clock.ms = T0 + 400 * 86_400_000;
    await until(() => !inStore(store, room.room.id), "the created room goes");
    await settle();
    expect(inStore(store, "lobby")).toBe(true);
    expect((await joinOutcome("lobby", "visitor")).outcome).toBe("snapshot");
    expect(await listedIds()).toEqual(["lobby"]);
  });

  test("at boot, a stored room past its limit is swept immediately, with a pinned one beside it kept", async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-rooms-"));
    const { store, rooms } = seedStore(join(dir, "omega.db"), 2);
    const stale = rooms[0] ?? fail("no room");
    const fresh = rooms[1] ?? fail("no room");
    store.setLastActive(stale.id, T0 - ROOM_GC_EMPTY_MS - 1000);
    store.setLastActive(fresh.id, T0 - 1000);
    t = start({ trustProxy: true, store, wallNow: () => T0 });
    expect(await listedIds()).toContain("lobby");
    expect(await listedIds()).toContain(fresh.id);
    expect(await listedIds()).not.toContain(stale.id);
    expect(store.listRooms().some((r) => r.id === stale.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------

describe("6. layout-set (ADR 0028 §6, threat model §6.2 S7)", () => {
  async function room() {
    const created = await createRoom("public");
    const owner = await joined(created.room.id, "olive", { ownerToken: created.ownerToken });
    const guest = await joined(created.room.id, "gus");
    return { created, owner, guest };
  }
  const layoutOf = async (id: string): Promise<RoomLayout> => (await joined(id, `peek${String(nextAddress++)}`)).snapshot.room.layout ?? fail("snapshot has no layout");

  test("a non-owner (guest, wrong owner token, an invite-key holder) gets not_owner, and nothing is broadcast or stored", async () => {
    t = start({ trustProxy: true });
    const { created, owner, guest } = await room();
    const wrong = await joined(created.room.id, "wanda", { ownerToken: WRONG });
    for (const c of [guest.client, wrong.client]) {
      c.send({ type: "layout-set", layout: movedLayout() });
      expect((await c.next("error")).code).toBe("not_owner");
    }
    await owner.client.none("layout-changed", 100);
    await guest.client.none("layout-changed", 10);
    expect(layoutsEqual(await layoutOf(created.room.id), DEFAULT_LAYOUT)).toBe(true);
    // An unjoined socket can't either.
    const lurker = await open(created.room.id);
    lurker.send({ type: "layout-set", layout: movedLayout() });
    expect((await lurker.next("error")).code).toBe("not_joined");
    // And the owner who left is no longer one on the same socket.
    owner.client.send({ type: "leave" });
    await sync(owner.client);
    owner.client.send({ type: "layout-set", layout: movedLayout() });
    expect((await owner.client.next("error")).code).toBe("not_joined");
    expect(layoutsEqual(await layoutOf(created.room.id), DEFAULT_LAYOUT)).toBe(true);
  });

  test("the owner's invalid layouts are refused with bad_message and the stored layout is unchanged", async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-rooms-"));
    db = openDatabase(join(dir, "omega.db"));
    const store = new RoomStore(db);
    t = start({ trustProxy: true, store });
    const { created, owner, guest } = await room();
    const furniture = DEFAULT_LAYOUT.furniture;
    const tvAt = (col: number): unknown => ({ kind: "tv", col, row: 0, facing: "se" });
    const bad: [string, unknown][] = [
      ["an unknown kind", { furniture: [...furniture, { kind: "jacuzzi", col: 3, row: 3, facing: "se" }] }],
      ["a cell off the grid", { furniture: [...furniture.slice(1), tvAt(99)] }],
      ["a negative cell", { furniture: [...furniture.slice(1), tvAt(-1)] }],
      ["a fractional cell", { furniture: [...furniture.slice(1), tvAt(1.5)] }],
      ["a piece that runs off the floor", { furniture: [...furniture.slice(1), { kind: "rug", col: 8, row: 8, facing: "se" }] }],
      ["an unknown key on a piece", { furniture: [...furniture, { kind: "plant", col: 5, row: 9, facing: "se", evil: 1 }] }],
      ["an unknown key on the layout", { furniture, extra: true }],
      ["a variant the piece does not have", { furniture: [...furniture.slice(0, -1), { kind: "plant", col: 0, row: 9, facing: "se", variant: 5 }] }],
      ["no tv", { furniture: furniture.slice(1) }],
      ["two tvs", { furniture: [...furniture, tvAt(4)] }],
      ["fewer seats than SEAT_COUNT", { furniture: furniture.filter((f, i) => !(f.kind === "armchair" && i === 2)) }],
      ["overlapping solid pieces", { furniture: [...furniture, { kind: "plant", col: 1, row: 5, facing: "se" }] }],
      ["more pieces than the limit", { furniture: [...furniture, ...Array.from({ length: 30 }, (_, i) => ({ kind: "plant", col: i % 10, row: 9, facing: "se" }))] }],
      ["furniture not an array", { furniture: "tv" }],
      ["a null layout", null],
      ["no layout", undefined],
    ];
    // At most 19 bad frames per socket, then the server closes (4400): split over fresh owner sockets.
    let sock = owner.client;
    let sent = 0;
    for (const [what, layout] of bad) {
      if (sent === 15) {
        sock = (await joined(created.room.id, `olive${String(nextAddress++)}`, { ownerToken: created.ownerToken })).client;
        sent = 0;
      }
      sock.send(layout === undefined ? { type: "layout-set" } : { type: "layout-set", layout });
      const err = await sock.next("error").catch(() => fail(`${what}: no error`));
      expect(err.code, what).toBe("bad_message");
      sent++;
    }
    await guest.client.none("layout-changed", 50);
    expect(layoutsEqual(await layoutOf(created.room.id), DEFAULT_LAYOUT)).toBe(true);
    const stored = store.listRooms().find((r) => r.id === created.room.id) ?? fail("no row");
    expect(layoutsEqual(stored.layout, DEFAULT_LAYOUT)).toBe(true);
  });

  test("a frame over the size cap closes the socket (no layout parse, no write); the stored layout is unchanged", async () => {
    t = start({ trustProxy: true });
    const { created, owner } = await room();
    owner.client.send({ type: "layout-set", layout: { furniture: DEFAULT_LAYOUT.furniture, pad: "x".repeat(8192) } });
    const close = await owner.client.closed;
    // The contract (constants.ts): Bun closes oversize frames, which a client sees as 1006 (or 1009); never an accepted edit.
    expect([1006, 1009, CLOSE_CODES.BAD_MESSAGES]).toContain(close.code);
    expect(layoutsEqual(await layoutOf(created.room.id), DEFAULT_LAYOUT)).toBe(true);
  });

  test("a valid layout from the owner is broadcast as layout-changed to every member (by: the owner), persisted, and seen by later joiners", async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-rooms-"));
    const path = join(dir, "omega.db");
    db = openDatabase(path);
    const store = new RoomStore(db);
    t = start({ trustProxy: true, store });
    const { created, owner, guest } = await room();
    const moved = movedLayout();
    owner.client.send({ type: "layout-set", layout: moved });
    const [toOwner, toGuest] = await Promise.all([owner.client.next("layout-changed"), guest.client.next("layout-changed")]);
    for (const msg of [toOwner, toGuest]) {
      expect(layoutsEqual(msg.layout, moved)).toBe(true);
      expect(msg.by).toBe(owner.snapshot.self);
    }
    expect(layoutsEqual(await layoutOf(created.room.id), moved)).toBe(true);
    const stored = store.listRooms().find((r) => r.id === created.room.id) ?? fail("no row");
    expect(layoutsEqual(stored.layout, moved)).toBe(true);
    // Across a restart too.
    await server().server.stop(true);
    db.close();
    db = openDatabase(path);
    t = start({ trustProxy: true, store: new RoomStore(db) });
    expect(layoutsEqual(await layoutOf(created.room.id), moved)).toBe(true);
  });

  test("owner edits are limited per socket (layout-set and title-set share ROOM_EDIT_BURST); the refill is honoured; refused edits change nothing", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const { created, owner, guest } = await room();
    const layouts = [movedLayout(), movedLayout(), DEFAULT_LAYOUT];
    for (let i = 0; i < ROOM_EDIT_BURST; i++) {
      // Alternate layout and title so the two kinds really share one bucket.
      owner.client.send(i % 2 === 0 ? { type: "layout-set", layout: layouts[i] } : { type: "title-set", title: "Cinema" });
      await guest.client.next(i % 2 === 0 ? "layout-changed" : "title-changed");
    }
    const before = JSON.stringify(await layoutOf(created.room.id));
    owner.client.send({ type: "layout-set", layout: layouts[2] });
    const err = await owner.client.next("error");
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    await guest.client.none("layout-changed", 100);
    expect(JSON.stringify(await layoutOf(created.room.id))).toBe(before);
    clock.ms += ROOM_EDIT_REFILL_MS;
    owner.client.send({ type: "layout-set", layout: layouts[2] });
    expect(layoutsEqual((await guest.client.next("layout-changed")).layout, DEFAULT_LAYOUT)).toBe(true);
  });

  test("a non-owner's layout-set does not draw from the owner's bucket, and a flood of them ends in the 4400 close", async () => {
    t = start({ trustProxy: true });
    const { owner, guest } = await room();
    for (let i = 0; i < 25 && guest.client.socket.readyState === WebSocket.OPEN; i++) {
      guest.client.send({ type: "layout-set", layout: movedLayout() });
      await Promise.race([guest.client.next("error").catch(() => undefined), guest.client.closed]);
    }
    expect((await guest.client.closed).code).toBe(CLOSE_CODES.BAD_MESSAGES);
    owner.client.send({ type: "layout-set", layout: movedLayout() });
    await owner.client.next("layout-changed");
  });
});

// ---------------------------------------------------------------------------------------------------

describe("7. enumeration probes are bounded and answered uniformly (threat model §3.3)", () => {
  const probe = (id: string, address: string): Promise<Response> => fetch(`${server().http}/rooms/${id}/ws`, { headers: { "x-forwarded-for": address } });

  test("WS upgrades to unknown ids cost a token like real upgrades: after the burst from one key, 429 with Retry-After; another key is unaffected", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const address = "203.0.113.40";
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) codes.push((await probe(newRoomId(), address)).status);
    expect(codes[0]).toBe(404);
    const first429 = codes.indexOf(429);
    expect(first429).toBeGreaterThan(0);
    expect(first429).toBeLessThanOrEqual(15);
    expect(codes.slice(first429).every((c) => c === 429)).toBe(true);
    const limited = await probe(newRoomId(), address);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await probe(newRoomId(), "203.0.113.41")).status).toBe(404);
  });

  test("once a key is limited, an unknown id and an existing private room's id get the very same answer (no existence oracle through the limiter)", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const priv = await createRoom("private");
    const address = "203.0.113.42";
    for (let i = 0; i < 20; i++) await probe(newRoomId(), address);
    const [unknown, known] = await Promise.all([probe(newRoomId(), address), probe(priv.room.id, address)]);
    expect(unknown.status).toBe(429);
    expect(known.status).toBe(429);
    expect(await known.text()).toBe(await unknown.text());
    expect(known.headers.get("retry-after")).toBe(unknown.headers.get("retry-after"));
  });

  test("wrong invite keys from one key are limited across rooms and sockets (rate_limited, retryAfterMs), 4400 follows, and the right key still gets through", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const a = await createRoom("private");
    const b = await createRoom("private");
    const address = "203.0.113.43";
    const outcomes: string[] = [];
    for (let i = 0; i < 14; i++) {
      clock.ms += 5000;
      const target = i % 2 === 0 ? a : b;
      const { client, outcome } = await joinOutcome(target.room.id, `m${String(i)}`, { address, inviteKey: WRONG });
      outcomes.push(outcome);
      client.close();
      await client.closed;
    }
    expect(outcomes[0]).toBe("invite_required");
    expect(outcomes).toContain("rate_limited");
    // The limiter never turned a wrong key into an admission, and the right key is still honoured.
    expect(outcomes).not.toContain("snapshot");
    expect((await joinOutcome(a.room.id, "real", { address, inviteKey: a.inviteKey ?? fail() })).outcome).toBe("snapshot");
  });

  test("wrong owner tokens from one key are limited too: the guests join while the bucket lasts, then rate_limited and no snapshot", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const room = await createRoom("public");
    const address = "203.0.113.44";
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) {
      clock.ms += 5000;
      const { client, outcome } = await joinOutcome(room.room.id, `m${String(i)}`, { address, ownerToken: WRONG });
      outcomes.push(outcome);
      client.close();
      await client.closed;
    }
    expect(outcomes[0]).toBe("snapshot");
    expect(outcomes).toContain("rate_limited");
    // The real owner token is unaffected by the failures.
    expect((await joinOutcome(room.room.id, "olive", { address, ownerToken: room.ownerToken })).outcome).toBe("snapshot");
  });

  test("DELETE: an unknown id is 404 (specified: 404, then auth); a wrong bearer on a real room is 401 until the per-key failed-auth bucket empties, then 429 with Retry-After", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const priv = await createRoom("private");
    const address = "203.0.113.45";
    const unknown = await del(newRoomId(), `Bearer ${WRONG}`, address);
    expect(unknown.status).toBe(404);
    const unknownBody = v.parse(DeleteRoomResponseSchema, await unknown.json());
    expect(unknownBody.ok ? "ok" : unknownBody.error.code).toBe("room_not_found");
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) codes.push((await del(priv.room.id, `Bearer ${WRONG}`, address)).status);
    expect(codes[0]).toBe(401);
    expect(codes).toContain(429);
    expect(codes.slice(codes.indexOf(429)).every((c) => c === 429)).toBe(true);
    const limited = await del(priv.room.id, `Bearer ${WRONG}`, address);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const body = v.parse(DeleteRoomResponseSchema, await limited.json());
    expect(body.ok).toBe(false);
    // Another key is untouched; the room survived it all; the right token still works from the limited key.
    expect((await del(priv.room.id, `Bearer ${WRONG}`, "203.0.113.46")).status).toBe(401);
    expect(await joinOutcome(priv.room.id, "olive", { ownerToken: priv.ownerToken }).then((r) => r.outcome)).toBe("snapshot");
    expect((await del(priv.room.id, `Bearer ${priv.ownerToken}`, address)).status).toBe(200);
  });

  test("DELETE probes at unknown ids from one key are bounded by the HTTP gate (429 + Retry-After)", async () => {
    const clock = fakeClock();
    t = start({ trustProxy: true, now: clock.now });
    const address = "203.0.113.47";
    const codes: number[] = [];
    for (let i = 0; i < 200; i++) codes.push((await del(newRoomId(), `Bearer ${WRONG}`, address)).status);
    expect(codes[0]).toBe(404);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c !== 404 && c !== 429)).toEqual([]);
  });

  test("a share probe at an unknown room is 404 and at a private room without a grant is 401, with the same typed shape (existence is not a secret: ids are 128 bits)", async () => {
    t = start({ trustProxy: true });
    const priv = await createRoom("private");
    const unknown = await postShare(server(), YOUTUBE, { roomId: newRoomId(), headers: { "x-forwarded-for": freshAddress() } });
    const known = await postShare(server(), YOUTUBE, { roomId: priv.room.id, headers: { "x-forwarded-for": freshAddress() } });
    expect(unknown.status).toBe(404);
    expect(known.status).toBe(401);
    for (const res of [unknown, known]) expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
