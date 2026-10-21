import { afterEach, describe, expect, test } from "bun:test";
import { Client, start, type TestServer } from "./helpers";

// OME-1583: relays coalesced into `batch` frames for a connection that joined with `batch: true` (ADR 0050
// amendment). Landed after the Rust switch: the frozen TS server drops the flag, so every test here runs against
// the binary only.
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
async function join(nickname: string, batch?: boolean) {
  const client = await Client.open((t ?? fail()).ws());
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...(batch === undefined ? {} : { batch }) });
  await client.next("snapshot");
  return client;
}
/** Waits until `c` has a raw frame containing `text`. */
async function until(c: Client, text: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!c.raw.some((f) => f.includes(text))) {
    if (Date.now() > deadline) throw new Error(`no frame with ${text}`);
    await Bun.sleep(5);
  }
}
/** The messages in raw frames (the client already checked each against the schema), a batch's one by one. */
function unwrap(frames: string[]): string[] {
  return frames.flatMap((f) => {
    const m = JSON.parse(f) as { type: string; msgs?: unknown[] };
    return m.type === "batch" ? (m.msgs ?? []).map((x) => JSON.stringify(x)) : [f];
  });
}

describe("relay batching (OME-1583)", () => {
  binaryOnly("an opted-in observer gets a burst in fewer frames, same messages in order; a plain one byte for byte as before", async () => {
    t = start();
    const batched = await join("alice", true);
    const plain = await join("bob");
    const off = await join("carol", false);
    const actor = await join("dave");
    // member-joined is never batched; let everyone hear the last join first.
    for (const c of [batched, plain, off]) await until(c, '"nickname":"dave"');
    const before = { batched: batched.raw.length, plain: plain.raw.length };
    actor.send({ type: "walk", cell: { x: 2, y: 3 } });
    actor.send({ type: "emote", kind: "wave" });
    actor.send({ type: "roll", sides: 6 });
    actor.send({ type: "chat", text: "hi" });
    for (const c of [batched, plain, off]) await until(c, '"text":"hi"');
    const plainFrames = plain.raw.slice(before.plain);
    expect(plainFrames.map((f) => (JSON.parse(f) as { type: string }).type)).toEqual(["walked", "emoted", "rolled", "chat"]);
    expect(off.raw.slice(-4)).toEqual(plainFrames);
    const batchedFrames = batched.raw.slice(before.batched);
    expect(batchedFrames.length).toBeLessThan(4);
    expect(batchedFrames.some((f) => f.startsWith('{"type":"batch","msgs":['))).toBe(true);
    // Unwrapped, the opted-in observer saw exactly the plain frames, in order.
    expect(unwrap(batchedFrames)).toEqual(plainFrames);
  });

  binaryOnly("replies and non-relays are never batched: an error reaches an opted-in sender as its own frame", async () => {
    t = start();
    const a = await join("alice", true);
    a.send({ type: "set-accessory", accessory: 9 });
    expect((await a.next("error")).code).toBe("bad_message");
    expect(a.raw.at(-1)).toStartWith('{"type":"error"');
  });
});
