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
  const rooms = (await (await fetch(`${t.http}/rooms`)).json());
  expect(rooms).toEqual({ rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0 }] });
});

test(`control → playback relay with a full room stays within ${String(BUDGET_MS)} ms at p95`, async () => {
  const res = await fetch(`${t.http}/rooms/lobby/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
  });
  expect(res.status).toBe(200);
  const result = await measureRelayLatency({ url: t.ws(), clients: MAX_ROOM_MEMBERS, samples: 50, action: "control" });
  expect(result.action).toBe("control");
  expect(result.samples).toBe(50);
  expect(result.p50).toBeGreaterThan(0);
  expect(result.p95).toBeLessThanOrEqual(BUDGET_MS);
  console.log(`control relay: ${JSON.stringify(result)}`);
});

test("control mode needs an embed in the room", async () => {
  let error: unknown = null;
  try {
    await measureRelayLatency({ url: t.ws(), clients: 2, samples: 2, action: "control" });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/needs an embed/);
});
