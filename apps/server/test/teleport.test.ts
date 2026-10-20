import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, DEFAULT_LAYOUT, WALK_BURST, type Furniture, type RoomLayout } from "@omega/shared";
import { Client, start, TestClock, type TestServer } from "./helpers";

// OME-1545 (ADR 0053 amendment): teleport pads landed after the Rust switch, so only the Rust server implements
// them; the frozen TS one ignores walks. Every test here runs against the binary only.
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

const A = { x: 9, y: 1 };
const B = { x: 1, y: 9 };
const pad = (cell: { x: number; y: number }): Furniture => ({ kind: "pad", col: cell.x, row: cell.y, facing: "se" });
const withPads = (...cells: { x: number; y: number }[]): RoomLayout => ({ furniture: [...DEFAULT_LAYOUT.furniture, ...cells.map(pad)] });

/** An owned room whose layout holds the pads on A and B, with its owner and a guest joined. */
async function padRoom() {
  const res = await fetch(`${(t ?? fail()).http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pads", visibility: "public" }) });
  const created = v.parse(CreateRoomResponseSchema, await res.json());
  if (!created.ok) throw new Error("create failed");
  const owner = await join("alice", { ownerToken: created.ownerToken }, created.room.id);
  owner.client.send({ type: "layout-set", layout: withPads(A, B) });
  await owner.client.next("layout-changed");
  const guest = await join("bob", {}, created.room.id);
  return { id: created.room.id, owner, guest };
}

describe("teleport pads (OME-1545)", () => {
  binaryOnly("a layout with 1 or 3 pads is bad_message and changes nothing", async () => {
    t = start();
    const { owner, guest } = await padRoom();
    for (const layout of [withPads(A), withPads(A, B, { x: 8, y: 9 })]) {
      owner.client.send({ type: "layout-set", layout });
      expect((await owner.client.next("error")).code).toBe("bad_message");
    }
    await guest.client.none("layout-changed", 100);
  });

  binaryOnly("from one pad to the other it is relayed as walked with teleport to everyone and lands in the snapshot", async () => {
    t = start();
    const { id, owner, guest } = await padRoom();
    owner.client.send({ type: "walk", cell: A });
    for (const c of [owner.client, guest.client]) await c.next("walked");
    owner.client.send({ type: "walk", cell: B, teleport: true });
    for (const c of [owner.client, guest.client]) expect(await c.next("walked")).toEqual({ type: "walked", memberId: owner.snapshot.self, cell: B, teleport: true });
    const late = await join("carol", {}, id);
    expect(late.snapshot.room.members.find((m) => m.id === owner.snapshot.self)?.cell).toEqual(B);
    owner.client.send({ type: "walk", cell: A, teleport: true });
    expect((await guest.client.next("walked")).cell).toEqual(A);
  });

  binaryOnly("teleport while not standing on a pad is bad_cell: off a pad, on the standing spot, seated", async () => {
    t = start();
    const { owner, guest } = await padRoom();
    owner.client.send({ type: "walk", cell: B, teleport: true });
    expect((await owner.client.next("error")).code).toBe("bad_cell");
    owner.client.send({ type: "walk", cell: { x: 8, y: 1 } });
    await guest.client.next("walked");
    owner.client.send({ type: "walk", cell: B, teleport: true });
    expect((await owner.client.next("error")).code).toBe("bad_cell");
    owner.client.send({ type: "sit", seat: 2 });
    await guest.client.next("seat-changed");
    owner.client.send({ type: "walk", cell: B, teleport: true });
    expect((await owner.client.next("error")).code).toBe("bad_cell");
    await guest.client.none("walked", 100);
  });

  binaryOnly("teleport to a cell that is not the other pad is bad_cell; so is any teleport in a room without pads", async () => {
    t = start();
    const { owner, guest } = await padRoom();
    owner.client.send({ type: "walk", cell: A });
    await guest.client.next("walked");
    for (const cell of [{ x: 8, y: 1 }, A, { x: 0, y: 0 }]) {
      owner.client.send({ type: "walk", cell, teleport: true });
      expect((await owner.client.next("error")).code).toBe("bad_cell");
    }
    await guest.client.none("walked", 100);
    const lobby = await join("dave");
    lobby.client.send({ type: "walk", cell: A });
    await lobby.client.next("walked");
    lobby.client.send({ type: "walk", cell: B, teleport: true });
    expect((await lobby.client.next("error")).code).toBe("bad_cell");
  });

  binaryOnly(`it shares the walk bucket: after ${String(WALK_BURST)} walks a teleport is dropped silently`, async () => {
    const clock = new TestClock();
    t = start({ now: clock.now });
    const { owner, guest } = await padRoom();
    // the last walk lands on pad A
    for (let i = 0; i < WALK_BURST; i++) owner.client.send({ type: "walk", cell: (WALK_BURST - 1 - i) % 2 === 0 ? A : { x: 8, y: 1 } });
    for (let i = 0; i < WALK_BURST; i++) await guest.client.next("walked");
    owner.client.send({ type: "walk", cell: B, teleport: true });
    await guest.client.none("walked", 100);
    await owner.client.none("error", 0);
  });
});
