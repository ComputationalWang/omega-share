import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CLOSE_CODES, EMOTE_BURST, EMOTE_REFILL_MS } from "@omega/shared";
import type { RoomPersistence } from "../src/server";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client, start, type TestServer } from "./helpers";

/** `emote` → `emoted` fan-out with the per-member bucket (C2 constants; OME-413, OME-414). */

let t: TestServer | null = null;
let db: Database | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
  db?.close();
  db = null;
});

function fail(): never {
  throw new Error("no server");
}
async function join(nickname: string) {
  const r = await Client.join((t ?? fail()).ws(), nickname);
  clients.push(r.client);
  return r;
}
/** A clock the test moves by hand (ms), handed to the server's limiters so no test sleeps for a refill. */
function fakeClock() {
  const clock = { ms: 1_000_000, now: () => clock.ms };
  return clock;
}

describe("emote relay", () => {
  test("an emote is relayed as emoted to the whole room, sender included", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "emote", kind: "heart" });
    for (const c of [a.client, b.client]) {
      const emoted = await c.next("emoted");
      expect(emoted).toEqual({ type: "emoted", memberId: a.snapshot.self, kind: "heart" });
    }
    b.client.send({ type: "emote", kind: "wave" });
    expect(await a.client.next("emoted")).toEqual({ type: "emoted", memberId: b.snapshot.self, kind: "wave" });
  });

  test("an emote before join gets not_joined and reaches nobody", async () => {
    t = start();
    const b = await join("bob");
    const stranger = await Client.open(t.ws());
    clients.push(stranger);
    stranger.send({ type: "emote", kind: "clap" });
    expect((await stranger.next("error")).code).toBe("not_joined");
    await b.client.none("emoted", 50);
  });

  test("an emote isn't in a late joiner's snapshot", async () => {
    t = start();
    const a = await join("alice");
    a.client.send({ type: "emote", kind: "laugh" });
    await a.client.next("emoted");
    const late = await join("late");
    expect(JSON.stringify(late.snapshot)).not.toContain("laugh");
    await late.client.none("emoted", 50);
  });
});

describe("emote limits", () => {
  test(`a burst of ${String(EMOTE_BURST)} relays, the next gets rate_limited with retryAfterMs ${String(EMOTE_REFILL_MS)} and isn't relayed, a refill restores one`, async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    for (let i = 0; i < EMOTE_BURST; i++) a.client.send({ type: "emote", kind: "clap" });
    for (let i = 0; i < EMOTE_BURST; i++) await b.client.next("emoted");
    a.client.send({ type: "emote", kind: "exclaim" });
    const refused = await a.client.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(EMOTE_REFILL_MS);
    await b.client.none("emoted", 50);
    clock.ms += EMOTE_REFILL_MS;
    a.client.send({ type: "emote", kind: "question" });
    expect((await b.client.next("emoted")).kind).toBe("question");
    a.client.send({ type: "emote", kind: "question" });
    expect((await a.client.next("error")).code).toBe("rate_limited");
  });

  test("each member has their own bucket", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    for (let i = 0; i < EMOTE_BURST; i++) a.client.send({ type: "emote", kind: "clap" });
    for (let i = 0; i < EMOTE_BURST; i++) {
      await a.client.next("emoted");
      await b.client.next("emoted");
    }
    b.client.send({ type: "emote", kind: "heart" });
    expect(await a.client.next("emoted")).toEqual({ type: "emoted", memberId: b.snapshot.self, kind: "heart" });
  });

  test("dropped emotes count toward the flood close: 50 in a row close with 4029", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    // 3 pass, then 50 drops (emote bucket, then L1) with no clock movement.
    for (let i = 0; i < EMOTE_BURST + 50; i++) a.client.send({ type: "emote", kind: "clap" });
    expect((await a.client.closed).code).toBe(CLOSE_CODES.RATE_LIMITED);
  });

  test("emotes never touch the store", async () => {
    db = openDatabase(":memory:");
    const real = new RoomStore(db);
    const calls: string[] = [];
    const store: RoomPersistence = {
      listRooms: () => real.listRooms(),
      createRoom: (...args) => {
        calls.push("createRoom");
        real.createRoom(...args);
      },
      deleteRoom: (...args) => {
        calls.push("deleteRoom");
        return real.deleteRoom(...args);
      },
      setEmbed: (...args) => {
        calls.push("setEmbed");
        real.setEmbed(...args);
      },
      setLayout: (...args) => {
        calls.push("setLayout");
        real.setLayout(...args);
      },
      setTitle: (...args) => {
        calls.push("setTitle");
        real.setTitle(...args);
      },
      setLastActive: (...args) => {
        calls.push("setLastActive");
        real.setLastActive(...args);
      },
      setControlPolicy: (...args) => {
        calls.push("setControlPolicy");
        real.setControlPolicy(...args);
      },
      addQueueItem: (...args) => {
        calls.push("addQueueItem");
        real.addQueueItem(...args);
      },
      removeQueueItem: (...args) => {
        calls.push("removeQueueItem");
        return real.removeQueueItem(...args);
      },
      advanceQueue: (...args) => {
        calls.push("advanceQueue");
        real.advanceQueue(...args);
      },
      addQueueItemAndStart: (...args) => {
        calls.push("addQueueItemAndStart");
        real.addQueueItemAndStart(...args);
      },
    };
    t = start({ store });
    const a = await join("alice");
    const b = await join("bob");
    const before = calls.length;
    for (let i = 0; i < EMOTE_BURST; i++) a.client.send({ type: "emote", kind: "heart" });
    for (let i = 0; i < EMOTE_BURST; i++) await b.client.next("emoted");
    expect(calls.slice(before)).toEqual([]);
  });
});
