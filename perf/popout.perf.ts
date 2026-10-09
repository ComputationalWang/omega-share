// OME-598 (M7 W3): the frame budgets of the room tab with the chat popped out, per provider playing (YouTube, Twitch VOD,
// Twitch live, Vimeo, a loaded generic embed). 8 clients (8 avatars); the observer (desktop) has its chat in the pop-out
// window (chat.html: a DOM list, no second Pixi renderer, no socket) while the 7 others chat at 1/s each, so every line
// is relayed from the room tab over the BroadcastChannel. Only the room tab is traced: it keeps the stage, the video
// and the one socket. Rows: pop.frameP95.<p> (quantised p95 ≤ one vsync), pop.workP95.<p> (≤ 8 ms),
// pop.missedVsync.<p> (≤ 1 %).
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

const ids = (p: FrameProvider): string[] => [`pop.frameP95.${p}`, `pop.workP95.${p}`, `pop.missedVsync.${p}`];

async function share(request: APIRequestContext, roomId: string, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const member = await joinForToken(roomId, "pop-perf-sharer");
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

test("pop-out chat: the room tab's frames per provider with the chat in its own window (8 avatars + video, chat at 1/s)", async ({ browser, request }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const p of FRAME_PROVIDERS) for (const id of ids(p)) recordMetric({ id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(420_000);
  const room = testRoom("popout-perf", "frames");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: CLIENTS,
    nicknamePrefix: "pp",
    setup: async (context) => {
      await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
    },
  });
  const rows: Record<string, { p95: number; missedPct: number; workP95: number }> = {};
  try {
    const [observer, ...senders] = clients;
    if (observer === undefined) throw new Error("no observer");
    const page = observer.page;
    const [pop] = await Promise.all([observer.context.waitForEvent("page"), page.locator(site.chatPopout).click()]);
    await pop.waitForLoadState();
    await expect(pop.locator(site.chatInput)).toBeVisible();
    await expect(page.locator(site.chatAway)).toBeVisible();
    // The room is what the tab draws now: keep the stage in view.
    await expect(page.locator(site.room)).toBeInViewport();
    // No second renderer: the window has no canvas at all.
    expect(await pop.locator("canvas").count()).toBe(0);
    const popLines = (p: Page) => p.locator(site.chatLogLine);
    const measure = async (p: FrameProvider, label: string): Promise<void> => {
      const [w, sent] = await Promise.all([tracedFrames(browser, page, WINDOW_MS), chatter(senders, p)]);
      await expect(popLines(pop).last()).toContainText(`${p} `);
      const f = summarizeFrames(w.samples, VSYNC_MS);
      const workP95 = p95(w.workMs);
      const what = `${label} playing, chat popped out, ${String(CLIENTS)} avatars, ${String(sent)} chats relayed in ${String(WINDOW_MS)} ms`;
      recordMetric({ id: `pop.frameP95.${p}`, value: f.p95, note: `${f.note}; ${what}` });
      recordMetric({ id: `pop.workP95.${p}`, value: workP95, note: `${String(w.workMs.length)} traced frames, max ${Math.max(...w.workMs).toFixed(2)} ms; ${what}` });
      recordMetric({ id: `pop.missedVsync.${p}`, value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames; ${what}` });
      rows[p] = { p95: f.p95, missedPct: f.missedPct, workP95 };
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
    }
  } finally {
    await leaveAll(clients);
  }
});
