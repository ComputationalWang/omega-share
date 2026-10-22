import { afterEach, describe, expect, test } from "bun:test";
import { CreateRoomResponseSchema, type CreateRoomResponse } from "@omega/shared";
import * as v from "valibot";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

// OME-1633 (ADR 0056): the watching summary in `GET /rooms` and a share's `startSeconds`. Landed after the Rust
// switch: the frozen TS server ignores both, so every test here runs against the binary only.
const binaryOnly = test.skipIf(process.env["OMEGA_SERVER_BIN"] === undefined);

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

let nextAddress = 1;
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const TWITCH_LIVE = "https://www.twitch.tv/somechannel";
const TWITCH_VOD = "https://www.twitch.tv/videos/123456789";
const VIMEO = "https://vimeo.com/76979871";
const VIMEO_UNLISTED = "https://vimeo.com/76979871/abcdef1234";

async function joined(roomId = "lobby", nickname = "alice", inviteKey?: string) {
  const client = await Client.open(server().ws(roomId), undefined, { "x-forwarded-for": freshAddress() });
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...(inviteKey === undefined ? {} : { inviteKey }) });
  return { client, snapshot: await client.next("snapshot") };
}

type Created = Extract<CreateRoomResponse, { ok: true }>;
async function createRoom(visibility: "public" | "private"): Promise<Created> {
  const res = await fetch(`${server().http}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
    body: JSON.stringify({ title: "Movie night", visibility }),
  });
  const body = v.parse(CreateRoomResponseSchema, await res.json());
  if (!body.ok) throw new Error(`create failed: ${body.error.code}`);
  return body;
}

/** `GET /rooms` as sent, unparsed, so a stripped key can't hide. */
async function rawList(): Promise<{ rooms: Record<string, unknown>[] }> {
  return (await (await fetch(`${server().http}/rooms`)).json()) as { rooms: Record<string, unknown>[] };
}
async function row(id: string): Promise<Record<string, unknown> | undefined> {
  return (await rawList()).rooms.find((r) => r["id"] === id);
}

/** Shares `body` into `roomId` as `member`; the `embed-changed` the sharer hears. */
async function shared(member: Awaited<ReturnType<typeof joined>>, body: unknown, roomId = "lobby") {
  const res = await postShare(server(), JSON.stringify(body), { roomId, token: tokenOf(member.snapshot) });
  expect(res.status).toBe(200);
  return member.client.next("embed-changed");
}
/** The room's new playback after the share. */
async function share(member: Awaited<ReturnType<typeof joined>>, body: unknown, roomId = "lobby") {
  return (await shared(member, body, roomId)).playback;
}

function postQueue(body: unknown, token: string, roomId = "lobby"): Promise<Response> {
  return fetch(`${server().http}/rooms/${roomId}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("GET /rooms watching summary (OME-1633, ADR 0056)", () => {
  binaryOnly("watchingCount counts the members whose tab is visible; an empty room has 0 and no nowPlaying", async () => {
    t = start();
    expect(await row("lobby")).toEqual({ id: "lobby", memberCount: 0, seatedCount: 0, watchingCount: 0 });
    const alice = await joined();
    await joined("lobby", "bob");
    expect((await row("lobby"))?.["watchingCount"]).toBe(2);
    alice.client.send({ type: "presence", away: true });
    await alice.client.next("member-presence");
    expect(await row("lobby")).toEqual({ id: "lobby", memberCount: 2, seatedCount: 0, watchingCount: 1 });
  });

  binaryOnly("nowPlaying names the provider and id only: YouTube, Twitch live and VOD, public Vimeo", async () => {
    t = start();
    const alice = await joined();
    const cases: [string, unknown][] = [
      [YT, { provider: "youtube", id: "dQw4w9WgXcQ" }],
      [TWITCH_LIVE, { provider: "twitch", id: "somechannel" }],
      [TWITCH_VOD, { provider: "twitch", id: "videos/123456789" }],
      [VIMEO, { provider: "vimeo", id: "76979871" }],
    ];
    for (const [url, nowPlaying] of cases) {
      await share(alice, { url });
      expect(await row("lobby")).toEqual({ id: "lobby", memberCount: 1, seatedCount: 0, watchingCount: 1, nowPlaying });
    }
  });

  binaryOnly("an unlisted Vimeo is never named: its id is what the hash protects", async () => {
    t = start();
    const alice = await joined();
    await share(alice, { url: VIMEO_UNLISTED });
    const lobby = await row("lobby");
    expect(lobby).toEqual({ id: "lobby", memberCount: 1, seatedCount: 0, watchingCount: 1 });
    expect(JSON.stringify(await rawList())).not.toContain("76979871");
  });

  binaryOnly("a private room's video never appears in the list", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("private");
    const alice = await joined(room.room.id, "alice", room.inviteKey ?? fail());
    await share(alice, { url: YT }, room.room.id);
    const body = JSON.stringify(await rawList());
    expect(body).not.toContain(room.room.id);
    expect(body).not.toContain("dQw4w9WgXcQ");
    expect(body).not.toContain("nowPlaying");
  });

  binaryOnly("a listed created room shows its video", async () => {
    t = start({ trustProxy: true });
    const room = await createRoom("public");
    const alice = await joined(room.room.id);
    await share(alice, { url: YT }, room.room.id);
    expect((await row(room.room.id))?.["nowPlaying"]).toEqual({ provider: "youtube", id: "dQw4w9WgXcQ" });
  });
});

describe("share startSeconds (OME-1633, ADR 0056)", () => {
  binaryOnly("a share starts the room there, and a late joiner gets the room clock from it", async () => {
    t = start();
    const alice = await joined();
    const playback = await share(alice, { url: YT, startSeconds: 90 });
    expect(playback).toMatchObject({ playing: true, position: 90, action: "load" });
    const bob = await joined("lobby", "bob");
    const late = bob.snapshot.room.playback ?? fail();
    expect(late).toMatchObject({ playing: true, position: 90, action: "load", rev: playback?.rev });
    expect(late.at).toBe(playback?.at ?? fail());
  });

  binaryOnly("without startSeconds a share starts at 0; on a live stream startSeconds is ignored", async () => {
    t = start();
    const alice = await joined();
    expect((await share(alice, { url: YT }))?.position).toBe(0);
    expect((await share(alice, { url: TWITCH_LIVE, startSeconds: 90 }))?.position).toBe(0);
  });

  binaryOnly("the bounds: 0 and 43200 start there; -1, 43201, 1.5, a string or null are refused as invalid_body", async () => {
    t = start();
    const alice = await joined();
    expect((await share(alice, { url: YT, startSeconds: 0 }))?.position).toBe(0);
    expect((await share(alice, { url: YT, startSeconds: 43_200 }))?.position).toBe(43_200);
    for (const startSeconds of [-1, 43_201, 1.5, "90", null]) {
      const res = await postShare(server(), JSON.stringify({ url: YT, startSeconds }), { token: tokenOf(alice.snapshot) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_body");
    }
  });

  binaryOnly("a queued item keeps its startSeconds until it plays, then starts there", async () => {
    t = start();
    const alice = await joined();
    const current = (await shared(alice, { url: YT })).itemId ?? fail();
    const res = await postQueue({ url: VIMEO, startSeconds: 42 }, tokenOf(alice.snapshot));
    expect(res.status).toBe(200);
    const queued = await alice.client.next("queue-changed");
    expect(queued.queue).toEqual([expect.objectContaining({ startSeconds: 42 })]);
    alice.client.send({ type: "queue-advance", fromItemId: current });
    const next = await alice.client.next("embed-changed");
    expect(next.playback).toMatchObject({ position: 42, action: "load" });
  });

  binaryOnly("a queue add into an empty room starts the item at its startSeconds", async () => {
    t = start();
    const alice = await joined();
    expect((await postQueue({ url: YT, startSeconds: 7 }, tokenOf(alice.snapshot))).status).toBe(200);
    expect((await alice.client.next("embed-changed")).playback).toMatchObject({ position: 7, action: "load" });
  });
});
