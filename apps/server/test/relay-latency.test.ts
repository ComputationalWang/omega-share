import { afterEach, beforeEach, expect, test } from "bun:test";
import { MAX_ROOM_MEMBERS } from "@omega/shared";
import { measureRelayLatency } from "../src/relay-latency";
import { start, type TestServer } from "./helpers";

/** docs/perf-budgets.md: relay latency for a control action, localhost. */
const BUDGET_MS = 50;

let t: TestServer;
beforeEach(() => {
  t = start();
});
afterEach(async () => {
  await t.server.stop(true);
});

test(`relay latency with a full room of ${String(MAX_ROOM_MEMBERS)} stays within ${String(BUDGET_MS)} ms at p95`, async () => {
  const result = await measureRelayLatency({ url: t.ws(), clients: MAX_ROOM_MEMBERS, samples: 50 });
  expect(result.samples).toBe(50);
  expect(result.clients).toBe(MAX_ROOM_MEMBERS);
  expect(result.p50).toBeGreaterThan(0);
  expect(result.p50).toBeLessThanOrEqual(result.p95);
  expect(result.p95).toBeLessThanOrEqual(result.max);
  expect(result.p95).toBeLessThanOrEqual(BUDGET_MS);

  // The measurement leaves the room empty again.
  const rooms = (await (await fetch(`${t.http}/rooms`)).json()) as unknown;
  expect(rooms).toEqual({ rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0 }] });
});
