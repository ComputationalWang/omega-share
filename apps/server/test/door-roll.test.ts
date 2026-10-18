import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomResponseSchema, DICE_MAX_SIDES, DICE_MIN_SIDES, MAX_DOORS } from "@omega/shared";
import { Client, start, type TestServer } from "./helpers";

// OME-1423 (ADR 0054): doors and /roll landed after the Rust switch, so only the Rust server implements them; the
// frozen TS one ignores `roll` and has no own-room check. Every test here runs against the binary only.
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
  const res = await fetch(`${(t ?? fail()).http}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Doors", visibility: "public" }) });
  const created = v.parse(CreateRoomResponseSchema, await res.json());
  if (!created.ok) throw new Error("create failed");
  const owner = await join("alice", { ownerToken: created.ownerToken }, created.room.id);
  return { id: created.room.id, owner };
}

const SEATS = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const;
const withDoors = (...targets: unknown[]) => ({
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    ...SEATS.map(([col, row]) => ({ kind: "armchair", col, row, facing: col < row ? "ne" : "nw" })),
    ...targets.map((target, i) => ({ kind: "door", col: 3 + i, row: 0, facing: "sw", target })),
  ],
});

describe("doors (OME-1423)", () => {
  binaryOnly(`up to MAX_DOORS (${String(MAX_DOORS)}) doors to other rooms are saved and relayed, an unknown room included`, async () => {
    t = start();
    const { owner } = await ownRoom();
    const layout = withDoors("lobby", "no-such-room");
    owner.client.send({ type: "layout-set", layout });
    expect(JSON.stringify((await owner.client.next("layout-changed")).layout)).toBe(JSON.stringify(layout));
  });

  binaryOnly("a third door is a bad_message and changes nothing", async () => {
    t = start();
    const { owner } = await ownRoom();
    owner.client.send({ type: "layout-set", layout: withDoors("lobby", "a", "b") });
    expect((await owner.client.next("error")).code).toBe("bad_message");
    await owner.client.none("layout-changed", 100);
  });

  binaryOnly("a door to its own room is a bad_message and changes nothing", async () => {
    t = start();
    const { id, owner } = await ownRoom();
    owner.client.send({ type: "layout-set", layout: withDoors("lobby", id) });
    expect((await owner.client.next("error")).code).toBe("bad_message");
    await owner.client.none("layout-changed", 100);
  });

  binaryOnly("a target that is not a room id is a bad_message", async () => {
    t = start();
    const { owner } = await ownRoom();
    for (const target of ["https://evil.example/", "Lobby", "", "a".repeat(33), null]) {
      owner.client.send({ type: "layout-set", layout: withDoors(target) });
      expect((await owner.client.next("error")).code).toBe("bad_message");
    }
    await owner.client.none("layout-changed", 100);
  });
});

describe("roll (OME-1423)", () => {
  binaryOnly(`rolls a ${String(DICE_MIN_SIDES)}..${String(DICE_MAX_SIDES)}-sided die for everyone, the value in 1..sides`, async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    for (const sides of [DICE_MIN_SIDES, 6, DICE_MAX_SIDES]) {
      a.client.send({ type: "roll", sides });
      for (const c of [a.client, b.client]) {
        const rolled = await c.next("rolled");
        expect(rolled).toMatchObject({ type: "rolled", memberId: a.snapshot.self, sides });
        expect(rolled.value).toBeGreaterThanOrEqual(1);
        expect(rolled.value).toBeLessThanOrEqual(sides);
      }
    }
  });

  binaryOnly("sides out of bounds is a bad_message; before join it is not_joined", async () => {
    t = start();
    const a = await join("alice");
    for (const sides of [1, DICE_MAX_SIDES + 1, 6.5]) {
      a.client.send({ type: "roll", sides });
      expect((await a.client.next("error")).code).toBe("bad_message");
    }
    await a.client.none("rolled", 100);
    const early = await Client.open(t.ws());
    clients.push(early);
    early.send({ type: "roll", sides: 6 });
    expect((await early.next("error")).code).toBe("not_joined");
  });

  binaryOnly("shares the chat bucket: 5 lines and rolls pass, the 6th gets rate_limited", async () => {
    t = start();
    const a = await join("alice");
    for (let i = 0; i < 3; i++) a.client.send({ type: "chat", text: "hi" });
    a.client.send({ type: "roll", sides: 6 });
    a.client.send({ type: "roll", sides: 6 });
    for (let i = 0; i < 2; i++) await a.client.next("rolled");
    a.client.send({ type: "roll", sides: 6 });
    const error = await a.client.next("error");
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  binaryOnly("a muted member's roll is answered muted and reaches nobody", async () => {
    t = start();
    const { id, owner } = await ownRoom();
    const b = await join("bob", {}, id);
    owner.client.send({ type: "mute", memberId: b.snapshot.self, muted: true });
    await b.client.next("member-muted");
    b.client.send({ type: "roll", sides: 6 });
    expect((await b.client.next("error")).code).toBe("muted");
    await owner.client.none("rolled", 100);
  });
});
