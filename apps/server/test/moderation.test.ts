import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import * as v from "valibot";
import {
  CLOSE_CODES,
  CreateRoomResponseSchema,
  KICK_COOLDOWN_MS,
  MODERATION_BURST,
  MUTE_MEMORY_MS,
  type CreateRoomResponse,
} from "@omega/shared";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** Owner moderation: kick, mute and the control policy (ADR 0030, OME-505). */

const VIDEO = "dQw4w9WgXcQ";
const EMBED_URL = `https://www.youtube.com/embed/${VIDEO}`;
const SHARE_BODY = JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}` });

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

/** Monotonic (limiters) and wall (cooldowns) clocks, moved together. */
function clocks() {
  const c = { mono: 1_000_000, wall: 1_800_000_000_000, now: () => c.mono, wallNow: () => c.wall };
  return c;
}

let nextAddress = 1;
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

type Created = Extract<CreateRoomResponse, { ok: true }>;
async function createRoom(): Promise<Created> {
  const res = await fetch(`${server().http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
    body: JSON.stringify({ title: "Friday films", visibility: "public" }),
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

async function joined(roomId: string, nickname: string, init: { ownerToken?: string; address?: string } = {}) {
  const client = await open(roomId, init.address);
  client.send({ type: "join", nickname, avatar: 0, ...(init.ownerToken === undefined ? {} : { ownerToken: init.ownerToken }) });
  return { client, snapshot: await client.next("snapshot") };
}

/** A created room with its owner and two guests, each from its own address. Everyone has seen everyone join. */
async function roomWithGuests() {
  const room = await createRoom();
  const id = room.room.id;
  const owner = await joined(id, "olive", { ownerToken: room.ownerToken });
  const guestAddress = freshAddress();
  const guest = await joined(id, "mallory", { address: guestAddress });
  await owner.client.next("member-joined");
  const other = await joined(id, "bob");
  await owner.client.next("member-joined");
  await guest.client.next("member-joined");
  return { room, id, owner, guest, guestAddress, other };
}

describe("non-owners: not_owner, and nothing changes (ADR 0030 §1)", () => {
  test("kick from a guest: not_owner, the target stays, nobody hears member-left", async () => {
    t = start({ trustProxy: true });
    const { guest, other, owner } = await roomWithGuests();
    guest.client.send({ type: "kick", memberId: other.snapshot.self });
    expect((await guest.client.next("error")).code).toBe("not_owner");
    await owner.client.none("member-left", 150);
    expect(other.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("mute from a guest: not_owner, no member-muted, and the target can still chat", async () => {
    t = start({ trustProxy: true });
    const { guest, other, owner } = await roomWithGuests();
    guest.client.send({ type: "mute", memberId: other.snapshot.self, muted: true });
    expect((await guest.client.next("error")).code).toBe("not_owner");
    await owner.client.none("member-muted", 150);
    other.client.send({ type: "chat", text: "still here" });
    expect((await owner.client.next("chat")).text).toBe("still here");
  });

  test("control-policy from a guest: not_owner, no control-policy-changed, and guests still control playback", async () => {
    t = start({ trustProxy: true });
    const { guest, owner, id } = await roomWithGuests();
    guest.client.send({ type: "control-policy", policy: "owner" });
    expect((await guest.client.next("error")).code).toBe("not_owner");
    await owner.client.none("control-policy-changed", 150);
    const shared = await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) });
    expect(shared.status).toBe(200);
  });

  test("not_owner on a moderation frame counts toward the 4400 close", async () => {
    const clock = clocks();
    t = start({ trustProxy: true, now: clock.now, wallNow: clock.wallNow });
    const { guest, other } = await roomWithGuests();
    for (let i = 0; i < 40 && guest.client.socket.readyState === WebSocket.OPEN; i++) {
      clock.mono += 1000;
      guest.client.send({ type: "kick", memberId: other.snapshot.self });
      await Promise.race([guest.client.next("error").catch(() => undefined), guest.client.closed]);
    }
    expect((await guest.client.closed).code).toBe(CLOSE_CODES.BAD_MESSAGES);
  });

  test("before join: not_joined", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom();
    const c = await open(room.room.id);
    c.send({ type: "control-policy", policy: "owner" });
    expect((await c.next("error")).code).toBe("not_joined");
  });
});

describe("kick (ADR 0030 §2)", () => {
  test("closes the target with KICKED and no frame first; everyone else gets member-left { reason: kicked }", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, other } = await roomWithGuests();
    const before = guest.client.raw.length;
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    const closed = await guest.client.closed;
    expect(closed.code).toBe(CLOSE_CODES.KICKED);
    expect(guest.client.raw.slice(before)).toEqual([]);
    expect(await other.client.next("member-left")).toEqual({ type: "member-left", memberId: guest.snapshot.self, reason: "kicked" });
    expect(await owner.client.next("member-left")).toEqual({ type: "member-left", memberId: guest.snapshot.self, reason: "kicked" });
  });

  test("the kicked member's share token is revoked", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, id } = await roomWithGuests();
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    await guest.client.closed;
    await owner.client.next("member-left");
    expect((await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) })).status).toBe(401);
  });

  test("a rejoin from the kicked address within KICK_COOLDOWN_MS is closed with KICKED before any snapshot; after it, it joins", async () => {
    const clock = clocks();
    t = start({ trustProxy: true, now: clock.now, wallNow: clock.wallNow });
    const { owner, guest, guestAddress, id } = await roomWithGuests();
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    await guest.client.closed;

    clock.wall += KICK_COOLDOWN_MS - 1000;
    clock.mono += 60_000;
    const back = await open(id, guestAddress);
    back.send({ type: "join", nickname: "mallory2", avatar: 0 });
    expect((await back.closed).code).toBe(CLOSE_CODES.KICKED);
    expect(back.raw.some((f) => f.includes("snapshot"))).toBe(false);
    await owner.client.none("member-joined", 50);

    clock.wall += 2000;
    clock.mono += 60_000;
    const later = await open(id, guestAddress);
    later.send({ type: "join", nickname: "mallory3", avatar: 0 });
    await later.next("snapshot");
  });

  test("the cooldown is per room and per address: other addresses and other rooms let the kicked address in", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, guestAddress, id } = await roomWithGuests();
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    await guest.client.closed;
    await joined(id, "carol");
    const elsewhere = await createRoom();
    await joined(elsewhere.room.id, "mallory", { address: guestAddress });
  });

  test("a join with the owner token from the kicked address isn't refused", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom();
    const id = room.room.id;
    const shared = freshAddress();
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken, address: shared });
    const guest = await joined(id, "mallory", { address: shared });
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    await guest.client.closed;
    const again = await joined(id, "olive2", { ownerToken: room.ownerToken, address: shared });
    expect(again.snapshot.owner).toBe(true);
  });

  test("bad_target for the sender, an unknown id and an owner-joined socket; nobody leaves, and it doesn't count toward 4400", async () => {
    const clock = clocks();
    t = start({ trustProxy: true, now: clock.now, wallNow: clock.wallNow });
    const { room, owner, id } = await roomWithGuests();
    const second = await joined(id, "olive-tab", { ownerToken: room.ownerToken });
    for (const memberId of [owner.snapshot.self, "no-such-member", second.snapshot.self]) {
      clock.mono += 1000;
      owner.client.send({ type: "kick", memberId });
      expect((await owner.client.next("error")).code).toBe("bad_target");
    }
    for (let i = 0; i < 25; i++) {
      clock.mono += 1000;
      owner.client.send({ type: "kick", memberId: "no-such-member" });
      expect((await owner.client.next("error")).code).toBe("bad_target");
    }
    expect(owner.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(second.client.socket.readyState).toBe(WebSocket.OPEN);
    await owner.client.none("member-left", 50);
  });
});

describe("the moderation bucket (ADR 0030 §1)", () => {
  test("MODERATION_BURST frames at once, then rate_limited with retryAfterMs; a second later one more passes", async () => {
    const clock = clocks();
    t = start({ trustProxy: true, now: clock.now, wallNow: clock.wallNow });
    const { owner } = await roomWithGuests();
    const policies = ["owner", "everyone"] as const;
    for (let i = 0; i < MODERATION_BURST; i++) {
      owner.client.send({ type: "control-policy", policy: policies[i % 2] });
      await owner.client.next("control-policy-changed");
    }
    owner.client.send({ type: "control-policy", policy: policies[MODERATION_BURST % 2] });
    const limited = await owner.client.next("error");
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    clock.mono += 1000;
    owner.client.send({ type: "control-policy", policy: policies[MODERATION_BURST % 2] });
    await owner.client.next("control-policy-changed");
  });
});

describe("mute (ADR 0030 §3)", () => {
  test("everyone gets member-muted; the muted member's chat is answered `muted` and nobody else sees it; unmute lets it through", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, other } = await roomWithGuests();
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: true });
    const expected = { type: "member-muted", memberId: guest.snapshot.self, muted: true } as const;
    expect(await other.client.next("member-muted")).toEqual(expected);
    expect(await guest.client.next("member-muted")).toEqual(expected);
    expect(await owner.client.next("member-muted")).toEqual(expected);

    guest.client.send({ type: "chat", text: "spam" });
    expect((await guest.client.next("error")).code).toBe("muted");
    await other.client.none("chat", 100);
    await owner.client.none("chat", 0);
    expect(guest.client.socket.readyState).toBe(WebSocket.OPEN);

    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: false });
    expect((await other.client.next("member-muted")).muted).toBe(false);
    guest.client.send({ type: "chat", text: "sorry" });
    expect((await other.client.next("chat")).text).toBe("sorry");
  });

  test("a late joiner's snapshot shows the member muted; others carry no muted field", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, id } = await roomWithGuests();
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: true });
    await owner.client.next("member-muted");
    const late = await joined(id, "carol");
    const raw = late.client.raw.find((f) => f.includes('"snapshot"')) ?? "";
    const members = (JSON.parse(raw) as { room: { members: { id: string; muted?: boolean }[] } }).room.members;
    expect(members.find((m) => m.id === guest.snapshot.self)?.muted).toBe(true);
    expect(members.filter((m) => m.id !== guest.snapshot.self).every((m) => m.muted === undefined)).toBe(true);
  });

  test("muting a muted member, or unmuting an unmuted one, broadcasts nothing", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, other } = await roomWithGuests();
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: false });
    await other.client.none("member-muted", 100);
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: true });
    await other.client.next("member-muted");
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: true });
    await other.client.none("member-muted", 100);
  });

  test("bad_target for the sender and an owner-joined socket", async () => {
    t = start({ trustProxy: true });
    const { room, owner, id } = await roomWithGuests();
    const second = await joined(id, "olive-tab", { ownerToken: room.ownerToken });
    owner.client.send({ type: "mute", memberId: owner.snapshot.self, muted: true });
    expect((await owner.client.next("error")).code).toBe("bad_target");
    owner.client.send({ type: "mute", memberId: second.snapshot.self, muted: true });
    expect((await owner.client.next("error")).code).toBe("bad_target");
  });

  test("a muted member who leaves and rejoins from the same address within MUTE_MEMORY_MS comes back muted; after it, or once unmuted, not", async () => {
    const clock = clocks();
    t = start({ trustProxy: true, now: clock.now, wallNow: clock.wallNow });
    const { owner, guest, guestAddress, id, other } = await roomWithGuests();
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: true });
    await other.client.next("member-muted");
    guest.client.close();
    await other.client.next("member-left");

    clock.wall += MUTE_MEMORY_MS - 1000;
    clock.mono += 60_000;
    const back = await joined(id, "mallory2", { address: guestAddress });
    const joinedMsg = await other.client.next("member-joined");
    expect(joinedMsg.member.muted).toBe(true);
    back.client.send({ type: "chat", text: "spam" });
    expect((await back.client.next("error")).code).toBe("muted");

    // Unmuting forgets the address too.
    clock.mono += 1000;
    owner.client.send({ type: "mute", memberId: back.snapshot.self, muted: false });
    await other.client.next("member-muted");
    back.client.close();
    await other.client.next("member-left");
    clock.mono += 60_000;
    await joined(id, "mallory3", { address: guestAddress });
    expect((await other.client.next("member-joined")).member.muted).toBeUndefined();
  });

  test("the mute memory expires after MUTE_MEMORY_MS", async () => {
    const clock = clocks();
    t = start({ trustProxy: true, now: clock.now, wallNow: clock.wallNow });
    const { owner, guest, guestAddress, id, other } = await roomWithGuests();
    owner.client.send({ type: "mute", memberId: guest.snapshot.self, muted: true });
    await other.client.next("member-muted");
    guest.client.close();
    await other.client.next("member-left");
    clock.wall += MUTE_MEMORY_MS + 1000;
    clock.mono += 60_000;
    await joined(id, "mallory2", { address: guestAddress });
    expect((await other.client.next("member-joined")).member.muted).toBeUndefined();
  });
});

describe("control policy (ADR 0030 §4)", () => {
  test("a new room's snapshot says everyone", async () => {
    t = start({ trustProxy: true });
    const { owner } = await roomWithGuests();
    expect(owner.snapshot.room.controlPolicy).toBe("everyone");
  });

  test("owner: everyone hears control-policy-changed; a guest's control gets control_owner_only and changes nothing; the owner's still goes through", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, other, id } = await roomWithGuests();
    expect((await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(owner.snapshot) })).status).toBe(200);
    await other.client.next("embed-changed");

    owner.client.send({ type: "control-policy", policy: "owner" });
    const expected = { type: "control-policy-changed", policy: "owner", by: owner.snapshot.self } as const;
    expect(await other.client.next("control-policy-changed")).toEqual(expected);
    expect(await guest.client.next("control-policy-changed")).toEqual(expected);

    guest.client.send({ type: "control", url: EMBED_URL, playing: true, position: 30 });
    expect((await guest.client.next("error")).code).toBe("control_owner_only");
    await other.client.none("playback", 100);

    owner.client.send({ type: "control", url: EMBED_URL, playing: true, position: 30 });
    expect((await other.client.next("playback")).playback.playing).toBe(true);
  });

  test("owner: a guest's share gets 403 control_owner_only; the owner's share works; back to everyone and the guest shares again", async () => {
    t = start({ trustProxy: true });
    const { owner, guest, other, id } = await roomWithGuests();
    owner.client.send({ type: "control-policy", policy: "owner" });
    await other.client.next("control-policy-changed");

    const refused = await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ ok: false, error: { code: "control_owner_only", message: expect.any(String) as unknown as string } });
    await other.client.none("embed-changed", 100);

    expect((await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(owner.snapshot) })).status).toBe(200);
    await other.client.next("embed-changed");

    owner.client.send({ type: "control-policy", policy: "everyone" });
    await other.client.next("control-policy-changed");
    expect((await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) })).status).toBe(200);
  });

  test("a late joiner's snapshot carries the policy; setting the current policy broadcasts nothing", async () => {
    t = start({ trustProxy: true });
    const { owner, other, id } = await roomWithGuests();
    owner.client.send({ type: "control-policy", policy: "everyone" });
    await other.client.none("control-policy-changed", 100);
    owner.client.send({ type: "control-policy", policy: "owner" });
    await other.client.next("control-policy-changed");
    const late = await joined(id, "carol");
    expect(late.snapshot.room.controlPolicy).toBe("owner");
  });
});

describe("persistence: the policy is stored with the room, moderation never touches the store (ADR 0030 §2, §4)", () => {
  const dbFile = (): string => {
    dir ??= mkdtempSync(joinPath(tmpdir(), "omega-moderation-"));
    return joinPath(dir, "omega.db");
  };

  test("the policy survives a restart", async () => {
    db = openDatabase(dbFile());
    t = start({ trustProxy: true, store: new RoomStore(db) });
    const { owner, other, id } = await roomWithGuests();
    owner.client.send({ type: "control-policy", policy: "owner" });
    await other.client.next("control-policy-changed");
    for (const c of clients.splice(0)) c.close();
    await t.server.stop(true);
    db.close();

    db = openDatabase(dbFile());
    t = start({ trustProxy: true, store: new RoomStore(db) });
    const back = await joined(id, "carol");
    expect(back.snapshot.room.controlPolicy).toBe("owner");
  });

  test("kick, mute, the cooldown and the mute memory write nothing: no store call, and no address or nickname in the DB file", async () => {
    db = openDatabase(dbFile());
    const real = new RoomStore(db);
    const calls: string[] = [];
    let watching = false;
    const spy = new Proxy(real, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (watching) calls.push(String(prop));
          const out: unknown = Reflect.apply(value, target, args);
          return out;
        };
      },
    });
    t = start({ trustProxy: true, store: spy });
    const { owner, guest, guestAddress, other, id } = await roomWithGuests();
    watching = true;
    owner.client.send({ type: "mute", memberId: other.snapshot.self, muted: true });
    await guest.client.next("member-muted");
    other.client.send({ type: "chat", text: "spam" });
    await other.client.next("error");
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    await guest.client.closed;
    await owner.client.next("member-left");
    const back = await open(id, guestAddress);
    back.send({ type: "join", nickname: "mallory2", avatar: 0 });
    await back.closed;
    other.client.close();
    await owner.client.next("member-left");
    expect(calls).toEqual([]);

    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = await Bun.file(dbFile()).text();
    for (const secret of [guestAddress, "mallory", "bob"]) expect(bytes.includes(secret)).toBe(false);
  });
});
