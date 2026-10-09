import { expect, test } from "bun:test";
import { createClockSync } from "../src/clock";
import type { ConnectionEvent } from "../src/connection";
import { routeConnectionEvent } from "../src/room-events";
import type { ViewEvent } from "../src/state";

/** A real clock on fake timers: which timers are still pending after the event. */
function setup(): { pending: Set<number>; route: (e: ConnectionEvent) => void; dispatched: ViewEvent[]; emoted: [string, string][] } {
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
  const sinks = {
    emoted: (memberId: string, kind: string) => emoted.push([memberId, kind]),
    clock,
    shareToken: { onEvent: () => undefined },
    joined: () => undefined,
    kicked: (wasIn: boolean) => (wasIn ? 600_000 : null),
    dispatch: (e: ViewEvent) => dispatched.push(e),
  };
  return { pending, route: (e) => { routeConnectionEvent(e, sinks, 0); }, dispatched, emoted };
}

test("room-closed (4004) stops the clock: no ping timer keeps firing on the terminal screen", () => {
  const { pending, route, dispatched } = setup();
  expect(pending.size).toBeGreaterThan(0);
  route({ type: "room-closed" });
  expect(pending.size).toBe(0);
  expect(dispatched).toEqual([{ type: "room-closed" }]);
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
