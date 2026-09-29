// Load test (docs/perf-budgets.md: 25 people in a room without breaking the budgets): one measured site client plus
// raw-socket bots filling the room to MAX_ROOM_MEMBERS, all chatting, while bots sample relay latency on a free seat.
import { expect, test } from "@playwright/test";
import { DEFAULT_ROOM_ID, MAX_ROOM_MEMBERS } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { startTraffic } from "../e2e/support/bots";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, frameTimes } from "./frames";
import { p95, recordMetric, vsyncFrames } from "./metrics";

const BOTS = MAX_ROOM_MEMBERS - 1;

test("load: 25 in a room — relay latency and site frame time", async ({ browser }) => {
  if (!available.web || !available.server) {
    const pending = available.web ? PENDING.server : PENDING.web;
    for (const id of ["load.relayLatency", "load.frameP95"]) recordMetric({ id, pending });
    return;
  }
  test.setTimeout(120_000);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 1, nicknamePrefix: "load-site" });
  // Seats 0–5 held by bots, 6 is the probe seat; the site client stands. Each bot chats every 3 s (~8 chats/s room-wide).
  const traffic = await startTraffic(browser, DEFAULT_ROOM_ID, {
    bots: BOTS,
    nicknamePrefix: "load-bot",
    fixedSeats: [0, 1, 2, 3, 4, 5],
    chatEveryMs: 3000,
    probe: { seat: 6, everyMs: 150 },
  });
  try {
    const [client] = clients;
    if (!client) throw new Error("no site client");
    await expect(client.page.locator(site.nicknameTag)).toHaveCount(MAX_ROOM_MEMBERS);
    await client.page.waitForTimeout(1000);
    const samples = await frameTimes(client.page, 5000);
    await client.page.waitForTimeout(1000);
    const s = await traffic.stats();
    expect(s.members).toBe(MAX_ROOM_MEMBERS);
    expect(s.errors).toEqual([]);
    expect(s.latencies.length).toBeGreaterThanOrEqual(30);

    const load = `${String(s.members)} members, ${String(s.chats)} chats + ${String(s.seatChanges)} seat changes received by bots`;
    const dropped = s.dropped > 0 ? `, ${String(s.dropped)} samples dropped (> 2 s)` : "";
    recordMetric({ id: "load.relayLatency", value: p95(s.latencies), note: `${String(s.latencies.length)} sit/stand samples${dropped}; ${load}` });
    const frames = vsyncFrames(samples, VSYNC_MS);
    const missed = frames.filter((f) => f > VSYNC_MS * 1.5).length;
    recordMetric({
      id: "load.frameP95",
      value: p95(frames),
      note: `${String(samples.length)} frames, ${String(missed)} missed vsync, raw p95 ${p95(samples).toFixed(1)} ms; no video playing (M1b)`,
    });
  } finally {
    await traffic.stop();
    await leaveAll(clients);
  }
});
