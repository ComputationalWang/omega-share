import { afterEach, describe, expect, test } from "bun:test";
import { MAX_ROOM_MEMBERS, parseServerMessage, type ServerMessage } from "@omega/shared";
import { Client, start, type TestServer } from "./helpers";

// ADR 0019: `status { catching }` is advisory state, relayed as `member-status`, at most one per member per interval.

let t: TestServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = undefined;
});

async function join(server: TestServer, nickname: string) {
  const r = await Client.join(server.ws(), nickname);
  clients.push(r.client);
  return r;
}

type MemberStatus = Extract<ServerMessage, { type: "member-status" }>;
/** Every `member-status` this client has received so far, in order. */
function statuses(c: Client): MemberStatus[] {
  const out: MemberStatus[] = [];
  for (const raw of c.raw) {
    const msg = parseServerMessage(raw);
    if (msg?.type === "member-status") out.push(msg);
  }
  return out;
}

describe("member-status relay", () => {
  test("status is published to the whole room, the sender included", async () => {
    t = start();
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    expect(await b.client.next("member-status")).toEqual({ type: "member-status", memberId: a.snapshot.self, catching: true });
    expect(await a.client.next("member-status")).toEqual({ type: "member-status", memberId: a.snapshot.self, catching: true });
  });

  test("a repeated value is not published again", async () => {
    t = start({ statusIntervalMs: 20 });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    await Bun.sleep(40);
    a.client.send({ type: "status", catching: true });
    await b.client.none("member-status", 100);
  });

  test("status before join is refused with not_joined", async () => {
    t = start();
    const c = await Client.open(t.ws());
    clients.push(c);
    c.send({ type: "status", catching: true });
    expect((await c.next("error")).code).toBe("not_joined");
  });

  test("a late joiner's snapshot carries the current catching state", async () => {
    t = start({ statusIntervalMs: 20 });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    const c = await join(t, "carol");
    const members = new Map(c.snapshot.room.members.map((m) => [m.id, m]));
    expect(members.get(a.snapshot.self)?.catching).toBe(true);
    expect(members.get(b.snapshot.self)?.catching ?? false).toBe(false);

    await Bun.sleep(40);
    a.client.send({ type: "status", catching: false });
    await b.client.next("member-status");
    const d = await join(t, "dave");
    expect(d.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.catching ?? false).toBe(false);
  });

  test("the snapshot's catching is current even while the published value is still coalescing", async () => {
    t = start({ statusIntervalMs: 500 });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    a.client.send({ type: "status", catching: false });
    const c = await join(t, "carol");
    expect(c.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.catching ?? false).toBe(false);
  });

  test("a flipping member is coalesced to one publish per interval, and the final value always arrives", async () => {
    t = start({ statusIntervalMs: 200 });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    a.client.send({ type: "status", catching: false });
    a.client.send({ type: "status", catching: true });
    a.client.send({ type: "status", catching: false });
    await Bun.sleep(100);
    // Inside the interval: only the leading publish so far.
    expect(statuses(b.client).map((s) => s.catching)).toEqual([true]);
    await Bun.sleep(250);
    // The trailing edge delivers the latest value, once.
    expect(statuses(b.client).map((s) => s.catching)).toEqual([true, false]);
  });

  test("a flip back to the published value inside the interval publishes nothing", async () => {
    t = start({ statusIntervalMs: 150 });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    a.client.send({ type: "status", catching: false });
    a.client.send({ type: "status", catching: true });
    await Bun.sleep(300);
    expect(statuses(b.client).map((s) => s.catching)).toEqual([true]);
  });

  test("leaving takes the flag along: member-left, no member-status, and a rejoin starts at false", async () => {
    t = start({ statusIntervalMs: 150 });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    // A trailing publish is pending when alice leaves; it must not fire.
    a.client.send({ type: "status", catching: false });
    a.client.send({ type: "leave" });
    expect((await b.client.next("member-left")).memberId).toBe(a.snapshot.self);
    await b.client.none("member-status", 250);

    a.client.send({ type: "join", nickname: "alice", avatar: 0 });
    const again = await a.client.next("snapshot");
    expect(again.room.members.find((m) => m.id === again.self)?.catching ?? false).toBe(false);
    // A fresh member publishes immediately, whatever the old member's interval was.
    a.client.send({ type: "status", catching: true });
    expect(await b.client.next("member-status", 100)).toEqual({ type: "member-status", memberId: again.self, catching: true });
  });

  test("a member who disconnects while catching is gone from the next snapshot", async () => {
    t = start();
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "status", catching: true });
    await b.client.next("member-status");
    a.client.close();
    await b.client.next("member-left");
    const c = await join(t, "carol");
    expect(c.snapshot.room.members.map((m) => m.id)).not.toContain(a.snapshot.self);
    await b.client.none("member-status", 100);
  });

  test("a status flood hits the per-socket limit with rate_limited and retryAfterMs", async () => {
    t = start();
    const a = await join(t, "alice");
    for (let i = 0; i < 40; i++) a.client.send({ type: "status", catching: i % 2 === 0 });
    const err = await a.client.next("error");
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });

  test(`relay stays within 50 ms at p95 with ${String(MAX_ROOM_MEMBERS)} members toggling`, async () => {
    const intervalMs = 60;
    t = start({ statusIntervalMs: intervalMs });
    const server = t;
    const members = await Promise.all(Array.from({ length: MAX_ROOM_MEMBERS }, (_, i) => join(server, `m${String(i)}`)));
    const latencies: number[] = [];
    const rounds = 6;
    for (let round = 0; round < rounds; round++) {
      const catching = round % 2 === 0;
      const sentAt = new Map<string, number>();
      const pending = members.map(async (receiver) => {
        const seen = new Set<string>();
        while (seen.size < members.length) {
          const msg = await receiver.client.next("member-status");
          if (msg.catching !== catching || seen.has(msg.memberId)) continue;
          seen.add(msg.memberId);
          latencies.push(performance.now() - (sentAt.get(msg.memberId) ?? Number.NaN));
        }
      });
      for (const m of members) {
        sentAt.set(m.snapshot.self, performance.now());
        m.client.send({ type: "status", catching });
      }
      await Promise.all(pending);
      await Bun.sleep(intervalMs + 10);
    }
    expect(latencies.length).toBe(rounds * MAX_ROOM_MEMBERS * MAX_ROOM_MEMBERS);
    latencies.sort((x, y) => x - y);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    console.log(`member-status relay, ${String(MAX_ROOM_MEMBERS)} members toggling: p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThanOrEqual(50);
  }, 20_000);
});
