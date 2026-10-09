// OME-597 (M7 W2): the frame budgets in full screen, per provider playing (YouTube, Twitch VOD, Twitch live, Vimeo, a
// loaded generic embed). 8 clients (8 avatars); the observer (desktop) is in full screen with the chat strip open, the
// room hidden and its render loop paused, while the 7 others chat at 1/s each, so the strip's lines arrive and age.
// Entering and leaving full screen must add no long task over 50 ms (PerformanceObserver "longtask" around each).
// Rows: fs.frameP95.<p> (quantised p95 ≤ one vsync), fs.workP95.<p> (≤ 8 ms), fs.missedVsync.<p> (≤ 1 %),
// fs.toggleLongTask.<p> (longest task while entering or leaving, ≤ 50 ms; 0 when there was none).
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { FRAME_PROVIDERS, type FrameProvider } from "./budgets";
import { VSYNC_MS, tracedFrames } from "./frames";
import { p95, recordMetric } from "./metrics";
import { GENERIC_HOST, GENERIC_PAGE, PROVIDER_CASES, waitProviderPlaying } from "./providers";
import { summarizeFrames } from "./spread";
import { waitPlaying } from "./sync";

const CLIENTS = 8;
const WINDOW_MS = 5000;
const CHAT_EVERY_MS = 1000;
/** How long after a toggle its layout, paint and the strip's move may still be running. */
const TOGGLE_SETTLE_MS = 1000;
const LONG_TASK_MS = 50;

const ids = (p: FrameProvider): string[] => [`fs.frameP95.${p}`, `fs.workP95.${p}`, `fs.missedVsync.${p}`, `fs.toggleLongTask.${p}`];

async function share(request: APIRequestContext, roomId: string, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const member = await joinForToken(roomId, "fs-perf-sharer");
        try {
          return (await postShare(request, roomId, member.token, url)).status();
        } finally {
          member.close();
        }
      },
      { timeout: 60_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(200);
}

async function chatter(senders: readonly Client[], tag: string): Promise<number> {
  const counts = await Promise.all(
    senders.map(async (c) => {
      const input = c.page.locator(site.chatInput);
      const start = Date.now();
      let n = 0;
      for (let at = 0; at < WINDOW_MS; at += CHAT_EVERY_MS) {
        const wait = start + at - Date.now();
        if (wait > 0) await c.page.waitForTimeout(wait);
        await input.fill(`${tag} ${c.nickname} ${String(n++)}`);
        await input.press("Enter");
      }
      return n;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

const inFullscreen = (page: Page): Promise<boolean> => page.evaluate(() => document.fullscreenElement !== null);

/** Press our full-screen key and return the longest task (ms) in the second after it; 0 if none passed 50 ms. */
async function toggle(page: Page, on: boolean): Promise<number> {
  await page.evaluate(() => {
    const seen: number[] = [];
    Reflect.set(window, "__fsLongTasks", seen);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) seen.push(e.duration);
    }).observe({ type: "longtask" });
  });
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => inFullscreen(page)).toBe(on);
  await page.waitForTimeout(TOGGLE_SETTLE_MS);
  return page.evaluate(() => {
    const seen: unknown = Reflect.get(window, "__fsLongTasks");
    return Array.isArray(seen) ? Math.max(0, ...seen.map(Number)) : 0;
  });
}

test("full screen: frames per provider with the chat strip open, and no long task entering or leaving (8 avatars + video, chat at 1/s)", async ({ browser, request }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const p of FRAME_PROVIDERS) for (const id of ids(p)) recordMetric({ id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(420_000);
  const room = testRoom("fullscreen-perf", "frames");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: CLIENTS,
    nicknamePrefix: "fp",
    setup: async (context) => {
      await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
    },
  });
  const rows: Record<string, { p95: number; missedPct: number; workP95: number; longTask: number }> = {};
  try {
    const [observer, ...senders] = clients;
    if (observer === undefined) throw new Error("no observer");
    const page = observer.page;
    const measure = async (p: FrameProvider, label: string): Promise<void> => {
      const entering = await toggle(page, true);
      await expect(page.locator(site.fsStrip)).toBeVisible();
      await expect(page.locator(site.roomWindow)).toBeHidden();
      const [w, sent] = await Promise.all([tracedFrames(browser, page, WINDOW_MS), chatter(senders, p)]);
      await expect(page.locator(site.fsStrip).locator(site.chatLogLine).last()).toContainText(`${p} `);
      const leaving = await toggle(page, false);
      const f = summarizeFrames(w.samples, VSYNC_MS);
      const workP95 = p95(w.workMs);
      const longTask = Math.max(entering, leaving);
      const what = `${label} playing, full screen with the strip open, ${String(CLIENTS)} avatars, ${String(sent)} chats in ${String(WINDOW_MS)} ms`;
      recordMetric({ id: `fs.frameP95.${p}`, value: f.p95, note: `${f.note}; ${what}` });
      recordMetric({ id: `fs.workP95.${p}`, value: workP95, note: `${String(w.workMs.length)} traced frames, max ${Math.max(...w.workMs).toFixed(2)} ms; ${what}` });
      recordMetric({ id: `fs.missedVsync.${p}`, value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames; ${what}` });
      recordMetric({ id: `fs.toggleLongTask.${p}`, value: longTask, note: `enter ${entering.toFixed(0)} ms, leave ${leaving.toFixed(0)} ms (0: no task over ${String(LONG_TASK_MS)} ms); ${label}` });
      rows[p] = { p95: f.p95, missedPct: f.missedPct, workP95, longTask };
    };

    await waitPlaying(clients);
    await measure("youtube", "YouTube");
    for (const c of PROVIDER_CASES) {
      await share(request, room.id, c.shareUrl);
      await waitProviderPlaying(clients, c.provider);
      await measure(c.key, c.label);
    }
    await share(request, room.id, `https://${GENERIC_HOST}/embed/42`);
    for (const c of clients) {
      await c.page.getByTestId("generic-load").click({ timeout: 15_000 });
      await expect(c.page.frameLocator(site.sharedVideo).locator("div")).toBeVisible({ timeout: 15_000 });
    }
    await measure("generic", "generic embed loaded");

    for (const [k, r] of Object.entries(rows)) {
      expect(r.p95, k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(r.missedPct, k).toBeLessThanOrEqual(1);
      expect(r.workP95, k).toBeLessThanOrEqual(8);
      expect(r.longTask, k).toBeLessThanOrEqual(LONG_TASK_MS);
    }
  } finally {
    await leaveAll(clients);
  }
});
