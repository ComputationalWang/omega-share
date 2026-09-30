import { beforeEach, describe, expect, test } from "bun:test";
import { PING_ID_MAX } from "@omega/shared";
import {
  BURST_GAP_MS,
  BURST_PINGS,
  MAX_RTT_MS,
  PING_INTERVAL_MS,
  SLEEP_GAP_MS,
  WINDOW_SIZE,
  createClockSync,
  type ClockSync,
  type ListenerTarget,
} from "../src/clock";

let t: number;
let pings: { id: number; t0: number }[];
let timers: { id: number; fn: () => void; at: number }[];
let nextTimer: number;
let canSend: boolean;

class FakeTarget implements ListenerTarget {
  visibilityState = "visible";
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function make(extra: { win?: FakeTarget; doc?: FakeTarget; startId?: number } = {}): ClockSync {
  return createClockSync({
    now: () => t,
    sendPing: (id) => {
      if (!canSend) return false;
      pings.push({ id, t0: t });
      return true;
    },
    setTimer: (fn, ms) => {
      const id = ++nextTimer;
      timers.push({ id, fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((x) => x.id !== id);
    },
    ...(extra.win === undefined ? {} : { window: extra.win }),
    ...(extra.doc === undefined ? {} : { document: extra.doc }),
    ...(extra.startId === undefined ? {} : { startId: extra.startId }),
  });
}

/** Moves the fake clock forward, firing due timers in order. */
function advance(ms: number): void {
  const end = t + ms;
  for (;;) {
    const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
    if (due === undefined) break;
    timers = timers.filter((x) => x !== due);
    t = Math.max(t, due.at);
    due.fn();
  }
  t = end;
}

/** Answers the latest ping after `rtt` ms with a server clock `offset` ahead, the reply stamped mid-flight. */
function pong(clock: ClockSync, rtt: number, offset: number): void {
  const p = pings[pings.length - 1];
  if (p === undefined) throw new Error("no ping sent");
  t = p.t0 + rtt;
  clock.onPong(p.id, Math.round(p.t0 + rtt / 2 + offset));
}

/** Fires the next scheduled ping without answering anything. */
function nextPing(): void {
  const next = [...timers].sort((a, b) => a.at - b.at)[0];
  if (next === undefined) throw new Error("no timer");
  advance(Math.max(0, next.at - t));
}

beforeEach(() => {
  t = 1_000_000;
  pings = [];
  timers = [];
  nextTimer = 0;
  canSend = true;
});

describe("createClockSync", () => {
  test("not ready before the first pong", () => {
    const clock = make();
    expect(clock.ready).toBe(false);
    expect(clock.offsetMs).toBe(0);
    clock.start();
    expect(clock.ready).toBe(false);
    expect(clock.serverNow()).toBe(t);
  });

  test("start bursts 5 pings 200 ms apart, then one every 15 s", () => {
    const clock = make();
    clock.start();
    advance(BURST_GAP_MS * (BURST_PINGS - 1));
    expect(pings.map((p) => p.t0 - 1_000_000)).toEqual([0, 200, 400, 600, 800]);
    advance(PING_INTERVAL_MS - 1);
    expect(pings).toHaveLength(5);
    advance(1);
    expect(pings).toHaveLength(6);
    advance(PING_INTERVAL_MS);
    expect(pings).toHaveLength(7);
    expect(new Set(pings.map((p) => p.id)).size).toBe(7);
    expect(timers).toHaveLength(1);
  });

  test("one pong: offset = at − (t0 + t3)/2 and serverNow = now + offset", () => {
    const clock = make();
    clock.start();
    const p = pings[0];
    if (p === undefined) throw new Error("no ping");
    t = p.t0 + 40;
    clock.onPong(p.id, p.t0 + 5020);
    expect(clock.ready).toBe(true);
    expect(clock.offsetMs).toBe(5000);
    t += 1234;
    expect(clock.serverNow()).toBe(t + 5000);
  });

  test.each([
    { name: "first is fastest", samples: [[10, 100], [50, 200], [30, 300]], want: 100 },
    { name: "last is fastest", samples: [[80, 100], [50, 200], [20, 300]], want: 300 },
    { name: "middle is fastest", samples: [[80, 100], [4, 200], [20, 300], [90, 400]], want: 200 },
    { name: "a tie keeps the earlier sample", samples: [[20, 100], [20, 200]], want: 100 },
    { name: "a single slow sample still counts", samples: [[480, -250]], want: -250 },
  ])("min-RTT selection: $name", ({ samples, want }) => {
    const clock = make();
    clock.start();
    for (const [rtt, offset] of samples) {
      pong(clock, rtt, offset);
      nextPing();
    }
    expect(clock.offsetMs).toBe(want);
  });

  test.each([
    { rtt: 500, accepted: true },
    { rtt: 501, accepted: false },
    { rtt: 5000, accepted: false },
  ])("RTT $rtt ms accepted=$accepted (limit MAX_RTT_MS)", ({ rtt, accepted }) => {
    expect(MAX_RTT_MS).toBe(500);
    const clock = make();
    clock.start();
    // The burst moves on meanwhile; answer the first ping late.
    const p = pings[0];
    if (p === undefined) throw new Error("no ping");
    advance(rtt);
    clock.onPong(p.id, p.t0 + 7000);
    expect(clock.ready).toBe(accepted);
  });

  test("a rejected slow sample doesn't displace the current one", () => {
    const clock = make();
    clock.start();
    pong(clock, 30, 100);
    nextPing();
    pong(clock, 900, -9000);
    expect(clock.offsetMs).toBe(100);
  });

  test("unknown, duplicate and stale pong ids are ignored", () => {
    const clock = make();
    clock.start();
    clock.onPong(12345, 999_999_999);
    expect(clock.ready).toBe(false);
    pong(clock, 30, 100);
    const p = pings[0];
    if (p === undefined) throw new Error("no ping");
    clock.onPong(p.id, 1); // duplicate
    expect(clock.offsetMs).toBe(100);
  });

  test("window eviction: the 9th sample evicts the 1st", () => {
    expect(WINDOW_SIZE).toBe(8);
    const clock = make();
    clock.start();
    pong(clock, 6, 111); // the best, until evicted
    for (let i = 1; i < WINDOW_SIZE; i++) {
      nextPing();
      pong(clock, 50 + 2 * i, i === 3 ? 333 : 0);
    }
    expect(clock.offsetMs).toBe(111);
    nextPing();
    pong(clock, 60, 0);
    // Remaining: rtts 52..64 and 60; the fastest is 52 (offset 0).
    expect(clock.offsetMs).toBe(0);
  });

  test("window eviction keeps the fastest of the last 8", () => {
    const clock = make();
    clock.start();
    const rtts = [40, 30, 20, 10, 50, 60, 70, 80, 90, 100, 110, 120];
    for (const [i, rtt] of rtts.entries()) {
      if (i > 0) nextPing();
      pong(clock, rtt, i * 10);
    }
    // Last 8 are indices 4..11 (rtts 50..120); the fastest is index 4.
    expect(clock.offsetMs).toBe(40);
  });

  test.each([
    { gap: SLEEP_GAP_MS, reset: false },
    { gap: SLEEP_GAP_MS + 1, reset: true },
    { gap: 60 * 60 * 1000, reset: true },
  ])("tick gap $gap ms → reset=$reset", ({ gap, reset }) => {
    expect(SLEEP_GAP_MS).toBe(2000);
    const clock = make();
    clock.start();
    pong(clock, 20, 100);
    clock.tick();
    const before = pings.length;
    t += gap; // the OS slept: no timers fired
    clock.tick();
    expect(clock.ready).toBe(!reset);
    expect(pings.length).toBe(reset ? before + 1 : before);
    if (reset) {
      // A fresh burst, and the old sample is gone for good.
      pong(clock, 300, -40);
      expect(clock.offsetMs).toBe(-40);
    }
  });

  test("steady ticks under the gap never reset", () => {
    const clock = make();
    clock.start();
    pong(clock, 20, 100);
    for (let i = 0; i < 50; i++) {
      advance(1000);
      clock.tick();
    }
    expect(clock.ready).toBe(true);
  });

  test("resync clears the window and restarts the burst", () => {
    const clock = make();
    clock.start();
    pong(clock, 20, 100);
    advance(20_000);
    const before = pings.length;
    clock.resync();
    expect(clock.ready).toBe(false);
    advance(BURST_GAP_MS * (BURST_PINGS - 1));
    expect(pings.length).toBe(before + BURST_PINGS);
    expect(timers).toHaveLength(1);
  });

  test("online and visibilitychange→visible resync; hidden does not", () => {
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const clock = make({ win, doc });
    clock.start();
    pong(clock, 20, 100);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(clock.ready).toBe(true);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(clock.ready).toBe(false);
    pong(clock, 20, 100);
    win.fire("online");
    expect(clock.ready).toBe(false);
  });

  test("stop halts pings but keeps the offset; start bursts again", () => {
    const clock = make();
    clock.start();
    pong(clock, 20, 100);
    clock.stop();
    expect(timers).toHaveLength(0);
    expect(clock.ready).toBe(true);
    const before = pings.length;
    clock.start();
    expect(pings.length).toBe(before + 1);
    expect(clock.offsetMs).toBe(100);
  });

  test("resync while stopped clears the window without pinging", () => {
    const clock = make();
    clock.start();
    pong(clock, 20, 100);
    clock.stop();
    const before = pings.length;
    clock.resync();
    expect(clock.ready).toBe(false);
    expect(pings.length).toBe(before);
    expect(timers).toHaveLength(0);
  });

  test("a failed send records nothing and keeps the schedule", () => {
    canSend = false;
    const clock = make();
    clock.start();
    clock.onPong(0, 5);
    expect(clock.ready).toBe(false);
    expect(timers).toHaveLength(1);
  });

  test("destroy leaves no timers or listeners, and start no-ops after", () => {
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const clock = make({ win, doc });
    expect(win.count() + doc.count()).toBe(2);
    clock.start();
    clock.tick();
    clock.destroy();
    expect(timers).toHaveLength(0);
    expect(win.count() + doc.count()).toBe(0);
    clock.start();
    clock.resync();
    advance(60_000);
    expect(timers).toHaveLength(0);
    expect(pings).toHaveLength(1);
  });

  test("ping ids wrap to 0 after PING_ID_MAX", () => {
    const clock = make({ startId: PING_ID_MAX - 1 });
    clock.start();
    nextPing();
    nextPing();
    expect(pings.map((p) => p.id)).toEqual([PING_ID_MAX - 1, PING_ID_MAX, 0]);
    pong(clock, 20, 77);
    expect(clock.offsetMs).toBe(77);
  });
});
