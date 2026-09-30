import { afterEach, beforeEach, expect, test } from "bun:test";
import { MAX_ROOM_MEMBERS } from "@omega/shared";
import { measureRelayLatency } from "../src/relay-latency";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

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
  // Share as a member who then leaves, so the probe can fill the room.
  const sharer = await Client.join(t.ws(), "sharer");
  const res = await postShare(t, JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), {
    token: tokenOf(sharer.snapshot),
  });
  expect(res.status).toBe(200);
  sharer.client.close();
  await sharer.client.closed;
  const result = await measureRelayLatency({ url: t.ws(), clients: MAX_ROOM_MEMBERS, samples: 50, action: "control" });
  expect(result.action).toBe("control");
  expect(result.samples).toBe(50);
  expect(result.p50).toBeGreaterThan(0);
  expect(result.p95).toBeLessThanOrEqual(BUDGET_MS);
  console.log(`control relay: ${JSON.stringify(result)}`);
  // Paced to the room control limit (8, then 4/s): 51 controls take about 11 s.
}, 20_000);

test(`[Relay under flood unmeasured] relay with 24 members and 1 flooder stays within ${String(BUDGET_MS)} ms at p95`, async () => {
  const result = await measureRelayLatency({ url: t.ws(), clients: MAX_ROOM_MEMBERS, samples: 50, flood: true });
  expect(result.flood).toBe(true);
  expect(result.samples).toBe(50);
  expect(result.p95).toBeLessThanOrEqual(BUDGET_MS);
  console.log(`relay under flood: ${JSON.stringify(result)}`);
}, 20_000);

test(`[Relay under flood] control relay with 24 members chatting at the allowed rate and 1 flooder at 10× L1 stays within ${String(BUDGET_MS)} ms at p95 (OME-192)`, async () => {
  const sharer = await Client.join(t.ws(), "sharer");
  const res = await postShare(t, JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), {
    token: tokenOf(sharer.snapshot),
  });
  expect(res.status).toBe(200);
  sharer.client.close();
  await sharer.client.closed;
  const result = await measureRelayLatency({ url: t.ws(), clients: MAX_ROOM_MEMBERS, samples: 50, action: "control", flood: true });
  expect(result.action).toBe("control");
  expect(result.p95).toBeLessThanOrEqual(BUDGET_MS);
  // Legitimate traffic: every member chatted at the server's sustained chat rate, and none was ever rate-limited.
  expect(result.members?.chats).toBeGreaterThanOrEqual(MAX_ROOM_MEMBERS - 1);
  expect(result.members?.rateLimited).toBe(0);
  // The attacker was throttled (`rate_limited`) and closed with 4029 at least once over the ~11 s run (ADR 0016/0018).
  expect(result.attacker?.sent).toBeGreaterThan(0);
  expect(result.attacker?.rateLimited).toBeGreaterThan(0);
  expect(result.attacker?.closes["4029"]).toBeGreaterThan(0);
  console.log(`control relay under flood: ${JSON.stringify(result)}`);
}, 30_000);

test("a control run right after another one doesn't trip the room control limit (OME-192)", async () => {
  const sharer = await Client.join(t.ws(), "sharer");
  const res = await postShare(t, JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), {
    token: tokenOf(sharer.snapshot),
  });
  expect(res.status).toBe(200);
  sharer.client.close();
  await sharer.client.closed;
  // The first run leaves the server's room bucket empty; the second must not assume it's full.
  await measureRelayLatency({ url: t.ws(), clients: 4, samples: 10, action: "control" });
  const result = await measureRelayLatency({ url: t.ws(), clients: 4, samples: 10, action: "control" });
  expect(result.samples).toBe(10);
}, 20_000);

test("without flood there is no attacker and no member traffic in the result", async () => {
  const result = await measureRelayLatency({ url: t.ws(), clients: 2, samples: 2 });
  expect(result.attacker).toBeUndefined();
  expect(result.members).toBeUndefined();
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
