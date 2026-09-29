import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "@omega/shared";
import { createConnection, type ConnectionEvent, type SocketLike } from "../src/connection";

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
let timers: { fn: () => void; ms: number }[];

function connect() {
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
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
}

function last(): FakeSocket {
  const s = sockets.at(-1);
  if (s === undefined) throw new Error("no socket");
  return s;
}

function runTimer(): number {
  const t = timers.shift();
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

  test("close() closes the socket and never reconnects", () => {
    const c = connect();
    last().open();
    c.close();
    expect(last().closed).toBe(true);
    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });
});
