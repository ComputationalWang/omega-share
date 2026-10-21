import { expect, test } from "bun:test";
import { createClockSync } from "../src/clock";
import { createConnection, type ConnectionEvent, type SocketLike } from "../src/connection";
import { routeConnectionEvent } from "../src/room-events";
import type { ViewEvent } from "../src/state";

/** A real clock on fake timers: which timers are still pending after the event. */
function setup(hidden: readonly string[] = [], typing: (memberId: string, on: boolean) => void = () => undefined): { pending: Set<number>; route: (e: ConnectionEvent) => void; dispatched: ViewEvent[]; emoted: [string, string][]; sessions: string[] } {
  const pending = new Set<number>();
  let next = 0;
  const clock = createClockSync<number>({
    now: () => 0,
    sendPing: () => true,
    setTimer: () => {
      next += 1;
      pending.add(next);
      return next;
    },
    clearTimer: (h) => {
      pending.delete(h);
    },
  });
  clock.start();
  const dispatched: ViewEvent[] = [];
  const emoted: [string, string][] = [];
  const sessions: string[] = [];
  const sinks = {
    emoted: (memberId: string, kind: string) => emoted.push([memberId, kind]),
    typing,
    clock,
    shareToken: { onEvent: () => undefined },
    joined: () => undefined,
    kicked: (wasIn: boolean) => (wasIn ? 600_000 : null),
    dispatch: (e: ViewEvent) => dispatched.push(e),
    hidden: (id: string) => hidden.includes(id),
    session: (token: string) => sessions.push(token),
  };
  return { pending, route: (e) => { routeConnectionEvent(e, sinks, 0); }, dispatched, emoted, sessions };
}

test("room-closed (4004) stops the clock: no ping timer keeps firing on the terminal screen", () => {
  const { pending, route, dispatched } = setup();
  expect(pending.size).toBeGreaterThan(0);
  route({ type: "room-closed" });
  expect(pending.size).toBe(0);
  expect(dispatched).toEqual([{ type: "room-closed" }]);
});

test("a takedown (4006) stops the clock and reaches the state as a takedown", () => {
  const { pending, route, dispatched } = setup();
  route({ type: "room-closed", takenDown: true });
  expect(pending.size).toBe(0);
  expect(dispatched).toEqual([{ type: "room-closed", takenDown: true }]);
});

test("disconnected stops the clock too", () => {
  const { pending, route } = setup();
  route({ type: "disconnected" });
  expect(pending.size).toBe(0);
});

test("connecting leaves the clock running", () => {
  const { pending, route } = setup();
  route({ type: "connecting" });
  expect(pending.size).toBeGreaterThan(0);
});

test("emoted goes straight to the scene's emote sink, never through the view state (OME-415)", () => {
  const { route, dispatched, emoted } = setup();
  route({ type: "message", msg: { type: "emoted", memberId: "m1", kind: "wave" } });
  expect(emoted).toEqual([["m1", "wave"]]);
  expect(dispatched).toEqual([]);
});

test("kicked (4005, ADR 0030) stops the clock and dispatches the cooldown's end from the kick memory", () => {
  const { pending, route, dispatched } = setup();
  route({ type: "kicked", wasIn: true });
  expect(pending.size).toBe(0);
  expect(dispatched).toEqual([{ type: "kicked", until: 600_000 }]);
});

test("a bounce whose cooldown end is unknown dispatches until: null", () => {
  const { route, dispatched } = setup();
  route({ type: "kicked", wasIn: false });
  expect(dispatched).toEqual([{ type: "kicked", until: null }]);
});

// OME-769 (M9 W3): "Hide for me" filters at intake, before the state, the log, the bubbles, the pop-outs or the live
// region see a thing, so nothing per frame ever asks who is hidden.
test("a hidden member's chat and emotes stop at intake: no dispatch, no emote", () => {
  const { route, dispatched, emoted } = setup(["m2"]);
  route({ type: "message", msg: { type: "chat", memberId: "m2", text: "boo", at: 1 } });
  route({ type: "message", msg: { type: "emoted", memberId: "m2", kind: "wave" } });
  route({ type: "message", msg: { type: "rolled", memberId: "m2", sides: 6, value: 6 } });
  expect(dispatched).toEqual([]);
  expect(emoted).toEqual([]);
});

test("everyone else's chat, and a hidden member's other messages (seat, leave), still go through", () => {
  const { route, dispatched, emoted } = setup(["m2"]);
  route({ type: "message", msg: { type: "chat", memberId: "m1", text: "hi", at: 1 } });
  route({ type: "message", msg: { type: "emoted", memberId: "m1", kind: "wave" } });
  route({ type: "message", msg: { type: "seat-changed", memberId: "m2", seat: 3 } });
  route({ type: "message", msg: { type: "member-left", memberId: "m2" } });
  expect(dispatched.map((e) => (e.type === "server" ? e.msg.type : e.type))).toEqual(["chat", "seat-changed", "member-left"]);
  expect(emoted).toEqual([["m1", "wave"]]);
});

// OME-911 (ADR 0043): durable sessions.
const TOKEN = "A".repeat(43);

test("a session token goes to the session sink only, never to the state", () => {
  const { route, dispatched, sessions } = setup();
  route({ type: "session", token: TOKEN });
  expect(sessions).toEqual([TOKEN]);
  expect(dispatched).toEqual([]);
});

test("an expired or replaced session stops the clock and reaches the state", () => {
  for (const type of ["expired", "replaced"] as const) {
    const { pending, route, dispatched } = setup();
    route({ type });
    expect(pending.size).toBe(0);
    expect(dispatched).toEqual([{ type }]);
  }
});

// OME-1390: typing-changed goes straight to the scene's typing sink, never the view state; a hidden member's stops at intake.
test("typing-changed goes to the typing sink only; a hidden member's goes nowhere", () => {
  const typed: [string, boolean][] = [];
  const { route, dispatched } = setup(["m2"], (id, on) => typed.push([id, on]));
  route({ type: "message", msg: { type: "typing-changed", memberId: "m1", on: true } });
  route({ type: "message", msg: { type: "typing-changed", memberId: "m2", on: true } });
  expect(typed).toEqual([["m1", true]]);
  expect(dispatched).toEqual([]);
});

// OME-1627: a batch is unwrapped at the connection, so a hidden member's chat inside one still stops at intake.
test("a hidden member's chat inside a batch frame stays hidden; the rest of the batch goes through in order", () => {
  const { route, dispatched, emoted } = setup(["m2"]);
  let socket: SocketLike | null = null;
  const conn = createConnection({
    url: "ws://x",
    join: { type: "join", nickname: "zoe", avatar: 1 },
    createSocket: () => {
      const s: SocketLike = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
      socket = s;
      return s;
    },
    onEvent: route,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const s: SocketLike | null = socket;
  if (s === null) throw new Error("no socket");
  const receive = (msg: unknown): void => s.onmessage?.({ data: JSON.stringify(msg) });
  receive({ type: "batch", msgs: [
    { type: "chat", memberId: "m2", text: "boo", at: 1 },
    { type: "emoted", memberId: "m2", kind: "wave" },
    { type: "chat", memberId: "m1", text: "hi", at: 2 },
    { type: "member-left", memberId: "m2" },
  ] });
  conn.close();
  expect(dispatched.map((e) => (e.type === "server" ? e.msg.type : e.type))).toEqual(["chat", "member-left"]);
  expect(dispatched.some((e) => e.type === "server" && e.msg.type === "chat" && e.msg.memberId === "m2")).toBe(false);
  expect(emoted).toEqual([]);
});
