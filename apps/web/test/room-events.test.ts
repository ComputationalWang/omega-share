import { expect, test } from "bun:test";
import { createClockSync } from "../src/clock";
import type { ConnectionEvent } from "../src/connection";
import { routeConnectionEvent } from "../src/room-events";
import type { ViewEvent } from "../src/state";

/** A real clock on fake timers: which timers are still pending after the event. */
function setup(): { pending: Set<number>; route: (e: ConnectionEvent) => void; dispatched: ViewEvent[] } {
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
  const sinks = {
    clock,
    shareToken: { onEvent: () => undefined },
    joined: () => undefined,
    dispatch: (e: ViewEvent) => dispatched.push(e),
  };
  return { pending, route: (e) => { routeConnectionEvent(e, sinks, 0); }, dispatched };
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
