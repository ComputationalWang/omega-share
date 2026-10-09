import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import * as v from "valibot";
import {
  CreateRoomResponseSchema,
  QUEUE_ADD_MEMBER_BURST,
  QUEUE_ADD_MEMBER_REFILL_MS,
  QUEUE_ADD_ROOM_BURST,
  QUEUE_ADD_ROOM_REFILL_MS,
  QUEUE_ENDED_DEBOUNCE_MS,
  QUEUE_MAX,
  QueueAddResponseSchema,
  type CreateRoomResponse,
  type QueueItem,
} from "@omega/shared";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** The playback queue: add, remove, advance on the first valid `ended`, persisted (ADR 0031, OME-506). */

/** An 11-character YouTube id per `i`, so every queued URL is distinct. */
const vid = (i: number): string => `video${String(i).padStart(6, "0")}`;
const watch = (i: number): string => `https://www.youtube.com/watch?v=${vid(i)}`;
const embedUrl = (i: number): string => `https://www.youtube.com/embed/${vid(i)}`;
const SHARED = 999;
const SHARE_BODY = JSON.stringify({ url: watch(SHARED) });
const LIVE_BODY = JSON.stringify({ url: "https://www.twitch.tv/somechannel" });
const GENERIC_URL = "https://videos.example-host.net/embed/abc";

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
const dbFile = (): string => {
  dir ??= mkdtempSync(joinPath(tmpdir(), "omega-queue-"));
  return joinPath(dir, "omega.db");
};

/** The limiters' monotonic clock: tests move it instead of sleeping through refills and the debounce. */
function clock() {
  const c = { ms: 1_000_000, now: () => c.ms };
  return c;
}

let nextAddress = 1;
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

async function joined(roomId = "lobby", nickname = `m${String(clients.length)}`, init: { ownerToken?: string; address?: string } = {}) {
  const headers = init.address === undefined ? undefined : { "x-forwarded-for": init.address };
  const client = await Client.open(server().ws(roomId), undefined, headers);
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...(init.ownerToken === undefined ? {} : { ownerToken: init.ownerToken }) });
  return { client, snapshot: await client.next("snapshot") };
}

type Created = Extract<CreateRoomResponse, { ok: true }>;
async function createRoom(): Promise<Created> {
  const res = await fetch(`${server().http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
    body: JSON.stringify({ title: "Queue night", visibility: "public" }),
  });
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (!body.ok) throw new Error(`create failed: ${body.error.code}`);
  return body;
}

const add = (c: Client, url: string): void => {
  c.send({ type: "queue-add", url });
};

/** Adds `url` and waits for the room's `queue-changed`: the queue after it. */
async function added(c: Client, url: string): Promise<QueueItem[]> {
  add(c, url);
  return (await c.next("queue-changed")).queue;
}

/** Shares `body` as `member` and returns the new current item's id, as everyone sees it. */
async function share(member: { client: Client; snapshot: Parameters<typeof tokenOf>[0] }, body = SHARE_BODY, roomId = "lobby"): Promise<string> {
  const res = await postShare(server(), body, { roomId, token: tokenOf(member.snapshot) });
  expect(res.status).toBe(200);
  const changed = await member.client.next("embed-changed");
  if (changed.itemId === undefined) throw new Error("embed-changed without itemId");
  return changed.itemId;
}

function postQueue(body: string, init: { roomId?: string; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== undefined) headers["authorization"] = `Bearer ${init.token}`;
  return fetch(`${server().http}/rooms/${init.roomId ?? "lobby"}/queue`, { method: "POST", headers, body });
}

describe("queue-add (ADR 0031 §2, §3)", () => {
  test("stores only the parsed embed, tells the whole room the whole list, and a joiner's snapshot carries it", async () => {
    t = start();
    const alice = await joined();
    const bob = await joined();
    await alice.client.next("member-joined");
    expect(alice.snapshot.room.queue ?? []).toEqual([]);
    await share(alice);

    add(alice.client, watch(1));
    const changed = await bob.client.next("queue-changed");
    expect(changed.by).toBe(alice.snapshot.self);
    expect(changed.queue).toHaveLength(1);
    const item = changed.queue[0];
    expect(item?.embed).toEqual({ provider: "youtube", videoId: vid(1), url: embedUrl(1) });
    expect(item?.by).toBe(alice.snapshot.self);
    // The raw string is never relayed.
    expect(bob.client.raw.some((f) => f.includes("watch?v="))).toBe(false);
    expect((await alice.client.next("queue-changed")).queue).toEqual(changed.queue);

    const second = await added(alice.client, watch(2));
    expect(second.map((i) => i.embed.url)).toEqual([embedUrl(1), embedUrl(2)]);
    expect(new Set(second.map((i) => i.id)).size).toBe(2);

    const carol = await joined();
    expect(carol.snapshot.room.queue).toEqual(second);
  });

  test("a URL the share parser refuses: unsupported_url, nothing queued, and it doesn't count toward the 4400 close", async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    for (let i = 0; i < 25; i++) {
      add(alice.client, "https://evil.example/not-a-video");
      const err = await alice.client.next("error");
      expect(err.code === "unsupported_url" || err.code === "rate_limited").toBe(true);
      c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
    }
    await alice.client.none("queue-changed", 100);
    expect(alice.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("the generic tier follows the share policy: refused with GENERIC_EMBEDS off, queued (parsed) with it on", async () => {
    t = start({ genericEmbeds: false });
    const off = await joined();
    add(off.client, GENERIC_URL);
    expect((await off.client.next("error")).code).toBe("unsupported_url");
    await t.server.stop(true);

    t = start();
    const on = await joined();
    await share(on);
    const queue = await added(on.client, GENERIC_URL);
    expect(queue[0]?.embed).toEqual({ provider: "generic", host: "videos.example-host.net", url: GENERIC_URL });
  });

  test(`per member: ${String(QUEUE_ADD_MEMBER_BURST)} at once, then rate_limited with retryAfterMs until the bucket refills`, async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    await share(alice);
    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) await added(alice.client, watch(i));
    add(alice.client, watch(50));
    const err = await alice.client.next("error");
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    await alice.client.none("queue-changed", 100);
    c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
    expect(await added(alice.client, watch(50))).toHaveLength(QUEUE_ADD_MEMBER_BURST + 1);
  });

  test("a refusal by the room's bucket gives the member's add back: other members' traffic can't drain it", async () => {
    const c = clock();
    t = start({ now: c.now });
    const quiet = await joined();
    // A current item, so adds queue (an add into an empty room starts it, ADR 0031 §5).
    await share(quiet);
    const members = [];
    for (let m = 0; m < Math.ceil(QUEUE_ADD_ROOM_BURST / QUEUE_ADD_MEMBER_BURST); m++) members.push(await joined());
    let n = 0;
    for (const m of members) {
      for (let i = 0; i < QUEUE_ADD_MEMBER_BURST && n < QUEUE_ADD_ROOM_BURST; i++) {
        add(m.client, watch(n++));
        await quiet.client.next("queue-changed");
      }
    }
    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) {
      add(quiet.client, watch(100 + i));
      expect((await quiet.client.next("error")).code).toBe("rate_limited");
    }
    // One room add is back; the quiet member, refused only by the room, still has all of theirs.
    c.ms += QUEUE_ADD_ROOM_REFILL_MS;
    expect(await added(quiet.client, watch(200))).toHaveLength(QUEUE_ADD_ROOM_BURST + 1);
  });

  test("the buckets come before the parse: refused URLs spend the member's adds", async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) {
      add(alice.client, "https://evil.example/");
      expect((await alice.client.next("error")).code).toBe("unsupported_url");
    }
    add(alice.client, watch(1));
    expect((await alice.client.next("error")).code).toBe("rate_limited");
  });

  test(`per room: ${String(QUEUE_ADD_ROOM_BURST)} at once from everyone together, then rate_limited`, async () => {
    const c = clock();
    t = start({ now: c.now });
    const members = [];
    for (let m = 0; m < Math.ceil(QUEUE_ADD_ROOM_BURST / QUEUE_ADD_MEMBER_BURST) + 1; m++) members.push(await joined());
    const watcher = members[0] ?? fail();
    await share(watcher);
    let n = 0;
    for (const m of members) {
      for (let i = 0; i < QUEUE_ADD_MEMBER_BURST && n < QUEUE_ADD_ROOM_BURST; i++) {
        add(m.client, watch(n++));
        await watcher.client.next("queue-changed");
      }
    }
    const last = members[members.length - 1] ?? fail();
    add(last.client, watch(100));
    const err = await last.client.next("error");
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    c.ms += QUEUE_ADD_ROOM_REFILL_MS;
    expect(await added(last.client, watch(100))).toHaveLength(QUEUE_ADD_ROOM_BURST + 1);
  });

  test(`at ${String(QUEUE_MAX)} upcoming items: queue_full, and nothing is evicted`, async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    await share(alice);
    let queue: QueueItem[] = [];
    for (let i = 0; i < QUEUE_MAX; i++) {
      c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
      queue = await added(alice.client, watch(i));
    }
    expect(queue).toHaveLength(QUEUE_MAX);
    c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
    add(alice.client, watch(100));
    expect((await alice.client.next("error")).code).toBe("queue_full");
    await alice.client.none("queue-changed", 100);
    const bob = await joined();
    expect(bob.snapshot.room.queue).toEqual(queue);
  });

  test("before join: not_joined, nothing queued", async () => {
    t = start();
    const watcher = await joined();
    const stranger = await Client.open(server().ws());
    clients.push(stranger);
    add(stranger, watch(1));
    expect((await stranger.next("error")).code).toBe("not_joined");
    await watcher.client.none("queue-changed", 100);
  });
});

describe("queue-remove (ADR 0031 §2, §3)", () => {
  test("drops an upcoming item for everyone; by is the remover", async () => {
    t = start();
    const alice = await joined();
    const bob = await joined();
    await alice.client.next("member-joined");
    await share(alice);
    await added(alice.client, watch(1));
    const queue = await added(alice.client, watch(2));
    await bob.client.next("queue-changed");
    await bob.client.next("queue-changed");
    bob.client.send({ type: "queue-remove", itemId: queue[0]?.id });
    const changed = await alice.client.next("queue-changed");
    expect(changed.by).toBe(bob.snapshot.self);
    expect(changed.queue).toEqual(queue.slice(1));
  });

  test("an item that isn't there: ignored, no error and no queue-changed", async () => {
    t = start();
    const alice = await joined();
    await share(alice);
    const queue = await added(alice.client, watch(1));
    const id = queue[0]?.id;
    alice.client.send({ type: "queue-remove", itemId: id });
    await alice.client.next("queue-changed");
    alice.client.send({ type: "queue-remove", itemId: id });
    alice.client.send({ type: "queue-remove", itemId: "never-was" });
    await alice.client.none("queue-changed", 100);
    await alice.client.none("error", 0);
  });
});

describe("queue-advance (ADR 0031 §2, §5)", () => {
  test("from the current item: embed-changed (by null, a load, the item's id) first, then queue-changed by the advancer", async () => {
    t = start();
    const alice = await joined();
    const bob = await joined();
    await alice.client.next("member-joined");
    const current = await share(alice);
    await bob.client.next("embed-changed");
    const queue = await added(alice.client, watch(1));
    await added(alice.client, watch(2));
    await bob.client.next("queue-changed");
    await bob.client.next("queue-changed");
    const before = bob.client.raw.length;

    bob.client.send({ type: "queue-advance", fromItemId: current });
    const changed = await alice.client.next("embed-changed");
    expect(changed.embed).toEqual(queue[0]?.embed ?? null);
    expect(changed.by).toBeNull();
    expect(changed.itemId).toBe(queue[0]?.id);
    expect(changed.playback).toMatchObject({ playing: true, position: 0, action: "load" });
    const after = await alice.client.next("queue-changed");
    expect(after.by).toBe(bob.snapshot.self);
    expect(after.queue.map((i) => i.embed.url)).toEqual([embedUrl(2)]);
    // embed-changed comes first: it starts the players.
    await bob.client.next("queue-changed");
    const types = bob.client.raw.slice(before).map((f) => (JSON.parse(f) as { type: string }).type);
    expect(types.indexOf("embed-changed")).toBeLessThan(types.indexOf("queue-changed"));

    const carol = await joined();
    expect(carol.snapshot.room.itemId).toBe(queue[0]?.id);
    expect(carol.snapshot.room.queue?.map((i) => i.embed.url)).toEqual([embedUrl(2)]);
  });

  test("two clicks on next from the same item skip one item, not two; a stale fromItemId is ignored", async () => {
    t = start();
    const alice = await joined();
    const bob = await joined();
    await alice.client.next("member-joined");
    const current = await share(alice);
    await added(alice.client, watch(1));
    await added(alice.client, watch(2));
    alice.client.send({ type: "queue-advance", fromItemId: current });
    bob.client.send({ type: "queue-advance", fromItemId: current });
    expect((await alice.client.next("embed-changed")).embed?.url).toBe(embedUrl(1));
    await alice.client.next("queue-changed");
    await alice.client.none("embed-changed", 150);
    await bob.client.none("error", 0);
  });

  test("with an empty queue: nothing changes", async () => {
    t = start();
    const alice = await joined();
    const current = await share(alice);
    alice.client.send({ type: "queue-advance", fromItemId: current });
    await alice.client.none("embed-changed", 100);
    await alice.client.none("queue-changed", 0);
  });

  test("onto a generic item: playback null, so it stays click-to-load (ADR 0024)", async () => {
    t = start();
    const alice = await joined();
    const current = await share(alice);
    await added(alice.client, GENERIC_URL);
    alice.client.send({ type: "queue-advance", fromItemId: current });
    const changed = await alice.client.next("embed-changed");
    expect(changed.embed?.provider).toBe("generic");
    expect(changed.playback).toBeNull();
  });
});

describe("shares and item ids (ADR 0031 §1)", () => {
  test("every share mints a fresh itemId, in embed-changed and the snapshot, and doesn't touch the queue", async () => {
    t = start();
    const alice = await joined();
    const first = await share(alice);
    const queue = await added(alice.client, watch(1));
    const second = await share(alice);
    expect(first).not.toBe(second);
    expect(queue.map((i) => i.id)).not.toContain(first);
    await alice.client.none("queue-changed", 100);
    const bob = await joined();
    expect(bob.snapshot.room.itemId).toBe(second);
    expect(bob.snapshot.room.queue).toEqual(queue);
  });
});

describe("control policy owner: guests can't change the queue (ADR 0031 §3)", () => {
  test("queue-add, queue-remove and queue-advance from a guest: control_owner_only, nothing changes, and the guest's adds aren't spent", async () => {
    const c = clock();
    t = start({ now: c.now, trustProxy: true });
    const room = await createRoom();
    const id = room.room.id;
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken, address: freshAddress() });
    const guest = await joined(id, "mallory", { address: freshAddress() });
    await owner.client.next("member-joined");
    const current = await share(owner, SHARE_BODY, id);
    const queue = await added(owner.client, watch(1));
    await guest.client.next("queue-changed");
    owner.client.send({ type: "control-policy", policy: "owner" });
    await guest.client.next("control-policy-changed");

    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST + 1; i++) {
      add(guest.client, watch(10 + i));
      expect((await guest.client.next("error")).code).toBe("control_owner_only");
    }
    guest.client.send({ type: "queue-remove", itemId: queue[0]?.id });
    expect((await guest.client.next("error")).code).toBe("control_owner_only");
    guest.client.send({ type: "queue-advance", fromItemId: current });
    expect((await guest.client.next("error")).code).toBe("control_owner_only");
    const res = await postQueue(JSON.stringify({ url: watch(20) }), { roomId: id, token: tokenOf(guest.snapshot) });
    expect(res.status).toBe(403);
    expect(v.parse(QueueAddResponseSchema, await res.json())).toMatchObject({ ok: false, error: { code: "control_owner_only" } });
    await owner.client.none("queue-changed", 100);
    await owner.client.none("embed-changed", 0);

    // Back to everyone: the refusals above spent none of the guest's adds.
    owner.client.send({ type: "control-policy", policy: "everyone" });
    await guest.client.next("control-policy-changed");
    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) await added(guest.client, watch(30 + i));
  });
});

describe("ended (ADR 0031 §4)", () => {
  /** Alice shared; the queue holds watch(1) and watch(2); the debounce has passed. */
  async function playing(c: ReturnType<typeof clock>, body = SHARE_BODY) {
    const alice = await joined();
    const bob = await joined();
    await alice.client.next("member-joined");
    const current = await share(alice, body);
    await bob.client.next("embed-changed");
    const queue = await added(alice.client, watch(1));
    await added(alice.client, watch(2));
    await bob.client.next("queue-changed");
    await bob.client.next("queue-changed");
    c.ms += QUEUE_ENDED_DEBOUNCE_MS;
    return { alice, bob, current, queue };
  }

  test("the first valid report advances for everyone, by null; later reports for the spent item change nothing", async () => {
    const c = clock();
    t = start({ now: c.now });
    const { alice, bob, current, queue } = await playing(c);
    bob.client.send({ type: "ended", itemId: current, position: 0 });
    alice.client.send({ type: "ended", itemId: current, position: 0 });
    const changed = await alice.client.next("embed-changed");
    expect(changed.itemId).toBe(queue[0]?.id);
    expect(changed.by).toBeNull();
    const after = await alice.client.next("queue-changed");
    expect(after.by).toBeNull();
    expect(after.queue.map((i) => i.embed.url)).toEqual([embedUrl(2)]);
    await alice.client.none("embed-changed", 150);
    await alice.client.none("error", 0);
    await bob.client.none("error", 0);
  });

  test(`within ${String(QUEUE_ENDED_DEBOUNCE_MS)} ms of becoming current: ignored`, async () => {
    const c = clock();
    t = start({ now: c.now });
    const { alice, current } = await playing(c);
    alice.client.send({ type: "queue-advance", fromItemId: current });
    const next = (await alice.client.next("embed-changed")).itemId;
    c.ms += QUEUE_ENDED_DEBOUNCE_MS - 1;
    alice.client.send({ type: "ended", itemId: next, position: 0 });
    await alice.client.none("embed-changed", 150);
    c.ms += 1;
    alice.client.send({ type: "ended", itemId: next, position: 0 });
    expect((await alice.client.next("embed-changed")).embed?.url).toBe(embedUrl(2));
  });

  test("a stale itemId, a position far from the room clock, or a sender who hasn't joined: ignored silently", async () => {
    const c = clock();
    t = start({ now: c.now });
    const { alice, current } = await playing(c);
    alice.client.send({ type: "ended", itemId: "some-old-item", position: 0 });
    alice.client.send({ type: "ended", itemId: current, position: 600 });
    const stranger = await Client.open(server().ws());
    clients.push(stranger);
    stranger.send({ type: "ended", itemId: current, position: 0 });
    await alice.client.none("embed-changed", 150);
    await alice.client.none("error", 0);
    await stranger.none("error", 0);
  });

  test("a live current item never advances on ended (only queue-advance)", async () => {
    const c = clock();
    t = start({ now: c.now });
    const { alice, current } = await playing(c, LIVE_BODY);
    alice.client.send({ type: "ended", itemId: current, position: 0 });
    await alice.client.none("embed-changed", 150);
    alice.client.send({ type: "queue-advance", fromItemId: current });
    expect((await alice.client.next("embed-changed")).embed?.url).toBe(embedUrl(1));
  });

  test("a generic current item never advances on ended", async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    const current = await share(alice);
    await added(alice.client, GENERIC_URL);
    await added(alice.client, watch(1));
    alice.client.send({ type: "queue-advance", fromItemId: current });
    const generic = (await alice.client.next("embed-changed")).itemId;
    c.ms += QUEUE_ENDED_DEBOUNCE_MS;
    alice.client.send({ type: "ended", itemId: generic, position: 0 });
    await alice.client.none("embed-changed", 150);
  });

  test("with an empty queue: a valid ended changes nothing", async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    const current = await share(alice);
    c.ms += QUEUE_ENDED_DEBOUNCE_MS;
    alice.client.send({ type: "ended", itemId: current, position: 0 });
    await alice.client.none("embed-changed", 150);
    await alice.client.none("queue-changed", 0);
  });

  test("ended is not subject to the control policy: a guest's valid report advances an owner-only room", async () => {
    const c = clock();
    t = start({ now: c.now, trustProxy: true });
    const room = await createRoom();
    const id = room.room.id;
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken, address: freshAddress() });
    const guest = await joined(id, "mallory", { address: freshAddress() });
    await owner.client.next("member-joined");
    owner.client.send({ type: "control-policy", policy: "owner" });
    await guest.client.next("control-policy-changed");
    const current = await share(owner, SHARE_BODY, id);
    await added(owner.client, watch(1));
    c.ms += QUEUE_ENDED_DEBOUNCE_MS;
    guest.client.send({ type: "ended", itemId: current, position: 0 });
    expect((await owner.client.next("embed-changed")).embed?.url).toBe(embedUrl(1));
  });
});

describe("POST /rooms/:id/queue (ADR 0031 §2)", () => {
  test("a member's token queues the parsed embed: 200 { ok, item }, and the room gets queue-changed", async () => {
    t = start();
    const alice = await joined();
    await share(alice);
    const res = await postQueue(JSON.stringify({ url: watch(1) }), { token: tokenOf(alice.snapshot) });
    expect(res.status).toBe(200);
    const body = v.parse(QueueAddResponseSchema, await res.json());
    if (!body.ok) throw new Error(body.error.code);
    expect(body.item).toMatchObject({ embed: { url: embedUrl(1) }, by: alice.snapshot.self });
    expect((await alice.client.next("queue-changed")).queue).toEqual([body.item]);
  });

  test("errors: 401 without a member's token, 400 unsupported_url, 404 unknown room; nothing queued", async () => {
    t = start();
    const alice = await joined();
    expect((await postQueue(JSON.stringify({ url: watch(1) }))).status).toBe(401);
    const bad = await postQueue(JSON.stringify({ url: "https://evil.example/" }), { token: tokenOf(alice.snapshot) });
    expect(bad.status).toBe(400);
    expect(v.parse(QueueAddResponseSchema, await bad.json())).toMatchObject({ ok: false, error: { code: "unsupported_url" } });
    expect((await postQueue(JSON.stringify({ url: watch(1) }), { roomId: "nowhere", token: tokenOf(alice.snapshot) })).status).toBe(404);
    await alice.client.none("queue-changed", 100);
  });

  test("shares the member's add bucket with the WebSocket: 429 with Retry-After once it is spent", async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) await added(alice.client, watch(i));
    const res = await postQueue(JSON.stringify({ url: watch(50) }), { token: tokenOf(alice.snapshot) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(v.parse(QueueAddResponseSchema, await res.json())).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  test("the control policy is checked again once a slow body has arrived", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom();
    const id = room.room.id;
    const owner = await joined(id, "olive", { ownerToken: room.ownerToken, address: freshAddress() });
    const guest = await joined(id, "mallory", { address: freshAddress() });
    await owner.client.next("member-joined");
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const pending = fetch(`${server().http}/rooms/${id}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf(guest.snapshot)}`, "x-forwarded-for": freshAddress() },
      body,
    });
    const ctl = (): ReadableStreamDefaultController<Uint8Array> => controller ?? fail();
    ctl().enqueue(new TextEncoder().encode('{"url":'));
    await Bun.sleep(50);
    owner.client.send({ type: "control-policy", policy: "owner" });
    await guest.client.next("control-policy-changed");
    ctl().enqueue(new TextEncoder().encode(`${JSON.stringify(watch(1))}}`));
    ctl().close();
    const res = await pending;
    expect(res.status).toBe(403);
    await owner.client.none("queue-changed", 100);
  });

  test(`409 queue_full at ${String(QUEUE_MAX)}`, async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    await share(alice);
    for (let i = 0; i < QUEUE_MAX; i++) {
      c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
      await added(alice.client, watch(i));
    }
    c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
    const res = await postQueue(JSON.stringify({ url: watch(100) }), { token: tokenOf(alice.snapshot) });
    expect(res.status).toBe(409);
    expect(v.parse(QueueAddResponseSchema, await res.json())).toMatchObject({ ok: false, error: { code: "queue_full" } });
  });
});

describe("persistence (ADR 0031 §6)", () => {
  test("a restart keeps the queue and the current item: same ids and embeds, by null", async () => {
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    const alice = await joined();
    const current = await share(alice);
    await added(alice.client, watch(1));
    const queue = await added(alice.client, GENERIC_URL);
    for (const cl of clients.splice(0)) cl.close();
    await t.server.stop(true);
    db.close();

    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    const back = await joined();
    expect(back.snapshot.room.itemId).toBe(current);
    expect(back.snapshot.room.queue).toEqual(queue.map((i) => ({ ...i, by: null })));
  });

  test("after a restart the restored item is current anew: ended waits out the debounce again", async () => {
    const c = clock();
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db), now: c.now });
    const alice = await joined();
    const current = await share(alice);
    await added(alice.client, watch(1));
    c.ms += QUEUE_ENDED_DEBOUNCE_MS;
    for (const cl of clients.splice(0)) cl.close();
    await t.server.stop(true);
    db.close();

    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db), now: c.now });
    const back = await joined();
    // Restored paused at 0, so position 0 matches the room clock: only the debounce stands in the way.
    back.client.send({ type: "ended", itemId: current, position: 0 });
    await back.client.none("embed-changed", 150);
    c.ms += QUEUE_ENDED_DEBOUNCE_MS;
    back.client.send({ type: "ended", itemId: current, position: 0 });
    expect((await back.client.next("embed-changed")).embed?.url).toBe(embedUrl(1));
  });

  test(`rows hidden by the policy can't push a restored queue past ${String(QUEUE_MAX)}: the oldest are kept and the room stays joinable`, async () => {
    const c = clock();
    const boot = async (genericEmbeds: boolean): Promise<void> => {
      for (const cl of clients.splice(0)) cl.close();
      await t?.server.stop(true);
      db?.close();
      db = openDatabase(dbFile());
      t = start({ store: new RoomStore(db), now: c.now, genericEmbeds });
    };
    await boot(true);
    const alice = await joined();
    await share(alice);
    let generic: QueueItem[] = [];
    for (let i = 0; i < QUEUE_MAX; i++) {
      c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
      generic = await added(alice.client, `${GENERIC_URL}${String(i)}`);
    }
    // Hidden by the kill switch, the 20 generic rows leave room for a 21st row.
    await boot(false);
    const bob = await joined();
    expect(bob.snapshot.room.queue ?? []).toEqual([]);
    c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
    await added(bob.client, watch(1));

    await boot(true);
    // Client.join throws on a frame the contract refuses, as every site client would.
    const carol = await joined();
    expect(carol.snapshot.room.queue?.map((i) => i.id)).toEqual(generic.map((i) => i.id));
    c.ms += QUEUE_ADD_MEMBER_REFILL_MS;
    add(carol.client, watch(2));
    expect((await carol.client.next("error")).code).toBe("queue_full");
  });

  test("an item the policy no longer accepts (GENERIC_EMBEDS off) is left out after the restart", async () => {
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    const alice = await joined();
    await share(alice);
    await added(alice.client, GENERIC_URL);
    const queue = await added(alice.client, watch(1));
    for (const cl of clients.splice(0)) cl.close();
    await t.server.stop(true);
    db.close();

    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db), genericEmbeds: false });
    const back = await joined();
    expect(back.snapshot.room.queue?.map((i) => i.id)).toEqual([queue[1]?.id ?? "missing"]);
  });

  test("one store write per queue action; control, chat and ignored frames write nothing", async () => {
    const c = clock();
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
    t = start({ store: spy, now: c.now });
    const alice = await joined();
    const current = await share(alice);
    watching = true;

    const queue = await added(alice.client, watch(1));
    expect(calls.splice(0)).toEqual(["addQueueItem"]);
    await added(alice.client, watch(2));
    calls.splice(0);
    alice.client.send({ type: "queue-remove", itemId: queue[0]?.id });
    await alice.client.next("queue-changed");
    expect(calls.splice(0)).toEqual(["removeQueueItem"]);
    alice.client.send({ type: "queue-advance", fromItemId: current });
    const next = (await alice.client.next("embed-changed")).itemId;
    await alice.client.next("queue-changed");
    expect(calls.splice(0)).toEqual(["advanceQueue"]);

    alice.client.send({ type: "control", url: embedUrl(2), playing: false, position: 1 });
    await alice.client.next("playback");
    alice.client.send({ type: "chat", text: "hi" });
    await alice.client.next("chat");
    alice.client.send({ type: "ended", itemId: next, position: 0 });
    alice.client.send({ type: "queue-remove", itemId: "never-was" });
    await alice.client.none("queue-changed", 100);
    expect(calls).toEqual([]);
  });

  test("deleting the room deletes its queue rows", async () => {
    t = start({ trustProxy: true, store: new RoomStore((db = openDatabase(dbFile()))) });
    const room = await createRoom();
    const owner = await joined(room.room.id, "olive", { ownerToken: room.ownerToken, address: freshAddress() });
    await share(owner, SHARE_BODY, room.room.id);
    await added(owner.client, watch(1));
    await added(owner.client, watch(2));
    const count = (): number => db?.query<{ n: number }, []>("SELECT count(*) AS n FROM queue_items").get()?.n ?? -1;
    expect(count()).toBe(2);
    const res = await fetch(`${server().http}/rooms/${room.room.id}`, { method: "DELETE", headers: { authorization: `Bearer ${room.ownerToken}` } });
    expect(res.status).toBe(200);
    expect(count()).toBe(0);
  });
});

describe("starting from an empty room (ADR 0031 §5, OME-543)", () => {
  interface Row {
    item_id: string | null;
    embed: string | null;
  }
  const roomRow = (roomId = "lobby"): Row | null => db?.query<Row, [string]>("SELECT item_id, embed FROM rooms WHERE id = ?").get(roomId) ?? null;
  const queueRows = (roomId = "lobby"): string[] =>
    (db?.query<{ id: string }, [string]>("SELECT id FROM queue_items WHERE room_id = ? ORDER BY position").all(roomId) ?? []).map((r) => r.id);
  const typesSince = (c: Client, from: number): string[] => c.raw.slice(from).map((f) => (JSON.parse(f) as { type: string }).type);

  test("a WebSocket add starts the item: embed-changed (by the adder, a load at 0, its id) first, then queue-changed with the rest; stored as current", async () => {
    const c = clock();
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db), now: c.now });
    const alice = await joined();
    const bob = await joined();
    await alice.client.next("member-joined");
    expect(alice.snapshot.room.itemId ?? null).toBeNull();
    const before = bob.client.raw.length;

    add(alice.client, watch(1));
    const changed = await bob.client.next("embed-changed");
    expect(changed.embed).toEqual({ provider: "youtube", videoId: vid(1), url: embedUrl(1) });
    expect(changed.by).toBe(alice.snapshot.self);
    expect(changed.playback).toMatchObject({ playing: true, position: 0, action: "load" });
    expect(changed.itemId).toBeDefined();
    const after = await bob.client.next("queue-changed");
    expect(after.by).toBe(alice.snapshot.self);
    expect(after.queue).toEqual([]);
    expect(typesSince(bob.client, before).filter((x) => x === "embed-changed" || x === "queue-changed")).toEqual(["embed-changed", "queue-changed"]);

    expect(roomRow()?.item_id).toBe(changed.itemId ?? "missing");
    expect(roomRow()?.embed).not.toBeNull();
    expect(queueRows()).toEqual([]);
    const carol = await joined();
    expect(carol.snapshot.room.itemId).toBe(changed.itemId ?? "missing");
    expect(carol.snapshot.room.embed?.url).toBe(embedUrl(1));
    expect(carol.snapshot.room.queue ?? []).toEqual([]);
  });

  test("the started item's ended debounce runs from the add, and later adds only queue", async () => {
    const c = clock();
    t = start({ now: c.now });
    const alice = await joined();
    add(alice.client, watch(1));
    const current = (await alice.client.next("embed-changed")).itemId;
    await alice.client.next("queue-changed");
    expect(await added(alice.client, watch(2))).toHaveLength(1);
    await alice.client.none("embed-changed", 0);
    c.ms += QUEUE_ENDED_DEBOUNCE_MS - 1;
    alice.client.send({ type: "ended", itemId: current, position: 0 });
    await alice.client.none("embed-changed", 150);
    c.ms += 1;
    alice.client.send({ type: "ended", itemId: current, position: 0 });
    expect((await alice.client.next("embed-changed")).embed?.url).toBe(embedUrl(2));
  });

  test("a generic first item becomes current with playback null: click-to-load (ADR 0024)", async () => {
    t = start();
    const alice = await joined();
    add(alice.client, GENERIC_URL);
    const changed = await alice.client.next("embed-changed");
    expect(changed.embed?.provider).toBe("generic");
    expect(changed.playback).toBeNull();
    expect(changed.by).toBe(alice.snapshot.self);
    expect((await alice.client.next("queue-changed")).queue).toEqual([]);
  });

  test("POST /rooms/:id/queue into an empty room: 200 { ok, item }, and the item starts (embed-changed by the token's member, then queue-changed)", async () => {
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    const alice = await joined();
    const before = alice.client.raw.length;
    const res = await postQueue(JSON.stringify({ url: watch(1) }), { token: tokenOf(alice.snapshot) });
    expect(res.status).toBe(200);
    const body = v.parse(QueueAddResponseSchema, await res.json());
    if (!body.ok) throw new Error(body.error.code);
    expect(body.item).toMatchObject({ embed: { url: embedUrl(1) }, by: alice.snapshot.self });
    const changed = await alice.client.next("embed-changed");
    expect(changed.itemId).toBe(body.item.id);
    expect(changed.by).toBe(alice.snapshot.self);
    expect(changed.playback).toMatchObject({ playing: true, position: 0, action: "load" });
    const after = await alice.client.next("queue-changed");
    expect(after.queue).toEqual([]);
    expect(after.by).toBe(alice.snapshot.self);
    expect(typesSince(alice.client, before).filter((x) => x === "embed-changed" || x === "queue-changed")).toEqual(["embed-changed", "queue-changed"]);
    expect(roomRow()?.item_id).toBe(body.item.id);
    expect(queueRows()).toEqual([]);
  });

  test("a queue left over after a dropped embed row: the add starts its head, oldest first, and appends the new item; queue-advance with no current item stays ignored", async () => {
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    const alice = await joined();
    await share(alice);
    await added(alice.client, watch(1));
    const leftover = await added(alice.client, watch(2));
    for (const cl of clients.splice(0)) cl.close();
    await t.server.stop(true);
    db.run("UPDATE rooms SET embed = NULL, item_id = NULL WHERE id = 'lobby'");
    db.close();

    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    const back = await joined();
    expect(back.snapshot.room.itemId ?? null).toBeNull();
    expect(back.snapshot.room.queue?.map((i) => i.id)).toEqual(leftover.map((i) => i.id));
    back.client.send({ type: "queue-advance", fromItemId: leftover[0]?.id ?? "missing" });
    await back.client.none("embed-changed", 150);
    await back.client.none("queue-changed", 0);

    add(back.client, watch(3));
    const changed = await back.client.next("embed-changed");
    expect(changed.itemId).toBe(leftover[0]?.id ?? "missing");
    expect(changed.embed?.url).toBe(embedUrl(1));
    expect(changed.by).toBe(back.snapshot.self);
    const after = await back.client.next("queue-changed");
    expect(after.queue.map((i) => i.embed.url)).toEqual([embedUrl(2), embedUrl(3)]);
    expect(after.queue[0]?.id).toBe(leftover[1]?.id ?? "missing");
    expect(roomRow()?.item_id).toBe(leftover[0]?.id ?? "missing");
    expect(queueRows()).toEqual(after.queue.map((i) => i.id));
  });

  test("a failed store write changes nothing: no row, no current item, no frames", async () => {
    db = openDatabase(dbFile());
    t = start({ store: new RoomStore(db) });
    // The add's insert succeeds and starting the item fails: the whole write must roll back.
    db.run("CREATE TRIGGER no_start BEFORE UPDATE OF item_id ON rooms WHEN NEW.item_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");
    const alice = await joined();
    add(alice.client, watch(1));
    await alice.client.none("embed-changed", 150);
    await alice.client.none("queue-changed", 0);
    expect(roomRow()).toEqual({ item_id: null, embed: null });
    expect(queueRows()).toEqual([]);
    const bob = await joined();
    expect(bob.snapshot.room.itemId ?? null).toBeNull();
    expect(bob.snapshot.room.embed ?? null).toBeNull();
    expect(bob.snapshot.room.queue ?? []).toEqual([]);
  });

  test("a room that already has a current item: the add only queues (queue-changed, no embed-changed, one addQueueItem)", async () => {
    t = start();
    const alice = await joined();
    const current = await share(alice);
    const queue = await added(alice.client, watch(1));
    expect(queue.map((i) => i.embed.url)).toEqual([embedUrl(1)]);
    await alice.client.none("embed-changed", 100);
    const bob = await joined();
    expect(bob.snapshot.room.itemId).toBe(current);
  });

  test("one store write for the add that starts an item", async () => {
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
    t = start({ store: spy });
    const alice = await joined();
    watching = true;
    add(alice.client, watch(1));
    await alice.client.next("embed-changed");
    await alice.client.next("queue-changed");
    expect(calls).toHaveLength(1);
  });
});
