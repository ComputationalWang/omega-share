import { afterEach, describe, expect, test } from "bun:test";
import { EMOTE_BURST, REACTION_KINDS, REACTIONS_MAX } from "@omega/shared";
import { Client, postShare, start, TestClock, tokenOf, type TestServer } from "./helpers";

// OME-1632 (ADR 0056): the timed reaction timeline. Landed after the Rust switch: the frozen TS server ignores
// `react`, so every test here runs against the binary only.
const binaryOnly = test.skipIf(process.env["OMEGA_SERVER_BIN"] === undefined);

let t: TestServer | null = null;
let clock = new TestClock();
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});
function begin(): void {
  clock = new TestClock();
  t = start({ now: clock.now, wallNow: clock.wallNow });
}

function fail(): never {
  throw new Error("no server");
}
const server = (): TestServer => t ?? fail();

let nextAddress = 1;
const freshAddress = (): string => `198.51.100.${String(nextAddress++ % 250)}`;

async function joined(nickname: string) {
  const client = await Client.open(server().ws(), undefined, { "x-forwarded-for": freshAddress() });
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0 });
  return { client, snapshot: await client.next("snapshot") };
}

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIMEO = "https://vimeo.com/76979871";

/** Shares `url` as `member` 10 s after the last step (the share bucket); the room plays it from 0 at `clock.wall`. */
async function share(member: Awaited<ReturnType<typeof joined>>, url: string): Promise<void> {
  await clock.set({ mono: clock.mono + 10_000, wall: clock.wall + 10_000 });
  const res = await postShare(server(), JSON.stringify({ url }), { token: tokenOf(member.snapshot) });
  expect(res.status).toBe(200);
  await member.client.next("embed-changed");
}

/** Moves both clocks by `ms`: the emote bucket refills and the room clock runs on. */
const step = (ms: number): Promise<void> => clock.set({ mono: clock.mono + ms, wall: clock.wall + ms });

describe("timed reactions (OME-1632)", () => {
  binaryOnly("react is relayed to everyone with the server's own mediaMs, and a late joiner's snapshot replays it", async () => {
    begin();
    const a = await joined("alice");
    const b = await joined("bob");
    await share(a, YT);
    await step(12_345);
    a.client.send({ type: "react", kind: "heart" });
    const heard = { type: "reacted", memberId: a.snapshot.self, kind: "heart", mediaMs: 12_345 } as const;
    expect(await a.client.next("reacted")).toEqual(heard);
    expect(await b.client.next("reacted")).toEqual(heard);
    const late = await joined("carol");
    expect(late.snapshot.reactions).toEqual([{ memberId: a.snapshot.self, kind: "heart", mediaMs: 12_345 }]);
    // Most members at once since the item started, the late joiner included.
    expect(late.snapshot.peakMembers).toBe(3);
  });

  binaryOnly("a client's mediaMs is refused: the message is strict", async () => {
    begin();
    const a = await joined("alice");
    await share(a, YT);
    a.client.send({ type: "react", kind: "heart", mediaMs: 5 });
    expect((await a.client.next("error")).code).toBe("bad_message");
    await a.client.none("reacted");
  });

  binaryOnly("a kind outside REACTION_KINDS is a bad_message and nothing is relayed or stored", async () => {
    begin();
    const a = await joined("alice");
    await share(a, YT);
    a.client.send({ type: "react", kind: "poop" });
    expect((await a.client.next("error")).code).toBe("bad_message");
    await a.client.none("reacted");
    expect((await joined("bob")).snapshot.reactions).toBeUndefined();
  });

  binaryOnly("over the emote bucket a reaction is dropped silently: no relay, no error", async () => {
    begin();
    const a = await joined("alice");
    await share(a, YT);
    for (let i = 0; i <= EMOTE_BURST; i++) a.client.send({ type: "react", kind: "clap" });
    for (let i = 0; i < EMOTE_BURST; i++) await a.client.next("reacted");
    await a.client.none("reacted");
    await a.client.none("error", 0);
    expect((await joined("bob")).snapshot.reactions).toHaveLength(EMOTE_BURST);
  });

  binaryOnly("without a synced item a reaction is dropped silently", async () => {
    begin();
    const a = await joined("alice");
    a.client.send({ type: "react", kind: "wow" });
    await a.client.none("reacted");
    await a.client.none("error", 0);
    expect((await joined("bob")).snapshot.reactions).toBeUndefined();
  });

  binaryOnly(`the ring keeps the latest ${String(REACTIONS_MAX)}, oldest first`, async () => {
    begin();
    const a = await joined("alice");
    await share(a, YT);
    for (let i = 0; i <= REACTIONS_MAX; i++) {
      a.client.send({ type: "react", kind: REACTION_KINDS[i % REACTION_KINDS.length] });
      expect((await a.client.next("reacted")).mediaMs).toBe(i * 1000);
      await step(1000);
    }
    const reactions = (await joined("bob")).snapshot.reactions ?? [];
    expect(reactions).toHaveLength(REACTIONS_MAX);
    expect(reactions[0]?.mediaMs).toBe(1000);
    expect(reactions.at(-1)?.mediaMs).toBe(REACTIONS_MAX * 1000);
  });

  binaryOnly("a new current item clears the timeline and restarts the peak", async () => {
    begin();
    const a = await joined("alice");
    const b = await joined("bob");
    await share(a, YT);
    a.client.send({ type: "react", kind: "laugh" });
    await a.client.next("reacted");
    b.client.send({ type: "leave" });
    await a.client.next("member-left");
    await share(a, VIMEO);
    const late = await joined("carol");
    expect(late.snapshot.reactions).toBeUndefined();
    // alice and carol: bob left before the new item started.
    expect(late.snapshot.peakMembers).toBe(2);
  });
});
