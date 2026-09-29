import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { p95, recordMetric, vsyncFrames } from "./metrics";

/** Headless Chromium drives rAF from a fixed 60 Hz begin-frame clock. */
const VSYNC_MS = 1000 / 60;

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

/** Frame deltas from requestAnimationFrame over `ms` (unthrottled in the perf project, see playwright.config.ts). */
async function frameTimes(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + duration;
        const tick = (t: number): void => {
          deltas.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else resolve(deltas.slice(1));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
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

test("site: p95 frame time with 8 avatars", async ({ browser }) => {
  if (!available.web || !available.server) {
    recordMetric({ id: "site.frameP95", pending: available.web ? PENDING.server : PENDING.web });
    return;
  }
  test.setTimeout(120_000);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 8, nicknamePrefix: "fps" });
  try {
    const [observer] = clients;
    if (!observer) throw new Error("no clients");
    const hasVideo = (await observer.page.locator(site.sharedVideo).count()) > 0;
    const samples = await frameTimes(observer.page, 5000);
    expect(samples.length).toBeGreaterThan(0);
    const frames = vsyncFrames(samples, VSYNC_MS);
    const missed = frames.filter((f) => f > VSYNC_MS * 1.5).length;
    const detail = `${String(samples.length)} frames, ${String(missed)} missed vsync, raw p95 ${p95(samples).toFixed(1)} ms`;
    recordMetric({ id: "site.frameP95", value: p95(frames), note: `${detail}${hasVideo ? "" : ", no video playing (M1b)"}` });
  } finally {
    await leaveAll(clients);
  }
});
