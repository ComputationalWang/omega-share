import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";
import {
  CLOSE_CODES,
  CreateRoomResponseSchema,
  EMOTE_BURST,
  MAX_ROOM_MEMBERS,
  RESUME_GRACE_MS,
  type CreateRoomResponse,
  type ServerMessage,
} from "@omega/shared";
import { Room } from "../src/room";
import { RoomRegistry } from "../src/rooms";
import { MAX_MEMBERS_PER_CLIENT } from "../src/room";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** Durable room sessions: grace holds, resume tokens, presence and standing slots (ADR 0043, OME-998). */

const SHARE_BODY = JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

function fail(): never {
  throw new Error("no server");
}
const server = (): TestServer => t ?? fail();

/**
 * Monotonic and wall clocks moved together, and a scheduler that runs a task only when `advance`
 * passes its deadline: no test sleeps through a grace window.
 */
function fakeTime() {
  interface Task {
    at: number;
    fn: () => void;
    live: boolean;
  }
  const tasks: Task[] = [];
  const c = {
    mono: 1_000_000,
    wall: 1_800_000_000_000,
    now: () => c.mono,
    wallNow: () => c.wall,
    schedule: (fn: () => void, ms: number) => {
      const task: Task = { at: c.mono + ms, fn, live: true };
      tasks.push(task);
      return () => {
        task.live = false;
      };
    },
    /** Tasks scheduled and neither run nor cancelled. */
    pending: () => tasks.filter((task) => task.live).length,
    advance(ms: number) {
      c.mono += ms;
      c.wall += ms;
      for (const task of tasks.filter((x) => x.live && x.at <= c.mono).sort((a, b) => a.at - b.at)) {
        task.live = false;
        task.fn();
      }
    },
  };
  return c;
}
type FakeTime = ReturnType<typeof fakeTime>;

let nextAddress = 1;
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

function boot(time: FakeTime = fakeTime(), extra: Parameters<typeof start>[0] = {}): FakeTime {
  t = start({ trustProxy: true, now: time.now, wallNow: time.wallNow, schedule: time.schedule, ...extra });
  return time;
}

type Created = Extract<CreateRoomResponse, { ok: true }>;
async function createRoom(visibility: "public" | "private" = "public"): Promise<Created> {
  const res = await fetch(`${server().http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
    body: JSON.stringify({ title: "Movie night", visibility }),
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
  durable?: boolean;
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
    ...(init.durable === false ? {} : { durableSession: true }),
    ...(init.ownerToken === undefined ? {} : { ownerToken: init.ownerToken }),
    ...(init.inviteKey === undefined ? {} : { inviteKey: init.inviteKey }),
  });
  return { client, snapshot: await client.next("snapshot") };
}

function resumeTokenOf(snapshot: Extract<ServerMessage, { type: "snapshot" }>): string {
  if (snapshot.resumeToken === undefined) throw new Error("snapshot has no resumeToken");
  return snapshot.resumeToken;
}

async function resume(roomId: string, token: string, address?: string, nickname = "ignored") {
  const client = await open(roomId, address);
  client.send({ type: "join", nickname, avatar: 3, resumeToken: token });
  return client;
}

/** Closes `client` and waits until `peer` hears that its member went away. */
async function dropAndHold(client: Client, peer: Client, memberId: string) {
  client.close();
  const presence = await peer.next("member-presence");
  expect(presence).toEqual({ type: "member-presence", memberId, away: true });
}

/** A public room with a durable guest and a watcher who sees everything. */
async function roomWithGuest(time: FakeTime) {
  void time;
  const room = await createRoom();
  const id = room.room.id;
  const watcher = await joined(id, "watcher", { durable: false });
  const guestAddress = freshAddress();
  const guest = await joined(id, "alice", { address: guestAddress });
  await watcher.client.next("member-joined");
  return { room, id, watcher, guest, guestAddress, self: guest.snapshot.self, token: resumeTokenOf(guest.snapshot) };
}

describe("opt-in and the resume token", () => {
  test("a durable join gets a 43-char base64url resume token in its own snapshot only", async () => {
    const time = boot();
    const { watcher, guest, token } = await roomWithGuest(time);
    expect(token).toMatch(TOKEN);
    expect(guest.snapshot.resumed).toBeUndefined();
    for (const frame of watcher.client.raw) expect(frame).not.toContain(token);
  });

  test("a legacy join has no resume token and departs at once on close", async () => {
    boot();
    const room = await createRoom();
    const watcher = await joined(room.room.id, "watcher", { durable: false });
    const legacy = await joined(room.room.id, "bob", { durable: false });
    expect(legacy.snapshot.resumeToken).toBeUndefined();
    await watcher.client.next("member-joined");
    legacy.client.close();
    expect((await watcher.client.next("member-left")).memberId).toBe(legacy.snapshot.self);
    await watcher.client.none("member-presence", 100);
  });

  test("two durable members get different tokens", async () => {
    boot();
    const room = await createRoom();
    const a = await joined(room.room.id, "alice");
    const b = await joined(room.room.id, "bob");
    expect(resumeTokenOf(a.snapshot)).not.toBe(resumeTokenOf(b.snapshot));
  });
});

describe("grace hold", () => {
  test("an unexpected close (even 1000) keeps the member: away, in snapshots, nickname reserved", async () => {
    const time = boot();
    const { id, watcher, guest, self } = await roomWithGuest(time);
    await dropAndHold(guest.client, watcher.client, self);
    await watcher.client.none("member-left", 100);
    const late = await joined(id, "carol");
    const held = late.snapshot.room.members.find((m) => m.id === self);
    expect(held?.away).toBe(true);
    expect(held?.nickname).toBe("alice");
    const clash = await open(id);
    clash.send({ type: "join", nickname: "alice", avatar: 0 });
    expect((await clash.next("error")).code).toBe("nickname_taken");
  });

  test("a held member counts against room capacity", async () => {
    const time = boot();
    const room = await createRoom();
    const id = room.room.id;
    const watcher = await joined(id, "watcher", { durable: false, address: "127.0.0.1" });
    const held = await joined(id, "held");
    await watcher.client.next("member-joined");
    await dropAndHold(held.client, watcher.client, held.snapshot.self);
    for (let i = 2; i < MAX_ROOM_MEMBERS; i++) await joined(id, `m${String(i)}`, { durable: false });
    time.advance(RESUME_GRACE_MS - 1);
    const over = await open(id);
    over.send({ type: "join", nickname: "over", avatar: 0 });
    await over.next("room-full");
    expect((await over.closed).code).toBe(CLOSE_CODES.ROOM_FULL);
  });

  test("closing clears the held member's catching flag", async () => {
    const time = boot(fakeTime(), { statusIntervalMs: 0 });
    const { id, watcher, guest, self } = await roomWithGuest(time);
    const shared = await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) });
    expect(shared.status).toBe(200);
    guest.client.send({ type: "status", catching: true });
    expect(await watcher.client.next("member-status")).toEqual({ type: "member-status", memberId: self, catching: true });
    guest.client.close();
    expect(await watcher.client.next("member-status")).toEqual({ type: "member-status", memberId: self, catching: false });
    const late = await joined(id, "carol");
    expect(late.snapshot.room.members.find((m) => m.id === self)?.catching).toBeUndefined();
  });
});

describe("expiry", () => {
  test("just before the deadline the member resumes: same id, tokens and seat, no leave or join", async () => {
    const time = boot();
    const { id, watcher, guest, self, token, guestAddress } = await roomWithGuest(time);
    guest.client.send({ type: "sit", seat: 2 });
    await watcher.client.next("seat-changed");
    await dropAndHold(guest.client, watcher.client, self);
    time.advance(RESUME_GRACE_MS - 1);
    const back = await resume(id, token, guestAddress);
    const snap = await back.next("snapshot");
    expect(snap.self).toBe(self);
    expect(snap.resumed).toBe(true);
    expect(snap.resumeToken).toBe(token);
    expect(snap.shareToken).toBe(tokenOf(guest.snapshot));
    expect(snap.room.seats[2]).toBe(self);
    const me = snap.room.members.find((m) => m.id === self);
    expect(me?.nickname).toBe("alice");
    expect(me?.avatar).toBe(0);
    expect(me?.away).toBeUndefined();
    expect(await watcher.client.next("member-presence")).toEqual({ type: "member-presence", memberId: self, away: false });
    await watcher.client.none("member-left", 50);
    await watcher.client.none("member-joined", 50);
  });

  test("at the deadline: exactly one member-left, the token fails and the name and seat are free", async () => {
    const time = boot();
    const { id, watcher, guest, self, token } = await roomWithGuest(time);
    guest.client.send({ type: "sit", seat: 1 });
    await watcher.client.next("seat-changed");
    await dropAndHold(guest.client, watcher.client, self);
    time.advance(RESUME_GRACE_MS);
    expect(await watcher.client.next("member-left")).toEqual({ type: "member-left", memberId: self, reason: "left" });
    time.advance(RESUME_GRACE_MS);
    await watcher.client.none("member-left", 100);
    const back = await resume(id, token);
    expect((await back.next("error")).code).toBe("resume_expired");
    back.send({ type: "chat", text: "hi" });
    expect((await back.next("error")).code).toBe("not_joined");
    const again = await joined(id, "alice", { durable: false });
    expect(again.snapshot.room.seats[1]).toBeNull();
    expect(time.pending()).toBe(0);
  });

  test("an explicit leave revokes at once: member-left now, token dead", async () => {
    const time = boot();
    const { id, watcher, guest, self, token } = await roomWithGuest(time);
    guest.client.send({ type: "leave" });
    expect((await watcher.client.next("member-left")).memberId).toBe(self);
    guest.client.close();
    await watcher.client.none("member-presence", 100);
    const back = await resume(id, token);
    expect((await back.next("error")).code).toBe("resume_expired");
    expect(time.pending()).toBe(0);
  });
});

describe("resume", () => {
  test("unknown, wrong-room and revoked tokens all get the same resume_expired, never a fresh member", async () => {
    const time = boot();
    const { id, watcher, token } = await roomWithGuest(time);
    const other = await createRoom();
    const answers: unknown[] = [];
    for (const [roomId, candidate] of [
      [id, "A".repeat(43)],
      [other.room.id, token],
    ] as const) {
      const c = await resume(roomId, candidate);
      answers.push(await c.next("error"));
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ type: "error", code: "resume_expired" });
    await watcher.client.none("member-joined", 100);
  });

  test("a private room's member resumes without its invite key", async () => {
    const time = boot();
    void time;
    const room = await createRoom("private");
    const inviteKey = room.inviteKey ?? fail();
    const id = room.room.id;
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken, durable: false });
    const guest = await joined(id, "alice", { inviteKey });
    await owner.client.next("member-joined");
    await dropAndHold(guest.client, owner.client, guest.snapshot.self);
    const back = await resume(id, resumeTokenOf(guest.snapshot));
    expect((await back.next("snapshot")).self).toBe(guest.snapshot.self);
  });

  test("the owner's status comes back from the held identity, not the join frame", async () => {
    const time = boot();
    void time;
    const room = await createRoom();
    const id = room.room.id;
    const watcher = await joined(id, "watcher", { durable: false });
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken });
    expect(owner.snapshot.owner).toBe(true);
    await watcher.client.next("member-joined");
    await dropAndHold(owner.client, watcher.client, owner.snapshot.self);
    const back = await resume(id, resumeTokenOf(owner.snapshot));
    expect((await back.next("snapshot")).owner).toBe(true);
    back.send({ type: "kick", memberId: watcher.snapshot.self });
    expect((await watcher.client.closed).code).toBe(CLOSE_CODES.KICKED);
  });

  test("a resume while the old socket is open replaces it with 4007, and the stale close changes nothing", async () => {
    const time = boot();
    const { id, watcher, guest, self, token } = await roomWithGuest(time);
    const back = await resume(id, token);
    expect((await back.next("snapshot")).resumed).toBe(true);
    expect((await guest.client.closed).code).toBe(CLOSE_CODES.SESSION_REPLACED);
    await watcher.client.none("member-presence", 100);
    await watcher.client.none("member-left", 1);
    time.advance(RESUME_GRACE_MS * 2);
    await watcher.client.none("member-left", 50);
    back.send({ type: "chat", text: "still me" });
    const chat = await watcher.client.next("chat");
    expect(chat.memberId).toBe(self);
    expect(time.pending()).toBe(0);
  });

  test("simultaneous resumes: one ends up live, the other is replaced, nobody leaves", async () => {
    const time = boot();
    const { id, watcher, guest, self, token } = await roomWithGuest(time);
    await dropAndHold(guest.client, watcher.client, self);
    const a = await open(id);
    const b = await open(id);
    a.send({ type: "join", nickname: "x", avatar: 0, resumeToken: token });
    b.send({ type: "join", nickname: "y", avatar: 0, resumeToken: token });
    const [sa, sb] = await Promise.all([a.next("snapshot"), b.next("snapshot")]);
    expect(sa.self).toBe(self);
    expect(sb.self).toBe(self);
    const closes = await Promise.race([
      a.closed.then((e) => ["a", e.code] as const),
      b.closed.then((e) => ["b", e.code] as const),
    ]);
    expect(closes[1]).toBe(CLOSE_CODES.SESSION_REPLACED);
    const live = closes[0] === "a" ? b : a;
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
    await watcher.client.none("member-left", 100);
    const late = await joined(id, "carol");
    expect(late.snapshot.room.members.filter((m) => m.id === self)).toHaveLength(1);
  });

  test("a resume from a different address moves the quota slot, refusing and keeping the hold if the new one is full", async () => {
    const time = boot();
    const { id, watcher, guest, self, token, guestAddress } = await roomWithGuest(time);
    await dropAndHold(guest.client, watcher.client, self);
    const fullAddress = freshAddress();
    for (let i = 0; i < MAX_MEMBERS_PER_CLIENT; i++) await joined(id, `f${String(i)}`, { durable: false, address: fullAddress });
    const refused = await resume(id, token, fullAddress);
    expect((await refused.next("error")).code).toBe("too_many_members");
    await watcher.client.none("member-left", 50);
    // The original address still counts the held member: four more fill it.
    for (let i = 0; i < MAX_MEMBERS_PER_CLIENT - 1; i++) await joined(id, `g${String(i)}`, { durable: false, address: guestAddress });
    const fifth = await open(id, guestAddress);
    fifth.send({ type: "join", nickname: "gx", avatar: 0 });
    expect((await fifth.next("error")).code).toBe("too_many_members");
    // Moving to a free address releases the original one's slot.
    const moved = await resume(id, token, freshAddress());
    expect((await moved.next("snapshot")).self).toBe(self);
    const sixth = await open(id, guestAddress);
    sixth.send({ type: "join", nickname: "gy", avatar: 0 });
    expect((await sixth.next("snapshot")).room.members.some((m) => m.nickname === "gy")).toBe(true);
  });

  test("rate buckets carry over: a resume doesn't refill emotes", async () => {
    const time = boot();
    const { id, watcher, guest, self, token } = await roomWithGuest(time);
    for (let i = 0; i < EMOTE_BURST; i++) guest.client.send({ type: "emote", kind: "wave" });
    for (let i = 0; i < EMOTE_BURST; i++) await watcher.client.next("emoted");
    await dropAndHold(guest.client, watcher.client, self);
    const back = await resume(id, token);
    await back.next("snapshot");
    back.send({ type: "emote", kind: "wave" });
    expect((await back.next("error")).code).toBe("rate_limited");
  });
});

describe("revocation", () => {
  test("the owner kicks a held member: member-left kicked, then resume_expired and share 401", async () => {
    const time = boot();
    const room = await createRoom();
    const id = room.room.id;
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken, durable: false });
    const guest = await joined(id, "alice");
    await owner.client.next("member-joined");
    await dropAndHold(guest.client, owner.client, guest.snapshot.self);
    owner.client.send({ type: "kick", memberId: guest.snapshot.self });
    expect(await owner.client.next("member-left")).toEqual({ type: "member-left", memberId: guest.snapshot.self, reason: "kicked" });
    const back = await resume(id, resumeTokenOf(guest.snapshot));
    expect((await back.next("error")).code).toBe("resume_expired");
    const shared = await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) });
    expect(shared.status).toBe(401);
    expect(time.pending()).toBe(0);
  });

  test("deleting the room revokes its holds", async () => {
    const time = boot();
    const { room, id, watcher, guest, self } = await roomWithGuest(time);
    await dropAndHold(guest.client, watcher.client, self);
    const res = await fetch(`${server().http}/rooms/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${room.ownerToken}` } });
    expect(res.status).toBe(200);
    expect(time.pending()).toBe(0);
  });

  test("a held member's share grant works until the deadline, isn't renewed by a share, then 401", async () => {
    const time = boot();
    const { id, watcher, guest, self } = await roomWithGuest(time);
    await dropAndHold(guest.client, watcher.client, self);
    time.advance(RESUME_GRACE_MS / 2);
    const during = await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) });
    expect(during.status).toBe(200);
    time.advance(RESUME_GRACE_MS / 2);
    expect((await watcher.client.next("member-left")).memberId).toBe(self);
    const after = await postShare(server(), SHARE_BODY, { roomId: id, token: tokenOf(guest.snapshot) });
    expect(after.status).toBe(401);
  });
});

describe("standing slots", () => {
  test("every member gets a unique slot, kept through sitting, away and resume, freed at departure", async () => {
    const time = boot();
    const room = await createRoom();
    const id = room.room.id;
    const a = await joined(id, "alice", { durable: false });
    const b = await joined(id, "bob");
    const joinedB = await a.client.next("member-joined");
    const slotA = a.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.standingSlot;
    const slotB = joinedB.member.standingSlot;
    expect(slotA).toBe(0);
    expect(slotB).toBe(1);
    b.client.send({ type: "sit", seat: 0 });
    await a.client.next("seat-changed");
    await dropAndHold(b.client, a.client, b.snapshot.self);
    const back = await resume(id, resumeTokenOf(b.snapshot));
    expect((await back.next("snapshot")).room.members.find((m) => m.id === b.snapshot.self)?.standingSlot).toBe(1);
    back.send({ type: "leave" });
    await a.client.next("member-left");
    const c = await joined(id, "carol");
    expect(c.snapshot.room.members.find((m) => m.id === c.snapshot.self)?.standingSlot).toBe(1);
    void time;
  });
});

describe("presence hint", () => {
  test("published on transitions only, and a hidden connected member is never expired", async () => {
    const time = boot();
    const { watcher, guest, self } = await roomWithGuest(time);
    guest.client.send({ type: "presence", away: true });
    expect(await watcher.client.next("member-presence")).toEqual({ type: "member-presence", memberId: self, away: true });
    guest.client.send({ type: "presence", away: true });
    await watcher.client.none("member-presence", 100);
    time.advance(RESUME_GRACE_MS * 2);
    await watcher.client.none("member-left", 50);
    guest.client.send({ type: "presence", away: false });
    expect(await watcher.client.next("member-presence")).toEqual({ type: "member-presence", memberId: self, away: false });
    expect(time.pending()).toBe(0);
  });

  test("before join: not_joined", async () => {
    boot();
    const room = await createRoom();
    const c = await open(room.room.id);
    c.send({ type: "presence", away: true });
    expect((await c.next("error")).code).toBe("not_joined");
  });
});

describe("room GC", () => {
  test("a held member keeps the room occupied; the empty clock starts when the hold ends", async () => {
    const time = fakeTime();
    const registry = new RoomRegistry();
    const room = new Room("gcroom", { pinned: false });
    registry.addRoom(room);
    boot(time, { registry, rooms: [] });
    const watcherless = await joined("gcroom", "alice");
    const before = room.lastActiveAt;
    watcherless.client.close();
    await Bun.sleep(50);
    expect(room.memberCount).toBe(1);
    expect(room.lastActiveAt).toBe(before);
    time.advance(RESUME_GRACE_MS);
    expect(room.memberCount).toBe(0);
    expect(room.lastActiveAt).toBe(time.wall);
  });
});

describe("secrecy", () => {
  test("the resume token is in no broadcast frame and no log line", async () => {
    const lines: string[] = [];
    const spies = (["error", "warn", "log", "info"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
    );
    try {
      const time = boot();
      const { id, watcher, guest, self, token } = await roomWithGuest(time);
      await dropAndHold(guest.client, watcher.client, self);
      const back = await resume(id, token);
      await back.next("snapshot");
      back.send({ type: "presence", away: true });
      await watcher.client.next("member-presence");
      back.send({ type: "leave" });
      await watcher.client.next("member-left");
      const stale = await resume(id, token);
      await stale.next("error");
      for (const frame of [...watcher.client.raw, ...stale.raw]) expect(frame).not.toContain(token);
      for (const line of lines) expect(line).not.toContain(token);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
