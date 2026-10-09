import { describe, expect, test } from "bun:test";
import type { ClientMessage } from "@omega/shared";
import type { ChatLogEntry } from "../src/chat/log";
import type { PopMessage } from "../src/popout/channel";

// OME-598 (M7 W3, R-M7a Q3 a): the room tab keeps the one WebSocket and relays chat to and from its pop-out over a
// BroadcastChannel. The pop-out never joins. One pop-out per tab: the newest one that says it's ready is adopted and any
// other is told to go. Chat from the pop-out is sent once however often it arrives (the main tab de-duplicates by the
// pop-out's sequence), and only from the adopted pop-out.

const LINE = (text: string): ChatLogEntry => ({ kind: "chat", nickname: "Ada", text, self: false });
const STATE = { title: "Movie night", people: 3, cap: 8, open: true, cooling: false, muted: false, placeholder: "Say something…" };

async function setup(opts: { sendOk?: boolean } = {}) {
  const { createChatRelay, POP_LEASE_MS } = await import("../src/popout/relay");
  const posted: PopMessage[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  const sent: ClientMessage[] = [];
  const popped: boolean[] = [];
  let opened = 0;
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;
  const relay = createChatRelay({
    channel: {
      post: (m) => posted.push(m),
      onMessage: (fn) => {
        deliver = fn;
      },
      close: () => undefined,
    },
    send: (m) => {
      if (opts.sendOk === false) return false;
      sent.push(m);
      return true;
    },
    openWindow: () => {
      opened++;
    },
    onPopped: (on) => popped.push(on),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const from = (m: unknown): void => {
    deliver(m);
  };
  const take = (): PopMessage[] => posted.splice(0);
  return { relay, posted, take, from, sent, popped, opened: () => opened, advance, POP_LEASE_MS };
}

describe("chat relay (room tab)", () => {
  test("says hello on start, so a pop-out still open from before a reload comes back", async () => {
    const { posted } = await setup();
    expect(posted).toEqual([{ t: "room-hello" }]);
  });

  test("pop out opens the window; the chat moves only when the pop-out says it's ready, with the backlog and the state", async () => {
    const { relay, take, from, popped, opened } = await setup();
    relay.append(LINE("one"));
    relay.append(LINE("two"));
    relay.update(STATE);
    take();
    relay.popOut();
    expect(opened()).toBe(1);
    expect(relay.popped()).toBe(false);
    expect(popped).toEqual([]);
    from({ t: "pop-ready", pop: "p1" });
    expect(relay.popped()).toBe(true);
    expect(popped).toEqual([true]);
    expect(take()).toEqual([
      { t: "room-adopt", pop: "p1" },
      { t: "room-log", reset: true, entries: [LINE("one"), LINE("two")] },
      { t: "room-state", ...STATE },
    ]);
    relay.append(LINE("three"));
    expect(take()).toEqual([{ t: "room-log", reset: false, entries: [LINE("three")] }]);
  });

  test("the backlog keeps the last 50 lines only", async () => {
    const { relay, take, from } = await setup();
    for (let i = 0; i < 60; i++) relay.append(LINE(String(i)));
    take();
    from({ t: "pop-ready", pop: "p1" });
    const log = take().find((m) => m.t === "room-log");
    expect(log?.t === "room-log" ? log.entries.map((e) => (e.kind === "chat" ? e.text : "")) : []).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 10)));
  });

  test("state goes over only when popped out and only when it changed", async () => {
    const { relay, take, from } = await setup();
    take();
    relay.update(STATE);
    expect(take()).toEqual([]);
    from({ t: "pop-ready", pop: "p1" });
    take();
    relay.update(STATE);
    expect(take()).toEqual([]);
    relay.update({ ...STATE, cooling: true, placeholder: "Slow down a moment…" });
    expect(take()).toEqual([{ t: "room-state", ...STATE, cooling: true, placeholder: "Slow down a moment…" }]);
  });

  test("the pop-out's chat is sent on the one socket, once, however often it arrives", async () => {
    const { take, from, sent } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    take();
    from({ t: "pop-say", pop: "p1", seq: 1, text: "hello" });
    from({ t: "pop-say", pop: "p1", seq: 1, text: "hello" });
    from({ t: "pop-emote", pop: "p1", seq: 2, kind: "wave" });
    from({ t: "pop-emote", pop: "p1", seq: 2, kind: "wave" });
    expect(sent).toEqual([{ type: "chat", text: "hello" }, { type: "emote", kind: "wave" }]);
    expect(take()).toEqual([
      { t: "room-said", pop: "p1", seq: 1, ok: true },
      { t: "room-said", pop: "p1", seq: 2, ok: true },
    ]);
  });

  test("blank chat, or a socket that can't send, answers not ok and sends nothing", async () => {
    const blank = await setup();
    blank.from({ t: "pop-ready", pop: "p1" });
    blank.take();
    blank.from({ t: "pop-say", pop: "p1", seq: 1, text: "   " });
    expect(blank.sent).toEqual([]);
    expect(blank.take()).toEqual([{ t: "room-said", pop: "p1", seq: 1, ok: false }]);
    const down = await setup({ sendOk: false });
    down.from({ t: "pop-ready", pop: "p1" });
    down.take();
    down.from({ t: "pop-say", pop: "p1", seq: 1, text: "hi" });
    expect(down.take()).toEqual([{ t: "room-said", pop: "p1", seq: 1, ok: false }]);
  });

  test("while chat cools or is muted, the pop-out's chat is held (not ok), emotes still go", async () => {
    const { relay, take, from, sent } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    relay.update({ ...STATE, cooling: true, muted: true });
    take();
    from({ t: "pop-say", pop: "p1", seq: 1, text: "hi" });
    from({ t: "pop-emote", pop: "p1", seq: 2, kind: "heart" });
    expect(sent).toEqual([{ type: "emote", kind: "heart" }]);
    expect(take()).toEqual([
      { t: "room-said", pop: "p1", seq: 1, ok: false },
      { t: "room-said", pop: "p1", seq: 2, ok: true },
    ]);
  });

  test("one pop-out per tab: a reopened one is adopted, the old one is told to go and is never heard again", async () => {
    const { take, from, sent, popped } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    from({ t: "pop-say", pop: "p1", seq: 1, text: "first" });
    from({ t: "pop-ready", pop: "p2" });
    expect(take().filter((m) => m.t === "room-adopt")).toEqual([{ t: "room-adopt", pop: "p1" }, { t: "room-adopt", pop: "p2" }]);
    from({ t: "pop-say", pop: "p1", seq: 2, text: "stale" });
    from({ t: "pop-bye", pop: "p1" });
    from({ t: "pop-say", pop: "p2", seq: 1, text: "second" });
    expect(sent).toEqual([{ type: "chat", text: "first" }, { type: "chat", text: "second" }]);
    expect(popped).toEqual([true]);
  });

  test("messages from a pop-out that was never adopted are ignored", async () => {
    const { take, from, sent, relay } = await setup();
    take();
    from({ t: "pop-say", pop: "p9", seq: 1, text: "hi" });
    from({ t: "pop-back", pop: "p9" });
    expect(sent).toEqual([]);
    expect(take()).toEqual([]);
    expect(relay.popped()).toBe(false);
  });

  test("malformed messages are dropped", async () => {
    const { take, from, relay } = await setup();
    take();
    from({ t: "pop-ready" });
    from("pop-ready");
    from({ t: "pop-ready", pop: "p1", extra: true });
    expect(relay.popped()).toBe(false);
    expect(take()).toEqual([]);
  });

  test("bring chat back (page) tells the pop-out to close and returns the chat", async () => {
    const { relay, take, from, popped } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    take();
    relay.bringBack();
    expect(take()).toEqual([{ t: "room-back" }]);
    expect(relay.popped()).toBe(false);
    expect(popped).toEqual([true, false]);
    from({ t: "pop-say", pop: "p1", seq: 1, text: "late" });
    expect(take()).toEqual([]);
  });

  test("the pop-out's put-back key and the window closing both return the chat", async () => {
    const back = await setup();
    back.from({ t: "pop-ready", pop: "p1" });
    back.from({ t: "pop-back", pop: "p1" });
    expect(back.relay.popped()).toBe(false);
    expect(back.popped).toEqual([true, false]);
    const bye = await setup();
    bye.from({ t: "pop-ready", pop: "p1" });
    bye.from({ t: "pop-bye", pop: "p1" });
    expect(bye.relay.popped()).toBe(false);
  });

  test("a pop-out that goes silent past the lease (gone without a word) returns the chat; pings keep it", async () => {
    const { relay, from, advance, POP_LEASE_MS } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    advance(POP_LEASE_MS - 1000);
    from({ t: "pop-ping", pop: "p1" });
    advance(POP_LEASE_MS - 1000);
    expect(relay.popped()).toBe(true);
    advance(2000);
    expect(relay.popped()).toBe(false);
  });

  test("a lapsed lease tells the window to go, so it doesn't sit there open and unheard (review)", async () => {
    const { take, from, advance, POP_LEASE_MS } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    take();
    advance(POP_LEASE_MS + 1);
    expect(take()).toEqual([{ t: "room-back" }]);
  });

  test("back from the back/forward cache: the chat is home again and a window still open is asked to say ready (review)", async () => {
    const { relay, take, from, popped } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    relay.close();
    take();
    relay.resume();
    expect(relay.popped()).toBe(false);
    expect(popped).toEqual([true, false]);
    expect(take()).toEqual([{ t: "room-hello" }]);
    from({ t: "pop-ready", pop: "p1" });
    expect(relay.popped()).toBe(true);
  });

  test("the room tab going away tells the pop-out", async () => {
    const { relay, take, from } = await setup();
    from({ t: "pop-ready", pop: "p1" });
    take();
    relay.close();
    expect(take()).toEqual([{ t: "room-gone" }]);
  });
});
