import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, POLL_DURATION_MS, VOTE_REFILL_MS } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1452 (ADR 0055): polls landed after the Rust switch, so only the Rust server implements them; the frozen TS one
// ignores poll-open, vote and poll-close. Every test here runs against the binary only.
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
async function join(nickname: string, extra: Record<string, unknown> = {}, roomId?: string) {
  const client = await Client.open((t ?? fail()).ws(roomId));
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...extra });
  return { client, snapshot: await client.next("snapshot") };
}
async function ownRoom() {
  const res = await fetch(`${(t ?? fail()).http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Polls", visibility: "public" }) });
  const created = v.parse(CreateRoomResponseSchema, await res.json());
  if (!created.ok) throw new Error("create failed");
  const owner = await join("alice", { ownerToken: created.ownerToken }, created.room.id);
  return { id: created.room.id, owner };
}

const OPEN = { type: "poll-open", question: "Next video?", options: ["A", "B", "C"] };

describe("polls (OME-1452)", () => {
  binaryOnly("poll-open reaches everyone with zero counts and a 60 s deadline; a late joiner's snapshot carries it", async () => {
    const clock = new TestClock();
    t = start({ now: clock.now, wallNow: clock.wallNow });
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ ...OPEN, question: "  Next video? " });
    for (const c of [a.client, b.client]) {
      const poll = await c.next("poll");
      expect(poll).toMatchObject({ by: a.snapshot.self, question: "Next video?", options: ["A", "B", "C"], counts: [0, 0, 0], endsAt: clock.wall + POLL_DURATION_MS });
    }
    const late = await join("carol");
    expect(late.snapshot.poll).toMatchObject({ question: "Next video?", counts: [0, 0, 0] });
  });

  binaryOnly("the bounds and the chat character rules: anything else is a bad_message and opens nothing", async () => {
    t = start();
    const a = await join("alice");
    const bad: unknown[] = [
      { question: "", options: ["A", "B"] },
      { question: "q".repeat(81), options: ["A", "B"] },
      { question: "Next?", options: ["A"] },
      { question: "Next?", options: ["A", "B", "C", "D", "E"] },
      { question: "Next?", options: ["A", "x".repeat(41)] },
      { question: "ㅤㅤ", options: ["A", "B"] },
      { question: "Next?", options: ["A", "ㅤ"] },
      { question: "a‮b", options: ["A", "B"] },
    ];
    for (const msg of bad) {
      a.client.send({ type: "poll-open", ...(msg as object) });
      expect((await a.client.next("error")).code).toBe("bad_message");
    }
    await a.client.none("poll", 100);
    a.client.send({ ...OPEN, question: "q".repeat(80), options: ["x".repeat(40), "y", "z", "w"] });
    expect((await a.client.next("poll")).options).toHaveLength(4);
  });

  binaryOnly("one poll per room: a second poll-open is a bad_message, from anyone", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send(OPEN);
    await b.client.next("poll");
    for (const c of [b.client, a.client]) {
      c.send({ ...OPEN, question: "Another?" });
      expect((await c.next("error")).code).toBe("bad_message");
    }
    await b.client.none("poll", 100);
  });

  binaryOnly("a member votes once and can change the vote; an option the poll lacks is a bad_message", async () => {
    const clock = new TestClock();
    t = start({ now: clock.now, wallNow: clock.wallNow });
    const a = await join("alice");
    const b = await join("bob");
    a.client.send(OPEN);
    const { pollId } = await b.client.next("poll");
    await a.client.next("poll");
    b.client.send({ type: "vote", pollId, option: 1 });
    expect((await a.client.next("poll")).counts).toEqual([0, 1, 0]);
    a.client.send({ type: "vote", pollId, option: 1 });
    expect((await a.client.next("poll")).counts).toEqual([0, 2, 0]);
    await clock.set({ mono: clock.mono + VOTE_REFILL_MS });
    b.client.send({ type: "vote", pollId, option: 2 });
    expect((await a.client.next("poll")).counts).toEqual([0, 1, 1]);
    // The same vote again changes nothing and sends nothing.
    b.client.send({ type: "vote", pollId, option: 2 });
    await a.client.none("poll", 100);
    await clock.set({ mono: clock.mono + VOTE_REFILL_MS });
    b.client.send({ type: "vote", pollId, option: 3 });
    expect((await b.client.next("error")).code).toBe("bad_message");
    await a.client.none("poll", 100);
  });

  binaryOnly("a member who leaves takes their vote along", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send(OPEN);
    const { pollId } = await b.client.next("poll");
    await a.client.next("poll");
    b.client.send({ type: "vote", pollId, option: 0 });
    expect((await a.client.next("poll")).counts).toEqual([1, 0, 0]);
    b.client.send({ type: "leave" });
    expect((await a.client.next("poll")).counts).toEqual([0, 0, 0]);
    await a.client.next("member-left");
  });

  binaryOnly("closes itself after 60 s on the test clock; a later vote is dropped silently", async () => {
    const clock = new TestClock();
    t = start({ now: clock.now, wallNow: clock.wallNow });
    const a = await join("alice");
    a.client.send(OPEN);
    const { pollId } = await a.client.next("poll");
    a.client.send({ type: "vote", pollId, option: 2 });
    await a.client.next("poll");
    await clock.set({ mono: clock.mono + POLL_DURATION_MS - 1, wall: clock.wall + POLL_DURATION_MS - 1 });
    await a.client.none("poll-closed", 100);
    await clock.set({ mono: clock.mono + 1, wall: clock.wall + 1 });
    expect(await a.client.next("poll-closed")).toMatchObject({ pollId, counts: [0, 0, 1] });
    await clock.set({ mono: clock.mono + VOTE_REFILL_MS });
    a.client.send({ type: "vote", pollId, option: 0 });
    await a.client.none("poll", 100);
    await a.client.none("error", 100);
    const late = await join("bob");
    expect(late.snapshot.poll).toBeUndefined();
    // The room is free for the next one.
    a.client.send(OPEN);
    expect((await a.client.next("poll")).pollId).not.toBe(pollId);
  });

  binaryOnly("poll-close: the opener or the room owner may close it, nobody else", async () => {
    t = start();
    const { id, owner } = await ownRoom();
    const b = await join("bob", {}, id);
    const c = await join("carol", {}, id);
    b.client.send(OPEN);
    const first = await owner.client.next("poll");
    c.client.send({ type: "poll-close", pollId: first.pollId });
    expect((await c.client.next("error")).code).toBe("not_owner");
    b.client.send({ type: "poll-close", pollId: first.pollId });
    expect(await c.client.next("poll-closed")).toMatchObject({ pollId: first.pollId, counts: [0, 0, 0] });
    await b.client.next("poll-closed");
    // A stale id is dropped silently.
    b.client.send({ type: "poll-close", pollId: first.pollId });
    await b.client.none("error", 100);
    c.client.send(OPEN);
    const second = await b.client.next("poll");
    owner.client.send({ type: "poll-close", pollId: second.pollId });
    expect((await b.client.next("poll-closed")).pollId).toBe(second.pollId);
  });

  binaryOnly("poll-open takes from the chat bucket; votes have their own 2/s bucket", async () => {
    t = start();
    const a = await join("alice");
    for (let i = 0; i < 4; i++) a.client.send({ type: "chat", text: "hi" });
    a.client.send(OPEN);
    const { pollId } = await a.client.next("poll");
    a.client.send({ type: "chat", text: "one too many" });
    expect((await a.client.next("error")).code).toBe("rate_limited");
    // The chat bucket is empty, the vote bucket is not: 2 votes pass, the 3rd is rate_limited.
    a.client.send({ type: "vote", pollId, option: 0 });
    a.client.send({ type: "vote", pollId, option: 1 });
    expect((await a.client.next("poll")).counts).toEqual([1, 0, 0]);
    expect((await a.client.next("poll")).counts).toEqual([0, 1, 0]);
    a.client.send({ type: "vote", pollId, option: 2 });
    const error = await a.client.next("error");
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  binaryOnly("before join it is not_joined; a muted member's poll-open is answered muted", async () => {
    t = start();
    const early = await Client.open(t.ws());
    clients.push(early);
    early.send(OPEN);
    expect((await early.next("error")).code).toBe("not_joined");
    const { id, owner } = await ownRoom();
    const b = await join("bob", {}, id);
    owner.client.send({ type: "mute", memberId: b.snapshot.self, muted: true });
    await b.client.next("member-muted");
    b.client.send(OPEN);
    expect((await b.client.next("error")).code).toBe("muted");
    await owner.client.none("poll", 100);
  });
});
