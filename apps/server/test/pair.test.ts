import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, DEFAULT_LAYOUT, PAIR_INVITE_TTL_MS } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1672 (OME-1671 contract): /thrust and /bendover landed after the Rust switch, so only the Rust server
// implements them; the frozen TS one answers neither. Every test here runs against the binary only.
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
async function join(nickname: string, extra: Record<string, unknown>, roomId: string) {
  const client = await Client.open((t ?? fail()).ws(roomId));
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...extra });
  return { client, snapshot: await client.next("snapshot") };
}
type Member = Awaited<ReturnType<typeof join>>;

/** A room with the pair switched on (or not), its owner, and two guests, alice and bob. */
async function setup(pairs: boolean, furniture = DEFAULT_LAYOUT.furniture, opts: Parameters<typeof start>[0] = {}) {
  t = start(opts);
  const res = await fetch(`${t.http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pairs", visibility: "public" }) });
  const created = v.parse(CreateRoomResponseSchema, await res.json());
  if (!created.ok) throw new Error("create failed");
  const owner = await join("owner", { ownerToken: created.ownerToken }, created.room.id);
  if (pairs) {
    owner.client.send({ type: "layout-set", layout: { furniture, pairs: true } });
    await owner.client.next("layout-changed");
  }
  const a = await join("alice", {}, created.room.id);
  const b = await join("bob", {}, created.room.id);
  return { a, b, owner };
}
/** Walks `m` through `cells`; the last step's direction is where they face (server side: the dominant axis of it). */
async function stand(m: Member, ...cells: [number, number][]) {
  for (const [x, y] of cells) {
    m.client.send({ type: "walk", cell: { x, y } });
    for (const c of clients) await c.next("walked");
  }
}
/** `m` sends an invite; every socket has seen the pair-invited before this returns, so the next `next` is about what follows. */
async function invite(m: Member, pose: "thrust" | "bendover") {
  m.client.send({ type: "pair", pose });
  for (const c of clients) await c.next("pair-invited");
}

describe("pairs (OME-1672)", () => {
  binaryOnly("without pairs on the layout, pair is pairs_off and nothing is relayed", async () => {
    const { a, b } = await setup(false);
    a.client.send({ type: "pair", pose: "thrust" });
    expect((await a.client.next("error")).code).toBe("pairs_off");
    await b.client.none("pair-invited", 100);
  });

  binaryOnly("an invite is relayed as pair-invited to the whole room, sender included", async () => {
    const { a, b } = await setup(true);
    a.client.send({ type: "pair", pose: "thrust" });
    for (const c of [a.client, b.client]) expect(await c.next("pair-invited")).toEqual({ type: "pair-invited", memberId: a.snapshot.self, pose: "thrust" });
  });

  binaryOnly("a match stands the inviter up, teleports them behind the sender, then paired", async () => {
    const { a, b } = await setup(true);
    await stand(b, [5, 5], [4, 5]);
    a.client.send({ type: "sit", seat: 2 });
    for (const c of clients) await c.next("seat-changed");
    await invite(a, "thrust");
    b.client.send({ type: "pair", pose: "bendover" });
    expect(await a.client.next("seat-changed")).toEqual({ type: "seat-changed", memberId: a.snapshot.self, seat: null });
    expect(await a.client.next("walked")).toMatchObject({ memberId: a.snapshot.self, cell: { x: 5, y: 5 }, teleport: true });
    expect(await a.client.next("paired")).toEqual({ type: "paired", thrust: a.snapshot.self, bendover: b.snapshot.self });
  });

  binaryOnly("a floor-sitting inviter gets floor-sat false first", async () => {
    const { a, b } = await setup(true);
    await stand(b, [5, 5], [4, 5]);
    await stand(a, [8, 8]);
    a.client.send({ type: "floor-sit", on: true });
    await a.client.next("floor-sat");
    await invite(a, "thrust");
    b.client.send({ type: "pair", pose: "bendover" });
    expect(await a.client.next("floor-sat")).toEqual({ type: "floor-sat", memberId: a.snapshot.self, on: false });
    expect((await a.client.next("walked")).cell).toEqual({ x: 5, y: 5 });
    await a.client.next("paired");
  });

  binaryOnly("with the cell behind blocked, the nearest free neighbour (east, south, west, north) is used", async () => {
    // (5,5) is a table and (4,6) an armchair: west, (3,5), is the first free one.
    const furniture = [...DEFAULT_LAYOUT.furniture, { kind: "sidetable" as const, col: 5, row: 5, facing: "se" as const }];
    const { a, b } = await setup(true, furniture);
    await stand(b, [6, 5], [4, 5]);
    await invite(a, "thrust");
    b.client.send({ type: "pair", pose: "bendover" });
    expect((await a.client.next("walked")).cell).toEqual({ x: 3, y: 5 });
    await a.client.next("paired");
  });

  binaryOnly("with no free cell (the sender is seated) the sender gets bad_cell and the invite stays", async () => {
    const { a, b } = await setup(true);
    b.client.send({ type: "sit", seat: 2 });
    for (const c of clients) await c.next("seat-changed");
    await invite(a, "thrust");
    b.client.send({ type: "pair", pose: "bendover" });
    expect((await b.client.next("error")).code).toBe("bad_cell");
    await a.client.none("paired", 100);
    await stand(b, [4, 5]);
    b.client.send({ type: "pair", pose: "bendover" });
    await a.client.next("paired");
  });

  binaryOnly("an invite lapses after PAIR_INVITE_TTL_MS: the late sender's own invite is made instead", async () => {
    const clock = new TestClock();
    const { a, b } = await setup(true, DEFAULT_LAYOUT.furniture, { now: clock.now, wallNow: clock.wallNow });
    await stand(b, [4, 5]);
    await invite(a, "thrust");
    await clock.set({ wall: clock.wall + PAIR_INVITE_TTL_MS });
    b.client.send({ type: "pair", pose: "bendover" });
    expect(await a.client.next("pair-invited")).toMatchObject({ memberId: b.snapshot.self, pose: "bendover" });
    await a.client.none("paired", 100);
  });

  binaryOnly("walking cancels the walker's invite", async () => {
    const { a, b } = await setup(true);
    await stand(b, [4, 5]);
    await invite(a, "thrust");
    await stand(a, [8, 8]);
    b.client.send({ type: "pair", pose: "bendover" });
    expect(await a.client.next("pair-invited")).toMatchObject({ memberId: b.snapshot.self });
    await a.client.none("paired", 100);
  });

  binaryOnly("a second invite replaces the first", async () => {
    const { a, b } = await setup(true);
    await stand(b, [4, 5]);
    a.client.send({ type: "pair", pose: "thrust" });
    await invite(a, "bendover");
    await b.client.next("pair-invited");
    b.client.send({ type: "pair", pose: "thrust" });
    expect((await a.client.next("paired")).bendover).toBe(a.snapshot.self);
  });

  binaryOnly("the old pose of a replaced invite no longer matches", async () => {
    const { a, b } = await setup(true);
    await stand(b, [4, 5]);
    await invite(a, "thrust");
    await invite(a, "bendover");
    b.client.send({ type: "pair", pose: "bendover" });
    expect(await a.client.next("pair-invited")).toMatchObject({ memberId: b.snapshot.self });
    await a.client.none("paired", 100);
  });

  binaryOnly("the same pose never matches", async () => {
    const { a, b } = await setup(true);
    await stand(b, [4, 5]);
    await invite(a, "thrust");
    b.client.send({ type: "pair", pose: "thrust" });
    expect(await a.client.next("pair-invited")).toMatchObject({ memberId: b.snapshot.self, pose: "thrust" });
    await a.client.none("paired", 100);
  });

  binaryOnly("a member cannot pair with themselves", async () => {
    const { a, b } = await setup(true);
    await stand(a, [4, 5]);
    a.client.send({ type: "pair", pose: "thrust" });
    await invite(a, "bendover");
    await b.client.next("pair-invited");
    await a.client.none("paired", 100);
  });
});
