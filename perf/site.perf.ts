import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { VSYNC_MS, frameTimes } from "./frames";
import { recordMetric } from "./metrics";
import { summarizeFrames } from "./spread";
import { PLAYING, fakeState, shareVideo, waitPlaying } from "./sync";

interface LongTaskStore { __omegaLongTaskEnds: number[] }

/**
 * TTI (lab approximation): the latest of DOMContentLoaded end, the end of the last long task, and the site's
 * `performance.mark("omega:interactive")` if it sets one. Measured after load + a 1 s quiet window.
 */
async function measureTti(page: Page, url: string): Promise<number> {
  await page.addInitScript(() => {
    const store = globalThis as unknown as LongTaskStore;
    store.__omegaLongTaskEnds = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) store.__omegaLongTaskEnds.push(e.startTime + e.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const mark = performance.getEntriesByName("omega:interactive")[0]?.startTime ?? 0;
    const longTasks = (globalThis as unknown as LongTaskStore).__omegaLongTaskEnds;
    return Math.max(nav?.domContentLoadedEventEnd ?? 0, mark, ...longTasks);
  });
}

test("site: time to interactive", async ({ page }) => {
  if (!available.web) {
    recordMetric({ id: "site.tti", pending: PENDING.web });
    return;
  }
  // Warm-up load so server start-up isn't counted, then a fresh measured load.
  await page.goto(URLS.web);
  const fresh = await page.context().newPage();
  recordMetric({ id: "site.tti", value: await measureTti(fresh, URLS.web) });
});

test("site: p95 frame time with 8 avatars and video playing", async ({ browser, request }) => {
  if (!available.web || !available.server) {
    recordMetric({ id: "site.frameP95", pending: available.web ? PENDING.server : PENDING.web });
    return;
  }
  test.setTimeout(120_000);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 8, nicknamePrefix: "fps" });
  try {
    const [observer] = clients;
    if (!observer) throw new Error("no clients");
    await shareVideo(request);
    await waitPlaying(clients);
    const samples = await frameTimes(observer.page, 5000);
    expect(await fakeState(observer.page)).toBe(PLAYING);
    expect(samples.length).toBeGreaterThan(0);
    const f = summarizeFrames(samples, VSYNC_MS);
    recordMetric({ id: "site.frameP95", value: f.p95, note: `${f.note}; video playing (fake player)` });
  } finally {
    await leaveAll(clients);
  }
});
