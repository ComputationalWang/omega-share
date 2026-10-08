import { beforeEach, describe, expect, test } from "bun:test";
import { CLOSE_CODES, RATE_LIMITED_RECONNECT_MS, type ServerMessage } from "@omega/shared";
import { HANDSHAKE_TIMEOUT_MS, REFUSED_RETRY_BUDGET_MS, createConnection, type ConnectionEvent, type SocketLike } from "../src/connection";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCode: number | null = null;
  /** Like a real socket: close() only starts the closing handshake; finishClose() delivers onclose later. */
  deferClose = false;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1005): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    if (!this.deferClose) this.onclose?.({ code });
  }
  finishClose(): void {
    this.onclose?.({ code: this.closeCode ?? 1005 });
  }
  open(): void {
    this.onopen?.();
  }
  receive(msg: ServerMessage | string): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  /** The server (or the network) closes the socket; 1006 is an abnormal drop. */
  drop(code = 1006): void {
    this.closed = true;
    this.onclose?.({ code });
  }
}

let sockets: FakeSocket[];
let events: ConnectionEvent[];
let timers: { id: number; fn: () => void; ms: number }[];
let nextId = 0;

function connect(random: () => number = () => 1, onOpen?: () => void) {
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
    ...(onOpen === undefined ? {} : { onOpen }),
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

/** Runs the only pending timer, which must be the reconnect: its delay can equal the handshake timeout. */
function runRetry(): number {
  expect(timers).toHaveLength(1);
  const t = timers.pop();
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

  test("onOpen runs before join, with the socket already sendable (clock pings go first)", () => {
    let opens = 0;
    const conn = connect(undefined, () => {
      opens++;
      expect(conn.send({ type: "ping", id: 7 })).toBe(true);
    });
    last().open();
    expect(opens).toBe(1);
    expect(last().sent.map((x) => JSON.parse(x) as unknown)).toEqual([
      { type: "ping", id: 7 },
      { type: "join", nickname: "zoe", avatar: 1 },
    ]);
    last().drop();
    runTimer();
    last().open();
    expect(opens).toBe(2);
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

describe("close codes (ADR 0016 §5)", () => {
  test("4029 rate-limited: waits RATE_LIMITED_RECONNECT_MS before reconnecting, jitter or not", () => {
    connect(() => 0);
    last().open();
    last().receive(snapshot);
    last().drop(CLOSE_CODES.RATE_LIMITED);
    expect(RATE_LIMITED_RECONNECT_MS).toBe(10_000);
    expect(runRetry()).toBe(10_000);
    expect(sockets).toHaveLength(2);
  });

  test("4400 bad messages: reconnects at the maximum backoff, even on the first drop", () => {
    connect(() => 0);
    last().open();
    last().receive(snapshot);
    last().drop(CLOSE_CODES.BAD_MESSAGES);
    expect(runRetry()).toBe(5000);
  });

  test("4001 join timeout and 1006 drops reconnect with the normal backoff", () => {
    connect();
    last().open();
    last().drop(CLOSE_CODES.JOIN_TIMEOUT);
    expect(runRetry()).toBe(500);
    last().drop(1006);
    expect(runRetry()).toBe(1000);
  });

  test("4002 room full: stops, even if the room-full message was lost", () => {
    const c = connect();
    last().open();
    last().drop(CLOSE_CODES.ROOM_FULL);
    expect(timers).toHaveLength(0);
    c.resume();
    expect(sockets).toHaveLength(1);
  });
});

describe("refused joins and rate_limited (ADR 0016 §4)", () => {
  const error = (code: "nickname_taken" | "too_many_members" | "rate_limited" | "seat_taken", retryAfterMs?: number): ServerMessage => ({
    type: "error",
    code,
    message: "no",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  for (const code of ["nickname_taken", "too_many_members"] as const) {
    test(`${code}: delivers the error, closes the unjoined socket and never rejoins with the same name`, () => {
      const c = connect();
      last().open();
      last().receive(error(code));
      expect(events.slice(-2)).toEqual([{ type: "message", msg: error(code) }, { type: "disconnected" }]);
      expect(last().closed).toBe(true);
      expect(last().closeCode).toBe(1000);
      expect(timers).toHaveLength(0);
      c.resume();
      expect(sockets).toHaveLength(1);
      expect(c.send({ type: "sit", seat: 0 })).toBe(false);
    });
  }

  for (const code of ["nickname_taken", "too_many_members"] as const) {
    test(`${code} on a reconnect is retried: the server may still hold our dead member until it sees the old socket close`, () => {
      connect(() => 0);
      last().open();
      last().receive(snapshot);
      last().drop();
      runRetry();
      last().open();
      const before = events.length;
      last().receive(error(code));
      expect(last().closed).toBe(true);
      // No refusal reaches the room (no card for our own name), only the drop.
      expect(events.slice(before)).toEqual([{ type: "disconnected" }]);
      // Never sooner than the un-jittered backoff, even with jitter at its minimum.
      expect(runRetry()).toBe(1000);
      expect(sockets).toHaveLength(3);
      last().open();
      last().receive(snapshot);
      expect(events.at(-1)).toEqual({ type: "message", msg: snapshot });
    });

    test(`${code} on a reconnect gives up after REFUSED_RETRY_BUDGET_MS of refusals and then shows the refusal`, () => {
      const c = connect();
      last().open();
      last().receive(snapshot);
      last().drop();
      runRetry();
      let waited = 0;
      for (let i = 0; i < 100; i++) {
        last().open();
        last().receive(error(code));
        if (timers.length === 0) break;
        waited += runRetry();
      }
      expect(timers).toHaveLength(0);
      expect(waited).toBeGreaterThanOrEqual(REFUSED_RETRY_BUDGET_MS - 5000);
      expect(waited).toBeLessThan(REFUSED_RETRY_BUDGET_MS + 5000);
      expect(events.slice(-2)).toEqual([{ type: "message", msg: error(code) }, { type: "disconnected" }]);
      c.resume();
      expect(timers).toHaveLength(0);
    });

    test(`${code} retries get a fresh budget after the next snapshot`, () => {
      connect();
      last().open();
      last().receive(snapshot);
      for (let round = 0; round < 2; round++) {
        last().drop();
        runRetry();
        let waited = 0;
        while (waited < REFUSED_RETRY_BUDGET_MS - 10_000) {
          last().open();
          last().receive(error(code));
          waited += runRetry();
        }
        last().open();
        last().receive(snapshot);
      }
      expect(events.at(-1)).toEqual({ type: "message", msg: snapshot });
    });
  }

  test("rate_limited before the snapshot (join limiter): closes and rejoins only after retryAfterMs", () => {
    connect();
    last().open();
    last().receive(error("rate_limited", 3000));
    expect(last().closed).toBe(true);
    expect(runRetry()).toBe(3000);
    expect(sockets).toHaveLength(2);
  });

  test("rate_limited before the snapshot never rejoins sooner than the normal backoff", () => {
    connect();
    for (let i = 0; i < 3; i++) {
      last().drop();
      runRetry();
    }
    last().open();
    last().receive(error("rate_limited", 100));
    expect(runRetry()).toBe(4000);
  });

  test("rate_limited before the snapshot without a hint (pre-M3 server) waits RATE_LIMITED_RECONNECT_MS", () => {
    connect();
    last().open();
    last().receive(error("rate_limited"));
    expect(last().closed).toBe(true);
    expect(runRetry()).toBe(RATE_LIMITED_RECONNECT_MS);
  });

  test("rate_limited after joining is only reported: the socket stays up and nothing is retried", () => {
    const c = connect();
    last().open();
    last().receive(snapshot);
    const sent = last().sent.length;
    last().receive(error("rate_limited", 2000));
    expect(events.at(-1)).toEqual({ type: "message", msg: error("rate_limited", 2000) });
    expect(last().closed).toBe(false);
    expect(timers).toHaveLength(0);
    expect(last().sent).toHaveLength(sent);
    expect(c.send({ type: "sit", seat: 1 })).toBe(true);
  });

  test("other errors before the snapshot keep the socket (the handshake timeout still applies)", () => {
    connect();
    last().open();
    last().receive(error("seat_taken"));
    expect(last().closed).toBe(false);
  });
});

describe("close handshakes that finish later (real sockets)", () => {
  test("resume() right after close(), before the old socket's close lands, still reconnects", () => {
    const c = connect();
    last().open();
    last().receive(snapshot);
    const old = last();
    old.deferClose = true;
    c.close();
    c.resume();
    old.finishClose();
    expect(sockets).toHaveLength(2);
    last().open();
    expect(c.send({ type: "sit", seat: 0 })).toBe(true);
  });

  test("a rate_limited hint doesn't outlive close(): after resume() a plain drop uses the normal backoff", () => {
    const c = connect();
    last().open();
    const old = last();
    old.deferClose = true;
    old.receive({ type: "error", code: "rate_limited", message: "slow", retryAfterMs: 30_000 });
    c.close();
    c.resume();
    old.finishClose();
    last().drop();
    expect(runRetry()).toBe(500);
  });
});

describe("created rooms (ADR 0028)", () => {
  test("4004 room closed: reports room-closed instead of a drop, stops and never reconnects", () => {
    const c = connect();
    last().open();
    last().receive(snapshot);
    last().drop(CLOSE_CODES.ROOM_CLOSED);
    expect(events.at(-1)).toEqual({ type: "room-closed" });
    expect(events).not.toContainEqual({ type: "disconnected" });
    expect(timers).toHaveLength(0);
    c.resume();
    expect(sockets).toHaveLength(1);
  });

  test("4004 before a snapshot (the room went while we joined) stops too", () => {
    connect();
    last().drop(CLOSE_CODES.ROOM_CLOSED);
    expect(events.at(-1)).toEqual({ type: "room-closed" });
    expect(timers).toHaveLength(0);
  });

  test("invite_required: a private room refused our join, so the unjoined socket is closed and never retried", () => {
    const refusal: ServerMessage = { type: "error", code: "invite_required", message: "private" };
    const c = connect();
    last().open();
    last().receive(refusal);
    expect(events.slice(-2)).toEqual([{ type: "message", msg: refusal }, { type: "disconnected" }]);
    expect(last().closed).toBe(true);
    expect(timers).toHaveLength(0);
    c.resume();
    expect(sockets).toHaveLength(1);
  });

  test("invite_required on a rejoin is final at once: unlike a name, a refused key is never our own dead member", () => {
    const refusal: ServerMessage = { type: "error", code: "invite_required", message: "private" };
    connect();
    last().open();
    last().receive(snapshot);
    last().drop();
    runRetry();
    last().open();
    last().receive(refusal);
    expect(events.slice(-2)).toEqual([{ type: "message", msg: refusal }, { type: "disconnected" }]);
    expect(timers).toHaveLength(0);
  });

  test("the join carries what the caller gave it (owner token, invite key) unchanged", () => {
    const join = { type: "join", nickname: "zoe", avatar: 1, ownerToken: "o".repeat(22), inviteKey: "k".repeat(22) } as const;
    createConnection({
      url: "ws://x/rooms/r/ws",
      join,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onEvent: (e) => events.push(e),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    last().open();
    expect(JSON.parse(last().sent.at(-1) ?? "null")).toEqual(join);
  });
});
