import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, DEFAULT_LAYOUT, WALK_BURST } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1499 (ADR 0053 amendment): floor sit and room mood landed after the Rust switch, so only the Rust server
// implements them; the frozen TS one ignores floor-sit. Every test here runs against the binary only.
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
  const res = await fetch(`${(t ?? fail()).http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Moods", visibility: "public" }) });
  const created = v.parse(CreateRoomResponseSchema, await res.json());
  if (!created.ok) throw new Error("create failed");
  const owner = await join("alice", { ownerToken: created.ownerToken }, created.room.id);
  return { id: created.room.id, owner };
}

describe("floor sit (OME-1499)", () => {
  binaryOnly("on a cell it is relayed as floor-sat to everyone and lands in the snapshot; the current value is a no-op", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "walk", cell: { x: 3, y: 3 } });
    await b.client.next("walked");
    a.client.send({ type: "floor-sit", on: true });
    for (const c of [a.client, b.client]) expect(await c.next("floor-sat")).toEqual({ type: "floor-sat", memberId: a.snapshot.self, on: true });
    a.client.send({ type: "floor-sit", on: true });
    await b.client.none("floor-sat", 100);
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.floorSit).toBe(true);
    a.client.send({ type: "floor-sit", on: false });
    expect(await b.client.next("floor-sat")).toEqual({ type: "floor-sat", memberId: a.snapshot.self, on: false });
  });

  binaryOnly("while seated, or before standing on a cell, it is bad_cell and nothing is relayed", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "floor-sit", on: true });
    expect((await a.client.next("error")).code).toBe("bad_cell");
    a.client.send({ type: "sit", seat: 2 });
    await b.client.next("seat-changed");
    a.client.send({ type: "floor-sit", on: true });
    expect((await a.client.next("error")).code).toBe("bad_cell");
    await b.client.none("floor-sat", 100);
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)).not.toHaveProperty("floorSit");
  });

  binaryOnly("a walk clears it (floor-sat false, then walked); so does a sit", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "walk", cell: { x: 3, y: 3 } });
    await b.client.next("walked");
    a.client.send({ type: "floor-sit", on: true });
    await b.client.next("floor-sat");
    a.client.send({ type: "walk", cell: { x: 4, y: 4 } });
    expect(await b.client.next("floor-sat")).toEqual({ type: "floor-sat", memberId: a.snapshot.self, on: false });
    expect((await b.client.next("walked")).cell).toEqual({ x: 4, y: 4 });
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)).not.toHaveProperty("floorSit");
    a.client.send({ type: "floor-sit", on: true });
    await b.client.next("floor-sat");
    a.client.send({ type: "sit", seat: 2 });
    expect(await b.client.next("floor-sat")).toEqual({ type: "floor-sat", memberId: a.snapshot.self, on: false });
    expect((await b.client.next("seat-changed")).seat).toBe(2);
  });

  binaryOnly("before join it is not_joined; a non-boolean on is bad_message", async () => {
    t = start();
    const early = await Client.open(t.ws());
    clients.push(early);
    early.send({ type: "floor-sit", on: true });
    expect((await early.next("error")).code).toBe("not_joined");
    const a = await join("alice");
    a.client.send({ type: "floor-sit", on: "yes" });
    expect((await a.client.next("error")).code).toBe("bad_message");
  });

  binaryOnly(`it shares the walk bucket: after ${String(WALK_BURST)} walks it is dropped silently`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    for (let i = 0; i < WALK_BURST; i++) a.client.send({ type: "walk", cell: { x: 3, y: i % 2 === 0 ? 3 : 4 } });
    for (let i = 0; i < WALK_BURST; i++) await b.client.next("walked");
    a.client.send({ type: "floor-sit", on: true });
    await b.client.none("floor-sat", 100);
    await a.client.none("error", 0);
  });
});

describe("room mood (OME-1499)", () => {
  binaryOnly("the owner sets it with layout-set; it is relayed and lands in the snapshot; absent means none", async () => {
    t = start();
    const { id, owner } = await ownRoom();
    expect(owner.snapshot.room.layout?.mood).toBeUndefined();
    owner.client.send({ type: "layout-set", layout: { ...DEFAULT_LAYOUT, mood: "night" } });
    expect((await owner.client.next("layout-changed")).layout.mood).toBe("night");
    const late = await join("bob", {}, id);
    expect(late.snapshot.room.layout?.mood).toBe("night");
  });

  binaryOnly("a bad mood is bad_message and changes nothing", async () => {
    t = start();
    const { owner } = await ownRoom();
    for (const mood of ["dark", "Night", "", null, 1]) {
      owner.client.send({ type: "layout-set", layout: { ...DEFAULT_LAYOUT, mood } });
      expect((await owner.client.next("error")).code).toBe("bad_message");
    }
    await owner.client.none("layout-changed", 100);
  });

  binaryOnly("a non-owner's layout-set with a mood is not_owner and changes nothing", async () => {
    t = start();
    const { id, owner } = await ownRoom();
    const guest = await join("bob", {}, id);
    guest.client.send({ type: "layout-set", layout: { ...DEFAULT_LAYOUT, mood: "warm" } });
    expect((await guest.client.next("error")).code).toBe("not_owner");
    await owner.client.none("layout-changed", 100);
    const late = await join("carol", {}, id);
    expect(late.snapshot.room.layout?.mood).toBeUndefined();
  });
});
