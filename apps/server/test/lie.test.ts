import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, DEFAULT_LAYOUT } from "@omega/shared";
import { Client, start, type TestServer } from "./helpers";

// OME-1691 (OME-1773 contract): lying down landed after the Rust switch, so only the Rust server implements it; the frozen
// TS one answers `lie` with nothing. Every test here runs against the binary only.
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

// The default layout without its last two armchairs (seats must total 8), plus a sofa (piece 10, seats 6 and 7) and a cat (piece 11, no seats).
const SOFA = 10;
const layout = { furniture: [...DEFAULT_LAYOUT.furniture.filter((f) => !(f.kind === "armchair" && ((f.col === 6 && f.row === 4) || (f.col === 7 && f.row === 3)))), { kind: "sofa" as const, col: 7, row: 7, facing: "se" as const }, { kind: "cat" as const, col: 8, row: 5, facing: "se" as const }] };
const roomId = { current: "" };

async function join(nickname: string, extra: Record<string, unknown> = {}) {
  const client = await Client.open((t ?? fail()).ws(roomId.current));
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...extra });
  return { client, snapshot: await client.next("snapshot") };
}

/** A room whose owner has set the layout with the sofa and cat (or `furniture`), and two guests, alice and bob. */
async function setup(furniture = layout.furniture) {
  t = start();
  const res = await fetch(`${t.http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Beds", visibility: "public" }) });
  const created = v.parse(CreateRoomResponseSchema, await res.json());
  if (!created.ok) throw new Error("create failed");
  roomId.current = created.room.id;
  const owner = await join("owner", { ownerToken: created.ownerToken });
  owner.client.send({ type: "layout-set", layout: { furniture } });
  await owner.client.next("layout-changed");
  const a = await join("alice");
  const b = await join("bob");
  return { a, b, owner };
}
/** `m` lies on `piece`; every socket has seen the `lay` before this returns. */
async function lie(m: Awaited<ReturnType<typeof join>>, piece: number | null) {
  m.client.send({ type: "lie", piece });
  for (const c of clients) await c.next("lay");
}

describe("lying down (OME-1691)", () => {
  binaryOnly("lie is relayed as lay to everyone and lands in a late joiner's snapshot; null gets up", async () => {
    const { a, b } = await setup();
    a.client.send({ type: "lie", piece: SOFA });
    for (const c of [a.client, b.client]) expect(await c.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: SOFA });
    const late = await join("late");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.lying).toBe(SOFA);
    expect(late.snapshot.room.members.find((m) => m.id === b.snapshot.self)?.lying).toBeUndefined();
    a.client.send({ type: "lie", piece: null });
    expect(await b.client.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: null });
  });

  binaryOnly("a lain-on sofa and its seats are taken for everyone else", async () => {
    const { a, b } = await setup();
    await lie(a, SOFA);
    b.client.send({ type: "lie", piece: SOFA });
    expect((await b.client.next("error")).code).toBe("seat_taken");
    for (const seat of [6, 7]) {
      b.client.send({ type: "sit", seat });
      expect((await b.client.next("error")).code).toBe("seat_taken");
    }
    b.client.send({ type: "sit", seat: 0 });
    expect(await b.client.next("seat-changed")).toEqual({ type: "seat-changed", memberId: b.snapshot.self, seat: 0 });
  });

  binaryOnly("a piece that is not there or has no lie style is bad_cell; the current piece is a no-op", async () => {
    const { a, b } = await setup();
    for (const piece of [0, 2, 12]) {
      a.client.send({ type: "lie", piece });
      expect((await a.client.next("error")).code).toBe("bad_cell");
    }
    await lie(a, SOFA);
    a.client.send({ type: "lie", piece: SOFA });
    await b.client.none("lay", 100);
    await a.client.none("error", 100);
  });

  binaryOnly("lying down from a seat sends seat-changed null first", async () => {
    const { a, b } = await setup();
    a.client.send({ type: "sit", seat: 0 });
    for (const c of clients) await c.next("seat-changed");
    a.client.send({ type: "lie", piece: SOFA });
    expect(await b.client.next("seat-changed")).toEqual({ type: "seat-changed", memberId: a.snapshot.self, seat: null });
    expect(await b.client.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: SOFA });
  });

  binaryOnly("a walk, a sit and a leave get the lier up first (lay null, then the relay)", async () => {
    const { a, b } = await setup();
    await lie(a, SOFA);
    a.client.send({ type: "walk", cell: { x: 8, y: 4 } });
    expect(await b.client.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: null });
    await b.client.next("walked");
    await lie(a, SOFA);
    a.client.send({ type: "sit", seat: 0 });
    expect((await b.client.next("lay")).piece).toBeNull();
    expect((await b.client.next("seat-changed")).seat).toBe(0);
    await lie(a, SOFA);
    a.client.send({ type: "leave" });
    expect((await b.client.next("lay")).piece).toBeNull();
    await b.client.next("member-left");
  });

  binaryOnly("a layout-set that drops the piece gets the lier up right after layout-changed", async () => {
    const { a, b, owner } = await setup();
    await lie(a, SOFA);
    owner.client.send({ type: "layout-set", layout: DEFAULT_LAYOUT });
    await b.client.next("layout-changed");
    expect(await b.client.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: null });
  });

  binaryOnly("a layout-set that keeps the piece leaves the lier lying", async () => {
    const { a, b, owner } = await setup();
    await lie(a, SOFA);
    owner.client.send({ type: "layout-set", layout: { furniture: layout.furniture.filter((f) => f.kind !== "cat") } });
    await b.client.next("layout-changed");
    await b.client.none("lay", 100);
    const late = await join("late");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.lying).toBe(SOFA);
  });

  // OME-2008: a queen bed (piece 10 in place of the sofa, seats 6 and 7) takes two sleepers, each on their own side.
  binaryOnly("a bed takes two sleepers, each keeps their side when the other gets up, a third is seat_taken", async () => {
    const BED = SOFA;
    const { a, b, owner } = await setup(layout.furniture.map((f, i) => (i === BED ? { kind: "bed" as const, col: 7, row: 7, facing: "se" as const } : f)));
    a.client.send({ type: "lie", piece: BED });
    expect(await b.client.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: BED, sleeper: 0 });
    b.client.send({ type: "lie", piece: BED });
    expect(await a.client.next("lay")).toEqual({ type: "lay", memberId: b.snapshot.self, piece: BED, sleeper: 1 });
    owner.client.send({ type: "lie", piece: BED });
    expect((await owner.client.next("error")).code).toBe("seat_taken");
    for (const seat of [6, 7]) {
      owner.client.send({ type: "sit", seat });
      expect((await owner.client.next("error")).code).toBe("seat_taken");
    }
    a.client.send({ type: "lie", piece: null });
    expect(await b.client.next("lay")).toEqual({ type: "lay", memberId: a.snapshot.self, piece: null });
    const late = await join("late");
    expect(late.snapshot.room.members.find((m) => m.id === b.snapshot.self)).toMatchObject({ lying: BED, sleeper: 1 });
    owner.client.send({ type: "sit", seat: 6 });
    expect((await owner.client.next("seat-changed")).seat).toBe(6);
  });
});
