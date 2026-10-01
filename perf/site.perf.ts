import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { joinRoom, leaveAll } from "../e2e/support/room";
import { joinForToken, postShare } from "../e2e/support/share";
import { site } from "../e2e/support/selectors";
import { recordFrameRows, tracedFrames } from "./frames";
import { recordMetric } from "./metrics";
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
    const pending = available.web ? PENDING.server : PENDING.web;
    for (const id of ["site.frameP95", "site.frameWorkP95.youtube", "site.missedVsync.youtube"]) recordMetric({ id, pending });
    return;
  }
  test.setTimeout(120_000);
  // Share before joining, so every client is on this video, not a previous spec's.
  await shareVideo(request);
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 8, nicknamePrefix: "fps" });
  try {
    const [observer] = clients;
    if (!observer) throw new Error("no clients");
    await waitPlaying(clients);
    const w = await tracedFrames(browser, observer.page, 5000);
    expect(await fakeState(observer.page)).toBe(PLAYING);
    expect(w.samples.length).toBeGreaterThan(0);
    recordFrameRows("youtube", w, "video playing (fake player)");
  } finally {
    await leaveAll(clients);
  }
});

// OME-164: the same budget with a Vimeo embed playing on the fake SDK (OME-121), through the real Vimeo adapter.
test("site: p95 frame time with 8 avatars and a Vimeo video playing", async ({ browser, request }) => {
  if (!available.web || !available.server) {
    const pending = available.web ? PENDING.server : PENDING.web;
    for (const id of ["site.frameP95.vimeo", "site.frameWorkP95.vimeo", "site.missedVsync.vimeo"]) recordMetric({ id, pending });
    return;
  }
  test.setTimeout(120_000);
  const sharer = await joinForToken(DEFAULT_ROOM_ID, "vimeo-sharer");
  try {
    expect((await postShare(request, DEFAULT_ROOM_ID, sharer.token, "https://vimeo.com/76979871")).status()).toBe(200);
  } finally {
    sharer.close();
  }
  const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 8, nicknamePrefix: "fps-vimeo" });
  try {
    const [observer] = clients;
    if (!observer) throw new Error("no clients");
    for (const c of clients) {
      await expect(c.page.locator(site.sharedVideo)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => c.page.evaluate(() => window.__fakeVimeo?.paused ?? null), { timeout: 15_000 }).toBe(false);
    }
    const w = await tracedFrames(browser, observer.page, 5000);
    expect(await observer.page.evaluate(() => window.__fakeVimeo?.paused)).toBe(false);
    expect(w.samples.length).toBeGreaterThan(0);
    recordFrameRows("vimeo", w, "Vimeo playing (fake SDK)");
  } finally {
    await leaveAll(clients);
  }
});

// OME-294: the same budget with a generic embed (ADR 0024) loaded in every client. The host is routed to a local page
// that repaints every frame (a stand-in for a playing video); there is no playback to wait for, the tier isn't synced.
const GENERIC_HOST = "video.omega-fixture.org";
const GENERIC_PAGE = `<!doctype html><title>generic</title><style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  div { width: 40%; height: 40%; background: #4a8; animation: m 1s linear infinite alternate; }
  @keyframes m { from { transform: translateX(0) rotate(0); } to { transform: translateX(120%) rotate(180deg); } }
</style><div></div>`;

test("site: p95 frame time with 8 avatars and a generic embed loaded", async ({ browser, request }) => {
  if (!available.web || !available.server) {
    const pending = available.web ? PENDING.server : PENDING.web;
    for (const id of ["site.frameP95.generic", "site.frameWorkP95.generic", "site.missedVsync.generic"]) recordMetric({ id, pending });
    return;
  }
  test.setTimeout(120_000);
  const sharer = await joinForToken(DEFAULT_ROOM_ID, "generic-sharer");
  try {
    expect((await postShare(request, DEFAULT_ROOM_ID, sharer.token, `https://${GENERIC_HOST}/embed/42`)).status()).toBe(200);
  } finally {
    sharer.close();
  }
  const clients = await joinRoom(browser, {
    roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`,
    count: 8,
    nicknamePrefix: "fps-generic",
    setup: async (context) => {
      await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
    },
  });
  try {
    const [observer] = clients;
    if (!observer) throw new Error("no clients");
    for (const c of clients) {
      await c.page.getByTestId("generic-load").click({ timeout: 15_000 });
      await expect(c.page.frameLocator(site.sharedVideo).locator("div")).toBeVisible({ timeout: 15_000 });
    }
    const w = await tracedFrames(browser, observer.page, 5000);
    expect(w.samples.length).toBeGreaterThan(0);
    recordFrameRows("generic", w, "generic embed loaded (local page repainting every frame)");
  } finally {
    await leaveAll(clients);
  }
});
