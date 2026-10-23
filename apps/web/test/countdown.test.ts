import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaybackState } from "@omega/shared";
import { createCountdown } from "../src/countdown/countdown";

// OME-1634 (ADR 0056): the shared 3-2-1. A `playback` with `startAt` shows 3, 2, 1 on the server clock and goes at
// startAt; the lights go down on 1; a pause or seek (a playback without startAt) cancels it. Reduced motion and the
// basic tier show a plain number.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const T0 = 1_000_000;
const playing: PlaybackState = { playing: true, position: 42, rate: 1, at: T0, rev: 4, action: "play", by: "b" };
const counting: PlaybackState = { ...playing, startAt: T0 + 3000 };

function harness(plain = false) {
  let now = T0;
  let changes = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const cd = createCountdown({
    serverNow: () => now,
    plain: () => plain,
    onChange: () => {
      changes++;
    },
    setTimer: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (t) => {
      timers.delete(t);
    },
  });
  /** Moves the server clock to `to`, firing due timers in order. */
  const advance = (to: number): void => {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = to;
  };
  const shown = (): string | null => (cd.el.hidden ? null : cd.el.textContent);
  return { cd, advance, shown, changes: () => changes, timers };
}

describe("the 3-2-1 overlay", () => {
  test("counts 3, 2, 1 on the server clock and is gone at startAt; the lights go down on 1", () => {
    const h = harness();
    expect(h.shown()).toBeNull();
    h.cd.set(counting);
    expect([h.shown(), h.cd.lit()]).toEqual(["3", false]);
    h.advance(T0 + 999);
    expect(h.shown()).toBe("3");
    h.advance(T0 + 1000);
    expect([h.shown(), h.cd.lit()]).toEqual(["2", false]);
    h.advance(T0 + 2000);
    expect([h.shown(), h.cd.lit()]).toEqual(["1", true]);
    h.advance(T0 + 3000);
    expect([h.shown(), h.cd.lit()]).toEqual([null, true]);
    expect(h.changes()).toBe(4);
    expect(h.timers.size).toBe(0);
  });

  test("a late joiner sees the digit it joins on", () => {
    const h = harness();
    h.advance(T0 + 1500);
    h.cd.set(counting);
    expect(h.shown()).toBe("2");
  });

  test("a playback without startAt (a pause or a seek) cancels it; a passed startAt shows nothing", () => {
    const h = harness();
    h.cd.set(counting);
    h.advance(T0 + 500);
    h.cd.set({ ...playing, playing: false, action: "pause", at: T0 + 500, rev: 5 });
    expect([h.shown(), h.cd.lit()]).toEqual([null, true]);
    expect(h.timers.size).toBe(0);
    h.advance(T0 + 4000);
    h.cd.set(counting);
    expect(h.shown()).toBeNull();
    h.cd.set(null);
    expect(h.shown()).toBeNull();
  });

  test("the same state again doesn't restart it", () => {
    const h = harness();
    h.cd.set(counting);
    h.advance(T0 + 1200);
    h.cd.set(counting);
    expect(h.timers.size).toBe(1);
    expect(h.shown()).toBe("2");
  });

  test("is a status for screen readers, and plain (no animation) under reduced motion or the basic tier", () => {
    const fancy = harness(false);
    fancy.cd.set(counting);
    expect(fancy.cd.el.getAttribute("role")).toBe("status");
    expect(fancy.cd.el.dataset["plain"]).toBeUndefined();
    const plain = harness(true);
    plain.cd.set(counting);
    expect(plain.cd.el.dataset["plain"]).toBe("true");
  });

  test("destroy stops the timer", () => {
    const h = harness();
    h.cd.set(counting);
    h.cd.destroy();
    expect(h.timers.size).toBe(0);
  });
});
