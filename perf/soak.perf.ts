// Soak (docs/perf-budgets.md: JS heap after 10 min in room ≤ 150 MB). One site client sits in the lobby for 10 min
// chatting and changing seats while bots chat, sit/stand and churn; heap is read over CDP after a forced GC.
// Only under `bun run perf --soak` (see soak.ts); otherwise the budget reports PENDING.
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { startTraffic } from "../e2e/support/bots";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { recordMetric } from "./metrics";
import { soakPlan } from "./soak";

const MB = 1024 * 1024;
const SITE_SEAT = 7;

async function heapAfterGcMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    return usedSize / MB;
  } finally {
    await cdp.detach();
  }
}

test("site: JS heap after a 10 min soak in the lobby", async ({ browser }) => {
  const plan = soakPlan(process.env);
  if (!plan.run) {
    recordMetric({ id: "site.heapAfterSoak", pending: plan.reason });
    return;
  }
  if (!available.web || !available.server) {
    recordMetric({ id: "site.heapAfterSoak", pending: available.web ? PENDING.server : PENDING.web });
    return;
  }
  test.setTimeout(plan.durationMs + 120_000);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 1, nicknamePrefix: "soak-site" });
  // 6 bots: two hold seats 0–1, the rest chat every 4 s, sit/stand on seat 6 every second, and one churns every 15 s.
  const traffic = await startTraffic(browser, DEFAULT_ROOM_ID, {
    bots: 6,
    nicknamePrefix: "soak-bot",
    fixedSeats: [0, 1],
    chatEveryMs: 4000,
    probe: { seat: 6, everyMs: 1000 },
    churnEveryMs: 15_000,
  });
  try {
    const [client] = clients;
    if (!client) throw new Error("no site client");
    const { page } = client;
    const startMb = await heapAfterGcMb(page);
    const seat = page.locator(`${site.seat}[data-seat="${String(SITE_SEAT)}"]`);
    const end = Date.now() + plan.durationMs;
    let lines = 0;
    let seatClicks = 0;
    while (Date.now() < end) {
      await page.locator(site.chatInput).fill(`soak line ${String(++lines)}`);
      await page.locator(site.chatInput).press("Enter");
      await seat.click();
      seatClicks++;
      await page.waitForTimeout(Math.min(5000, Math.max(0, end - Date.now())));
    }
    const endMb = await heapAfterGcMb(page);
    const s = await traffic.stats();
    expect(s.errors).toEqual([]);
    expect(s.joins).toBeGreaterThan(6);

    const minutes = (plan.durationMs / 60_000).toFixed(1);
    const detail = `${minutes} min: start ${startMb.toFixed(1)} MB → end ${endMb.toFixed(1)} MB; site sent ${String(lines)} chats + ${String(seatClicks)} seat clicks; bots saw ${String(s.chats)} chats, ${String(s.seatChanges)} seat changes, ${String(s.joins)} joins`;
    if (plan.full) recordMetric({ id: "site.heapAfterSoak", value: endMb, note: detail });
    else recordMetric({ id: "site.heapAfterSoak", pending: `short soak doesn't count: ${detail}` });
  } finally {
    await traffic.stop();
    await leaveAll(clients);
  }
});
