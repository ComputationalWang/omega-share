import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, DEFAULT_LAYOUT, FLOOR_CELLS, WALK_BURST, WALK_REFILL_MS, type RoomLayout } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1346 (ADR 0053): free walking and shirt tint landed after the Rust switch, so only the Rust server
// implements them; the frozen TS one ignores both types. Every test here runs against the binary only.
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

/** DEFAULT_LAYOUT plus a side table on each of `cells`. */
function withTables(...cells: [number, number][]): RoomLayout {
  return { furniture: [...DEFAULT_LAYOUT.furniture, ...cells.map(([col, row]) => ({ kind: "sidetable" as const, col, row, facing: "se" as const }))] };
}

describe("walk (OME-1346)", () => {
  binaryOnly("a walk to free floor is relayed as walked to everyone and lands in the next snapshot", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "walk", cell: { x: 3, y: 3 } });
    for (const c of [a.client, b.client]) expect(await c.next("walked")).toEqual({ type: "walked", memberId: a.snapshot.self, cell: { x: 3, y: 3 } });
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.cell).toEqual({ x: 3, y: 3 });
  });

  binaryOnly("off the grid is bad_message; a solid piece or a seat is bad_cell; nothing is relayed", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "walk", cell: { x: FLOOR_CELLS, y: 0 } });
    expect((await a.client.next("error")).code).toBe("bad_message");
    for (const cell of [{ x: 0, y: 0 }, { x: 1, y: 5 }]) {
      // the tv; an armchair (a seat: use sit)
      a.client.send({ type: "walk", cell });
      expect((await a.client.next("error")).code).toBe("bad_cell");
    }
    await b.client.none("walked", 100);
  });

  binaryOnly("walking off a seat stands up first; sitting clears the cell", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "sit", seat: 2 });
    await b.client.next("seat-changed");
    a.client.send({ type: "walk", cell: { x: 4, y: 4 } });
    expect(await b.client.next("seat-changed")).toEqual({ type: "seat-changed", memberId: a.snapshot.self, seat: null });
    expect((await b.client.next("walked")).cell).toEqual({ x: 4, y: 4 });
    a.client.send({ type: "sit", seat: 2 });
    await b.client.next("seat-changed");
    const late = await join("carol");
    expect(late.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.cell).toBeUndefined();
  });

  binaryOnly(`a burst of ${String(WALK_BURST)} walks relays, the next is dropped silently, a refill restores one`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const a = await join("alice");
    const b = await join("bob");
    for (let i = 0; i <= WALK_BURST; i++) a.client.send({ type: "walk", cell: { x: 3, y: i % 2 === 0 ? 3 : 4 } });
    for (let i = 0; i < WALK_BURST; i++) await b.client.next("walked");
    await b.client.none("walked", 100);
    await a.client.none("error", 0);
    await clock.set({ mono: clock.mono + WALK_REFILL_MS });
    a.client.send({ type: "walk", cell: { x: 5, y: 5 } });
    expect((await b.client.next("walked")).cell).toEqual({ x: 5, y: 5 });
    expect(a.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  binaryOnly("a layout that covers a standing member's cell walks them to the door", async () => {
    t = start();
    const res = await fetch(`${t.http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Walks", visibility: "public" }) });
    const created = v.parse(CreateRoomResponseSchema, await res.json());
    if (!created.ok) throw new Error("create failed");
    const owner = await join("alice", { ownerToken: created.ownerToken }, created.room.id);
    const b = await join("bob", {}, created.room.id);
    b.client.send({ type: "walk", cell: { x: 8, y: 8 } });
    await owner.client.next("walked");
    owner.client.send({ type: "layout-set", layout: withTables([8, 8]) });
    await b.client.next("layout-changed");
    expect(await b.client.next("walked")).toEqual({ type: "walked", memberId: b.snapshot.self, cell: { x: FLOOR_CELLS - 1, y: FLOOR_CELLS - 1 } });
  });
});

describe("tint (OME-1346)", () => {
  binaryOnly("join sets it, set-tint changes it for everyone, the snapshot carries it", async () => {
    t = start();
    const a = await join("alice", { tint: 3 });
    expect(a.snapshot.room.members.find((m) => m.id === a.snapshot.self)?.tint).toBe(3);
    const b = await join("bob");
    expect(b.snapshot.room.members.find((m) => m.id === b.snapshot.self)?.tint).toBeUndefined();
    b.client.send({ type: "set-tint", tint: 5 });
    for (const c of [a.client, b.client]) expect(await c.next("tint-changed")).toEqual({ type: "tint-changed", memberId: b.snapshot.self, tint: 5 });
    b.client.send({ type: "set-tint", tint: 6 });
    expect((await b.client.next("error")).code).toBe("bad_message");
  });
});
