import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ACCESSORY_COUNT, CreateRoomResponseSchema, EMOTE_BURST, TYPING_BURST, TYPING_REFILL_MS, TYPING_TIMEOUT_MS } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1387 (ADR 0053 amendment): the typing indicator and the avatar accessory landed after the Rust switch, so only
// the Rust server implements them; the frozen TS one ignores both types. Every test here runs against the binary only.
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

describe("typing (OME-1387)", () => {
  binaryOnly("on is relayed to everyone once; a refresh relays nothing; a late joiner's snapshot has no typing", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "typing", on: true });
    for (const c of [a.client, b.client]) expect(await c.next("typing-changed")).toEqual({ type: "typing-changed", memberId: a.snapshot.self, on: true });
    a.client.send({ type: "typing", on: true });
    await b.client.none("typing-changed", 100);
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)).not.toHaveProperty("typing");
  });

  binaryOnly(`on times out after ${String(TYPING_TIMEOUT_MS)} ms without a refresh; a refresh restarts the wait`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "typing", on: true });
    await b.client.next("typing-changed");
    await clock.set({ mono: clock.mono + TYPING_TIMEOUT_MS - 1000 });
    a.client.send({ type: "typing", on: true });
    await a.client.none("typing-changed", 100);
    await clock.set({ mono: clock.mono + TYPING_TIMEOUT_MS - 1 });
    await b.client.none("typing-changed", 100);
    await clock.set({ mono: clock.mono + 1 });
    expect(await b.client.next("typing-changed")).toEqual({ type: "typing-changed", memberId: a.snapshot.self, on: false });
  });

  binaryOnly("a chat line clears it first: typing-changed off, then the chat", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "typing", on: true });
    await b.client.next("typing-changed");
    a.client.send({ type: "chat", text: "hi" });
    expect(await b.client.next("typing-changed")).toEqual({ type: "typing-changed", memberId: a.snapshot.self, on: false });
    expect((await b.client.next("chat")).text).toBe("hi");
  });

  binaryOnly("leaving clears it: member-left, and no typing-changed after the timeout", async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "typing", on: true });
    await b.client.next("typing-changed");
    a.client.send({ type: "leave" });
    expect((await b.client.next("member-left")).memberId).toBe(a.snapshot.self);
    await clock.set({ mono: clock.mono + TYPING_TIMEOUT_MS });
    await b.client.none("typing-changed", 100);
  });

  binaryOnly(`a burst of ${String(TYPING_BURST)} relays, the next is dropped silently, a refill restores one`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "typing", on: true });
    a.client.send({ type: "typing", on: false });
    a.client.send({ type: "typing", on: true });
    expect((await b.client.next("typing-changed")).on).toBe(true);
    expect((await b.client.next("typing-changed")).on).toBe(false);
    await b.client.none("typing-changed", 100);
    await a.client.none("error", 0);
    await clock.set({ mono: clock.mono + TYPING_REFILL_MS });
    a.client.send({ type: "typing", on: true });
    expect((await b.client.next("typing-changed")).on).toBe(true);
    expect(a.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  binaryOnly("before join it is not_joined; muting clears it, and a muted member's typing reaches nobody", async () => {
    t = start();
    const early = await Client.open(t.ws());
    clients.push(early);
    early.send({ type: "typing", on: true });
    expect((await early.next("error")).code).toBe("not_joined");

    const res = await fetch(`${t.http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Typing", visibility: "public" }) });
    const created = v.parse(CreateRoomResponseSchema, await res.json());
    if (!created.ok) throw new Error("create failed");
    const owner = await join("alice", { ownerToken: created.ownerToken }, created.room.id);
    const b = await join("bob", {}, created.room.id);
    b.client.send({ type: "typing", on: true });
    await owner.client.next("typing-changed");
    owner.client.send({ type: "mute", memberId: b.snapshot.self, muted: true });
    await owner.client.next("member-muted");
    expect(await owner.client.next("typing-changed")).toEqual({ type: "typing-changed", memberId: b.snapshot.self, on: false });
    b.client.send({ type: "typing", on: true });
    await owner.client.none("typing-changed", 100);
  });
});

describe("accessory (OME-1387)", () => {
  binaryOnly("join sets it, set-accessory changes it for everyone, the snapshot carries it", async () => {
    t = start();
    const a = await join("alice", { accessory: 3 });
    expect(a.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.accessory).toBe(3);
    const b = await join("bob");
    expect(b.snapshot.room.members.find((m) => m.id === b.snapshot.self)?.accessory).toBeUndefined();
    b.client.send({ type: "set-accessory", accessory: ACCESSORY_COUNT - 1 });
    for (const c of [a.client, b.client]) expect(await c.next("accessory-changed")).toEqual({ type: "accessory-changed", memberId: b.snapshot.self, accessory: ACCESSORY_COUNT - 1 });
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === b.snapshot.self)?.accessory).toBe(ACCESSORY_COUNT - 1);
  });

  binaryOnly("out of bounds is bad_message on set-accessory and on join; nothing is relayed", async () => {
    t = start();
    const a = await join("alice");
    for (const accessory of [ACCESSORY_COUNT, -1, 1.5]) {
      a.client.send({ type: "set-accessory", accessory });
      expect((await a.client.next("error")).code).toBe("bad_message");
    }
    await a.client.none("accessory-changed", 100);
    const late = await Client.open(t.ws());
    clients.push(late);
    late.send({ type: "join", nickname: "bob", avatar: 0, accessory: ACCESSORY_COUNT });
    expect((await late.next("error")).code).toBe("bad_message");
  });

  binaryOnly(`set-accessory shares the emote bucket: ${String(EMOTE_BURST)} changes relay, the next is rate_limited`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    for (let i = 0; i <= EMOTE_BURST; i++) a.client.send({ type: "set-accessory", accessory: 1 + (i % 2) });
    for (let i = 0; i < EMOTE_BURST; i++) await a.client.next("accessory-changed");
    expect((await a.client.next("error")).code).toBe("rate_limited");
    await a.client.none("accessory-changed", 100);
  });
});
