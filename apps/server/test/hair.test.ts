import { afterEach, describe, expect, test } from "bun:test";
import { EMOTE_BURST, HAIR_COUNT } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1435 (ADR 0053 amendment): hair colour landed after the Rust switch, so only the Rust server implements it;
// the frozen TS one ignores set-hair. Every test here runs against the binary only.
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
async function join(nickname: string, extra: Record<string, unknown> = {}) {
  const client = await Client.open((t ?? fail()).ws());
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...extra });
  return { client, snapshot: await client.next("snapshot") };
}

describe("hair (OME-1435)", () => {
  binaryOnly("join sets it, set-hair changes it for everyone, the snapshot carries it; absent is the default", async () => {
    t = start();
    const a = await join("alice", { hair: 3 });
    expect(a.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.hair).toBe(3);
    const b = await join("bob", { hair: 0 });
    expect(b.snapshot.room.members.find((m) => m.id === b.snapshot.self)).not.toHaveProperty("hair");
    b.client.send({ type: "set-hair", hair: HAIR_COUNT - 1 });
    for (const c of [a.client, b.client]) expect(await c.next("hair-changed")).toEqual({ type: "hair-changed", memberId: b.snapshot.self, hair: HAIR_COUNT - 1 });
    b.client.send({ type: "set-hair", hair: HAIR_COUNT - 1 });
    await a.client.none("hair-changed", 100);
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === b.snapshot.self)?.hair).toBe(HAIR_COUNT - 1);
  });

  binaryOnly("out of bounds is bad_message on set-hair and on join; nothing is relayed", async () => {
    t = start();
    const a = await join("alice");
    for (const hair of [HAIR_COUNT, -1, 1.5]) {
      a.client.send({ type: "set-hair", hair });
      expect((await a.client.next("error")).code).toBe("bad_message");
    }
    await a.client.none("hair-changed", 100);
    const late = await Client.open(t.ws());
    clients.push(late);
    late.send({ type: "join", nickname: "bob", avatar: 0, hair: HAIR_COUNT });
    expect((await late.next("error")).code).toBe("bad_message");
  });

  binaryOnly("before join it is not_joined; a resume keeps the hair", async () => {
    t = start();
    const early = await Client.open(t.ws());
    clients.push(early);
    early.send({ type: "set-hair", hair: 1 });
    expect((await early.next("error")).code).toBe("not_joined");
    const a = await join("alice", { durableSession: true, hair: 2 });
    const b = await join("bob");
    a.client.socket.close();
    expect(await b.client.next("member-presence", 3000)).toEqual({ type: "member-presence", memberId: a.snapshot.self, away: true });
    const token = a.snapshot.resumeToken ?? fail();
    const r = await Client.open(t.ws());
    clients.push(r);
    r.send({ type: "join", nickname: "x", avatar: 1, resumeToken: token });
    const snap = await r.next("snapshot");
    expect(snap.room.members.find((m) => m.id === a.snapshot.self)?.hair).toBe(2);
  });

  binaryOnly(`set-hair shares the emote bucket: ${String(EMOTE_BURST)} changes relay, the next is rate_limited`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    for (let i = 0; i <= EMOTE_BURST; i++) a.client.send({ type: "set-hair", hair: 1 + (i % 2) });
    for (let i = 0; i < EMOTE_BURST; i++) await a.client.next("hair-changed");
    expect((await a.client.next("error")).code).toBe("rate_limited");
    await a.client.none("hair-changed", 100);
  });
});
