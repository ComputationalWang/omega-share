import { afterEach, expect, test } from "bun:test";
import * as v from "valibot";
import { MAX_ROOM_MEMBERS, RoomStateSchema, SEAT_COUNT, nicknameKey, parseServerMessage } from "@omega/shared";
import { Client, start, type TestServer } from "./helpers";

// [Malformed frames] threat model §8: a seeded PRNG sends 10k frames. Invariants: the server never
// throws or goes down, never relays a frame that fails the server schema, and the room state stays valid.

const SEED = 0x5eed_0187;
const FRAMES = 10_000;
const FUZZERS = 4;
/** Frames per round trip: the fuzzer waits for a pong between batches, so frames can't pile up unread. */
const BATCH = 25;

/** mulberry32: a tiny seeded PRNG, so a failure replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
}

const NASTY_STRINGS = [
  "",
  " ",
  "alice",
  "Alice",
  "ALICE",
  "Ａｌｉｃｅ",
  "Аlice",
  "‮evil",
  "zero​width",
  "\uD800",
  "\uDFFFlone",
  "á́́́",
  "👩‍💻",
  "x‍",
  "<script>alert(1)</script>",
  "x".repeat(300),
  "\u0000",
  "ㅤ",
];
const NASTY_NUMBERS = [0, -1, 1, 3, 5, 7, 24, 25, 1e999, -1e999, 1.5, 2 ** 53, Number.MAX_VALUE, -0];

function frame(rand: () => number, url: string): string {
  const pick = <T>(xs: readonly T[]): T => {
    const x = xs[Math.floor(rand() * xs.length)];
    if (x === undefined) throw new Error("empty pick");
    return x;
  };
  const str = () => pick(NASTY_STRINGS);
  const num = () => pick(NASTY_NUMBERS);
  const any = (): unknown => pick([str, num, () => null, () => true, () => [], () => ({}), () => ({ type: "join" })])();
  const valid = (): Record<string, unknown> =>
    pick([
      () => ({ type: "join", nickname: `f${String(Math.floor(rand() * 40))}`, avatar: Math.floor(rand() * 4) }),
      () => ({ type: "join", nickname: str(), avatar: num() }),
      () => ({ type: "leave" }),
      () => ({ type: "sit", seat: rand() < 0.2 ? null : Math.floor(rand() * (SEAT_COUNT + 2)) }),
      () => ({ type: "chat", text: rand() < 0.5 ? `hello ${String(rand())}` : str() }),
      () => ({ type: "control", url: rand() < 0.7 ? url : str(), playing: rand() < 0.5, position: num() }),
      () => ({ type: "ping", id: num() }),
    ])();
  const r = rand();
  if (r < 0.5) return JSON.stringify(valid());
  if (r < 0.65) return JSON.stringify({ ...valid(), [str() || "extra"]: any() });
  if (r < 0.75) {
    const s = JSON.stringify(valid());
    return s.slice(0, Math.floor(rand() * s.length));
  }
  if (r < 0.85) return JSON.stringify({ type: pick(["join", "chat", "sit", "control", "ping", "leave", "status", "__proto__"]), [str()]: any() });
  if (r < 0.92) return JSON.stringify(any());
  return pick(["1e999", "NaN", '{"type":"chat","text":"\\ud800"}', '{"__proto__":{"type":"leave"}}', "[]", "null", '"', "{}"]);
}

let t: TestServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
});

test("[Malformed frames] 10k seeded fuzz frames: no crash, no invalid relay, valid room state", async () => {
  // Time runs 1 s per frame, so the limiters never trip and every frame reaches the handler.
  const clock = { ms: 0 };
  t = start({ now: () => clock.ms, joinTimeoutMs: 60_000 });
  const server = t;
  const observer = await Client.join(server.ws(), "observer");
  clients.push(observer.client);
  const url = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  let reconnects = 0;

  // One PRNG per fuzzer, so each socket's frame sequence replays exactly whatever the interleaving.
  const fuzzer = async (index: number): Promise<void> => {
    const rand = prng(SEED + index);
    let c = await Client.open(server.ws());
    clients.push(c);
    for (let sent = 0; sent < FRAMES / FUZZERS; ) {
      for (let i = 0; i < BATCH && sent < FRAMES / FUZZERS; i++, sent++) {
        clock.ms += 1000;
        c.send(frame(rand, url));
      }
      c.send({ type: "ping", id: 1 });
      const pong = c.next("pong", 2000).then(() => "pong" as const);
      const closed = c.closed.then(() => "closed" as const);
      if ((await Promise.race([pong, closed])) === "closed") {
        reconnects++;
        c = await Client.open(server.ws());
        clients.push(c);
      }
    }
  };
  await Promise.all(Array.from({ length: FUZZERS }, (_, i) => fuzzer(i)));

  // Never relayed an invalid frame: everything the observer got parses under the server schema.
  const invalid = observer.client.raw.filter((raw) => parseServerMessage(raw) === null);
  expect(invalid).toEqual([]);
  expect(observer.client.socket.readyState).toBe(WebSocket.OPEN);
  expect(reconnects).toBeGreaterThan(0);

  // The server is up and its room state is valid, with unique nickname keys.
  clock.ms += 60_000;
  const late = await Client.join(server.ws(), "latecomer");
  clients.push(late.client);
  const room = v.parse(RoomStateSchema, late.snapshot.room);
  expect(room.members.length).toBeLessThanOrEqual(MAX_ROOM_MEMBERS);
  const keys = room.members.map((m) => nicknameKey(m.nickname));
  expect(new Set(keys).size).toBe(keys.length);
  const ids = new Set(room.members.map((m) => m.id));
  for (const seat of room.seats) if (seat !== null) expect(ids.has(seat)).toBe(true);
}, 60_000);
