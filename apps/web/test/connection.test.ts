import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "@omega/shared";
import { HANDSHAKE_TIMEOUT_MS, createConnection, type ConnectionEvent, type SocketLike } from "../src/connection";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  open(): void {
    this.onopen?.();
  }
  receive(msg: ServerMessage | string): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }
}

let sockets: FakeSocket[];
let events: ConnectionEvent[];
let timers: { id: number; fn: () => void; ms: number }[];
let nextId = 0;

function connect(random: () => number = () => 1) {
  return createConnection({
    url: "ws://x/rooms/lobby/ws",
    join: { type: "join", nickname: "zoe", avatar: 1 },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onEvent: (e) => events.push(e),
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    random,
  });
}

function last(): FakeSocket {
  const s = sockets.at(-1);
  if (s === undefined) throw new Error("no socket");
  return s;
}

/** Runs the pending reconnect (backoff) timer, not the handshake timeout. */
function runTimer(): number {
  const t = timers.find((x) => x.ms !== HANDSHAKE_TIMEOUT_MS);
  if (t !== undefined) timers = timers.filter((x) => x !== t);
  if (t === undefined) throw new Error("no timer");
  t.fn();
  return t.ms;
}

const snapshot: ServerMessage = {
  type: "snapshot",
  self: "m1",
  room: { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [], embed: null },
};

beforeEach(() => {
  sockets = [];
  events = [];
  timers = [];
});

describe("createConnection", () => {
  test("opens one socket and sends join when it opens", () => {
    connect();
    expect(sockets).toHaveLength(1);
    expect(events).toEqual([{ type: "connecting" }]);
    last().open();
    expect(last().sent.map((s) => JSON.parse(s) as unknown)).toEqual([{ type: "join", nickname: "zoe", avatar: 1 }]);
  });

  test("delivers parsed server messages and drops invalid frames", () => {
    connect();
    last().open();
    last().receive("not json");
    last().receive(JSON.stringify({ type: "seat-changed", memberId: "m1", seat: 99 }));
    last().onmessage?.({ data: new ArrayBuffer(4) });
    last().receive(snapshot);
    expect(events.filter((e) => e.type === "message")).toEqual([{ type: "message", msg: snapshot }]);
  });

  test("send serializes while open and refuses otherwise", () => {
    const c = connect();
    expect(c.send({ type: "sit", seat: 3 })).toBe(false);
    last().open();
    expect(c.send({ type: "sit", seat: 3 })).toBe(true);
    expect(last().sent.at(-1)).toBe(JSON.stringify({ type: "sit", seat: 3 }));
  });

  test("reconnects with growing, capped backoff and resets after a snapshot", () => {
    connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      last().drop();
      delays.push(runTimer());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(sockets).toHaveLength(7);
    last().open();
    last().receive(snapshot);
    last().drop();
    expect(runTimer()).toBe(500);
    expect(events.filter((e) => e.type === "disconnected")).toHaveLength(7);
  });

  test("room-full stops reconnecting", () => {
    connect();
    last().open();
    last().receive({ type: "room-full" });
    last().drop();
    expect(timers).toHaveLength(0);
  });

  test("close() closes the socket, never reconnects and reports no disconnect", () => {
    const c = connect();
    last().open();
    c.close();
    expect(last().closed).toBe(true);
    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    expect(events.some((e) => e.type === "disconnected")).toBe(false);
  });

  test("backoff is jittered down to half the nominal delay", () => {
    connect(() => 0);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      last().drop();
      delays.push(runTimer());
    }
    expect(delays).toEqual([250, 500, 1000]);
  });

  test("a socket that gets no snapshot within the handshake timeout is dropped and retried", () => {
    connect();
    last().open();
    const hs = timers.find((t) => t.ms === HANDSHAKE_TIMEOUT_MS);
    expect(hs).toBeDefined();
    hs?.fn();
    expect(sockets[0]?.closed).toBe(true);
    expect(runTimer()).toBe(500);
    expect(sockets).toHaveLength(2);
  });

  test("the handshake timeout is cancelled by a snapshot", () => {
    connect();
    last().open();
    last().receive(snapshot);
    expect(timers.some((t) => t.ms === HANDSHAKE_TIMEOUT_MS)).toBe(false);
  });

  test("resume() reconnects after close(), e.g. a page restored from bfcache", () => {
    const c = connect();
    last().open();
    c.close();
    c.resume();
    expect(sockets).toHaveLength(2);
    last().open();
    expect(c.send({ type: "sit", seat: 0 })).toBe(true);
  });

  test("resume() does nothing while a socket is live, or after room-full", () => {
    const c = connect();
    c.resume();
    expect(sockets).toHaveLength(1);
    last().open();
    last().receive({ type: "room-full" });
    last().drop();
    c.resume();
    expect(sockets).toHaveLength(1);
  });
});
