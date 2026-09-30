// Load test (docs/perf-budgets.md: 25 people in a room without breaking the budgets): one measured site client plus
// raw-socket bots filling the room to MAX_ROOM_MEMBERS, all chatting, while bots sample relay latency on a free seat.
// The room's video is playing throughout (fake player, OME-90).
import { expect, test } from "@playwright/test";
import { DEFAULT_ROOM_ID, MAX_ROOM_MEMBERS } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { startTraffic } from "../e2e/support/bots";
import { clickSettled, joinRoom, leaveAll } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, frameTimes } from "./frames";
import { p95, recordMetric } from "./metrics";
import { summarizeFrames } from "./spread";
import { PLAYING, fakeState, shareVideo, waitPlaying } from "./sync";

const BOTS = MAX_ROOM_MEMBERS - 1;

test("load: 25 in a room with video playing — relay latency and site frame time", async ({ browser, request }) => {
  if (!available.web || !available.server) {
    const pending = available.web ? PENDING.server : PENDING.web;
    for (const id of ["load.relayLatency", "load.frameP95"]) recordMetric({ id, pending });
    return;
  }
  test.setTimeout(120_000);
  await shareVideo(request);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 1, nicknamePrefix: "load-site" });
  // Seats 0–5 held by bots, 6 is the probe seat, the site client takes 7: all 8 seats in use, 17 standing.
  // Each bot chats every 3 s (~8 chats/s room-wide) and a sit or stand goes out every 100 ms.
  const traffic = await startTraffic(browser, DEFAULT_ROOM_ID, {
    bots: BOTS,
    nicknamePrefix: "load-bot",
    fixedSeats: [0, 1, 2, 3, 4, 5],
    chatEveryMs: 3000,
    probe: { seat: 6, everyMs: 100 },
  });
  try {
    const [client] = clients;
    if (!client) throw new Error("no site client");
    await waitPlaying(clients);
    await expect(client.page.locator(site.nicknameTag)).toHaveCount(MAX_ROOM_MEMBERS);
    const siteSeat = client.page.locator(`${site.seat}[data-seat="7"]`);
    await clickSettled(client.page, siteSeat);
    await expect(siteSeat).toHaveClass(/\bmine\b/);
    await client.page.waitForTimeout(1000);
    // Only samples taken while frames are measured count, so both numbers describe the same window.
    const warmup = (await traffic.stats()).latencies.length;
    const samples = await frameTimes(client.page, 8000);
    const s = await traffic.stats();
    const latencies = s.latencies.slice(warmup);
    expect(s.members).toBe(MAX_ROOM_MEMBERS);
    await expect(client.page.locator(site.nicknameTag)).toHaveCount(MAX_ROOM_MEMBERS);
    expect(s.errors).toEqual([]);
    expect(s.dropped).toBe(0);
    expect(latencies.length).toBeGreaterThanOrEqual(40);
    expect(await fakeState(client.page)).toBe(PLAYING);

    // M3 limits are on (ADR 0018): `errors` would hold any `rate_limited` a bot got, and it is asserted empty above.
    const load = `${String(s.members)} members, ${String(s.chats)} chats + ${String(s.seatChanges)} seat changes received by bots, 0 error frames (no rate_limited) with M3 limits on`;
    const how = "slowest of 24 bots in one page, client queueing included";
    recordMetric({ id: "load.relayLatency", value: p95(latencies), note: `${String(latencies.length)} sit/stand samples (${how}); ${load}` });
    const f = summarizeFrames(samples, VSYNC_MS);
    recordMetric({ id: "load.frameP95", value: f.p95, note: `${f.note}; 8 seated + 17 standing; video playing (fake player)` });
  } finally {
    await traffic.stop();
    await leaveAll(clients);
  }
});
