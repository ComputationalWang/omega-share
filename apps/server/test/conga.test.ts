import { afterEach, describe, expect, test } from "bun:test";
import { Client, start, type TestServer } from "./helpers";

// OME-1574: the /conga line in the snapshot, for whoever joins late. Landed after the Rust switch, so only the Rust
// server tracks it; the frozen TS one sends no `conga`. Every test here runs against the binary only.
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
async function join(nickname: string) {
  const client = await Client.open((t ?? fail()).ws());
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0 });
  return { client, snapshot: await client.next("snapshot") };
}
/** `who` says `text`; resolves with the relayed line's server time, once `watcher` has it. */
async function say(who: { client: Client }, watcher: Client, text: string): Promise<number> {
  who.client.send({ type: "chat", text });
  return (await watcher.next("chat")).at;
}

describe("conga line in the snapshot (OME-1574)", () => {
  binaryOnly("a late joiner gets the line, leader first: /conga joins at the back, a repeat keeps its place, /stop leaves; no line, no key", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    const c = await join("carol");
    expect(c.snapshot).not.toHaveProperty("conga");
    await say(a, a.client, "/conga");
    await say(b, a.client, "/CONGA let's go");
    await say(c, a.client, "hello");
    const last = await say(c, a.client, "  /conga");
    const at = await say(a, a.client, "/conga");
    const ids = [a.snapshot.self, b.snapshot.self, c.snapshot.self];
    expect((await join("dave")).snapshot.conga).toEqual({ ids, last: at });
    expect(at).toBeGreaterThanOrEqual(last);
    await say(b, a.client, "/stop");
    await say(c, a.client, "/stop now"); // not a /stop: chat
    expect((await join("erin")).snapshot.conga).toEqual({ ids: [a.snapshot.self, c.snapshot.self], last: at });
    await say(a, a.client, "/stop");
    await say(c, a.client, "/stop");
    expect((await join("fred")).snapshot).not.toHaveProperty("conga");
  });

  binaryOnly("leaving the room, sitting down and sitting on the floor take a member out of the line", async () => {
    t = start();
    const a = await join("alice");
    const b = await join("bob");
    const c = await join("carol");
    const d = await join("dave");
    for (const m of [a, b, c, d]) await say(m, a.client, "/conga");
    d.client.send({ type: "sit", seat: 0 });
    await a.client.next("seat-changed");
    c.client.send({ type: "walk", cell: { x: 3, y: 3 } });
    await a.client.next("walked");
    c.client.send({ type: "floor-sit", on: true });
    await a.client.next("floor-sat");
    b.client.close();
    await a.client.next("member-left", 3000);
    const late = await join("erin");
    expect(late.snapshot.conga?.ids).toEqual([a.snapshot.self]);
    // Standing up again doesn't put them back; they /conga in at the back.
    d.client.send({ type: "sit", seat: null });
    await a.client.next("seat-changed");
    await say(d, a.client, "/conga");
    expect((await join("fred")).snapshot.conga?.ids).toEqual([a.snapshot.self, d.snapshot.self]);
  });
});
