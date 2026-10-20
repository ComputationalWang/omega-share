import { describe, expect, test } from "bun:test";
import type { ClientMessage, RoomLayout } from "@omega/shared";
import { createPads, otherPad } from "../src/walk/pad";

// OME-1548: stand on a teleport pad for 400 ms and the walk to the other pad is sent; stepping off cancels it.

const LAYOUT: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "pad", col: 3, row: 3, facing: "se" },
    { kind: "pad", col: 6, row: 6, facing: "se", variant: 1 },
  ],
};

function setup() {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const sent: ClientMessage[] = [];
  const pads = createPads({
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      for (const t of timers) if (t === h) t.live = false;
    },
    send: (m) => sent.push(m),
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false;
        t.fn();
      }
    }
  };
  return { pads, sent, advance };
}

describe("otherPad", () => {
  test("the pad a pad leads to", () => {
    expect(otherPad(LAYOUT, { x: 3, y: 3 })).toEqual({ x: 6, y: 6 });
    expect(otherPad(LAYOUT, { x: 6, y: 6 })).toEqual({ x: 3, y: 3 });
  });
  test("null off a pad, and with only one pad", () => {
    expect(otherPad(LAYOUT, { x: 4, y: 4 })).toBeNull();
    expect(otherPad({ furniture: LAYOUT.furniture.slice(0, 2) }, { x: 3, y: 3 })).toBeNull();
  });
});

describe("createPads", () => {
  test("after 400 ms on a pad I walked to, a teleport walk goes to the other pad", () => {
    const { pads, sent, advance } = setup();
    pads.walkSent();
    pads.stopped(LAYOUT, { x: 3, y: 3 });
    advance(399);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual([{ type: "walk", cell: { x: 6, y: 6 }, teleport: true }]);
  });
  test("a new walk within the 400 ms cancels it", () => {
    const { pads, sent, advance } = setup();
    pads.walkSent();
    pads.stopped(LAYOUT, { x: 3, y: 3 });
    advance(200);
    pads.walkSent();
    advance(1000);
    expect(sent).toEqual([]);
  });
  test("cancel (a seat click) stops it too", () => {
    const { pads, sent, advance } = setup();
    pads.walkSent();
    pads.stopped(LAYOUT, { x: 3, y: 3 });
    pads.cancel();
    advance(1000);
    expect(sent).toEqual([]);
  });
  test("coming to rest on a pad without having walked (a teleport's arrival, a snapshot) does nothing: no loops", () => {
    const { pads, sent, advance } = setup();
    pads.stopped(LAYOUT, { x: 6, y: 6 });
    advance(1000);
    expect(sent).toEqual([]);
  });
  test("one arrival is one teleport; stepping off and back on is another", () => {
    const { pads, sent, advance } = setup();
    pads.walkSent();
    pads.stopped(LAYOUT, { x: 3, y: 3 });
    advance(400);
    pads.stopped(LAYOUT, { x: 6, y: 6 });
    advance(1000);
    expect(sent).toHaveLength(1);
    pads.walkSent();
    pads.stopped(LAYOUT, { x: 6, y: 6 });
    advance(400);
    expect(sent).toHaveLength(2);
  });
  test("resting off a pad, or with no cell, sends nothing", () => {
    const { pads, sent, advance } = setup();
    pads.walkSent();
    pads.stopped(LAYOUT, { x: 4, y: 4 });
    pads.walkSent();
    pads.stopped(LAYOUT, undefined);
    advance(1000);
    expect(sent).toEqual([]);
  });
});
