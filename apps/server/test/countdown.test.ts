import { afterEach, describe, expect, test } from "bun:test";
import { COUNTDOWN_MS } from "@omega/shared";
import { Client, postShare, start, TestClock, tokenOf, type TestServer } from "./helpers";

// OME-1634 (ADR 0056): the shared 3-2-1. Landed after the Rust switch: the frozen TS server ignores
// `control.countdown`, so every test here runs against the binary only.
const binaryOnly = test.skipIf(process.env["OMEGA_SERVER_BIN"] === undefined);

let t: TestServer | null = null;
let clock = new TestClock();
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});
function begin(): void {
  clock = new TestClock();
  t = start({ now: clock.now, wallNow: clock.wallNow });
}

function fail(): never {
  throw new Error("no server");
}
const server = (): TestServer => t ?? fail();

let nextAddress = 1;
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

async function joined(nickname: string) {
  const client = await Client.open(server().ws(), undefined, { "x-forwarded-for": freshAddress() });
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0 });
  return { client, snapshot: await client.next("snapshot") };
}

const URL = "https://www.youtube.com/embed/dQw4w9WgXcQ";
const LIVE = "https://www.twitch.tv/somechannel";

/** Shares `url` as `member` and pauses it at 42 s; returns the room's url for the embed. */
async function sharedAndPaused(member: Awaited<ReturnType<typeof joined>>, url: string): Promise<string> {
  const res = await postShare(server(), JSON.stringify({ url }), { token: tokenOf(member.snapshot) });
  expect(res.status).toBe(200);
  const embedUrl = (await member.client.next("embed-changed")).embed?.url ?? "";
  member.client.send({ type: "control", url: embedUrl, playing: false, position: 42 });
  await member.client.next("playback");
  return embedUrl;
}

describe("shared countdown (OME-1634)", () => {
  binaryOnly("a countdown play is relayed to everyone with startAt COUNTDOWN_MS after at", async () => {
    begin();
    const a = await joined("alice");
    const b = await joined("bob");
    const url = await sharedAndPaused(a, URL);
    await b.client.next("playback");
    b.client.send({ type: "control", url, playing: true, position: 42, countdown: true });
    const heard = (await a.client.next("playback")).playback;
    expect(heard).toMatchObject({ playing: true, position: 42, action: "play", by: b.snapshot.self });
    expect(heard.startAt).toBe(heard.at + COUNTDOWN_MS);
    expect((await b.client.next("playback")).playback).toEqual(heard);
    // A late joiner sees the same countdown in its snapshot.
    const late = await joined("carol");
    expect(late.snapshot.room.playback).toEqual(heard);
  });

  binaryOnly("a pause during the countdown cancels it for everyone", async () => {
    begin();
    const a = await joined("alice");
    const b = await joined("bob");
    const url = await sharedAndPaused(a, URL);
    await b.client.next("playback");
    a.client.send({ type: "control", url, playing: true, position: 42, countdown: true });
    await a.client.next("playback");
    await b.client.next("playback");
    b.client.send({ type: "control", url, playing: false, position: 42 });
    const cancelled = (await a.client.next("playback")).playback;
    expect(cancelled).toMatchObject({ playing: false, position: 42, action: "pause" });
    expect(cancelled.startAt).toBeUndefined();
  });

  binaryOnly("countdown is ignored on a pause and on a live embed", async () => {
    begin();
    const a = await joined("alice");
    const url = await sharedAndPaused(a, LIVE);
    a.client.send({ type: "control", url, playing: true, position: 0, countdown: true });
    expect((await a.client.next("playback")).playback.startAt).toBeUndefined();
    a.client.send({ type: "control", url, playing: false, position: 0, countdown: true });
    expect((await a.client.next("playback")).playback.startAt).toBeUndefined();
  });
});
