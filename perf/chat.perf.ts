// OME-594 (M7 W1): the frame budgets with a chat burst at the room's chat rate limit, per provider playing (YouTube,
// Twitch VOD, Twitch live, Vimeo, a loaded generic embed). 8 clients (8 avatars), the observer's chat log on screen;
// the 7 others each send a burst of CHAT_BURST then one a second (apps/server/src/ws.ts CHAT_BURST / CHAT_PER_SECOND)
// for the whole traced window, so the log fills to its cap and drops a line per message while the bubbles move too.
// Rows: chat.frameP95.<p> (quantised p95 ≤ one vsync), chat.workP95.<p> (≤ 8 ms), chat.missedVsync.<p> (≤ 1 %).
// Each row pools ROUNDS bursts (OME-813): one 5 s window is ~300 frames, so 3 misses on a heavy burst failed ≤ 1 %.
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { FRAME_PROVIDERS, type FrameProvider } from "./budgets";
import { VSYNC_MS, tracedFrames, type FrameWindow } from "./frames";
import { p95, recordMetric } from "./metrics";
import { GENERIC_HOST, GENERIC_PAGE, PROVIDER_CASES, waitProviderPlaying } from "./providers";
import { summarizeFrames } from "./spread";
import { waitPlaying } from "./sync";

const CLIENTS = 8;
const WINDOW_MS = 5000;
/** Bursts pooled per provider: ~900 frames, so ≤ 1 % missed allows 9, and a regression repeats on every burst. */
const ROUNDS = 3;
/** ws.ts: a socket's chat bucket holds 5 and refills at 1 a second. */
const CHAT_BURST = 5;
const CHAT_EVERY_MS = 1000;
const REFILL_MS = (CHAT_BURST + 1) * CHAT_EVERY_MS;
/** The log's cap (apps/web/src/chat/log.ts CHAT_LOG_CAP). */
const LOG_CAP = 50;

const ids = (p: FrameProvider): string[] => [`chat.frameP95.${p}`, `chat.workP95.${p}`, `chat.missedVsync.${p}`];

/** Share `url` as the room's current item; the per-room share bucket's 429s are waited out. */
async function share(request: APIRequestContext, roomId: string, url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const member = await joinForToken(roomId, "chat-perf-sharer");
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

/** Each sender: a burst of CHAT_BURST, then one a second until the window ends. Returns how many went out. */
async function burst(senders: readonly Client[], tag: string): Promise<number> {
  const counts = await Promise.all(
    senders.map(async (c) => {
      const input = c.page.locator(site.chatInput);
      const say = async (i: number): Promise<void> => {
        await input.fill(`${tag} ${c.nickname} ${String(i)}`);
        await input.press("Enter");
      };
      let n = 0;
      const start = Date.now();
      while (n < CHAT_BURST) await say(n++);
      for (let at = CHAT_EVERY_MS; at < WINDOW_MS; at += CHAT_EVERY_MS) {
        const wait = start + at - Date.now();
        if (wait > 0) await c.page.waitForTimeout(wait);
        await say(n++);
      }
      return n;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

function record(p: FrameProvider, w: FrameWindow, what: string): { p95: number; missedPct: number; workP95: number } {
  const f = summarizeFrames(w.samples, VSYNC_MS);
  const workP95 = p95(w.workMs);
  recordMetric({ id: `chat.frameP95.${p}`, value: f.p95, note: `${f.note}; ${what}` });
  recordMetric({ id: `chat.workP95.${p}`, value: workP95, note: `${String(w.workMs.length)} traced frames, max ${Math.max(...w.workMs).toFixed(2)} ms; ${what}` });
  recordMetric({ id: `chat.missedVsync.${p}`, value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames${f.missed === 0 ? "" : ` (at ${f.missedAtMs.join(", ")} ms of the pooled windows)`}; ${what}` });
  return { p95: f.p95, missedPct: f.missedPct, workP95 };
}

test("chat: frames per provider with a chat burst at the rate limit (8 avatars + video, chat log on screen)", async ({ browser, request }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const p of FRAME_PROVIDERS) for (const id of ids(p)) recordMetric({ id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(720_000);
  const room = testRoom("chat-perf", "frames");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: CLIENTS,
    nicknamePrefix: "cb",
    setup: async (context) => {
      await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
    },
  });
  const rows: Record<string, unknown> = {};
  try {
    const [observer, ...senders] = clients;
    if (observer === undefined) throw new Error("no observer");
    // Tall enough that the stage and the log are on screen together, so both are painted.
    await observer.page.setViewportSize({ width: 1280, height: 1600 });
    const log = observer.page.locator(site.chatLog);
    const lines = observer.page.locator(site.chatLogLine);
    const measure = async (p: FrameProvider, label: string): Promise<void> => {
      await expect(log).toBeInViewport();
      await expect(observer.page.locator(site.room)).toBeInViewport();
      const pooled: FrameWindow = { samples: [], workMs: [] };
      let sent = 0;
      for (let round = 0; round < ROUNDS; round++) {
        // A full refill of every sender's chat bucket (5 at 1/s) since the last round, so the burst is never refused.
        await observer.page.waitForTimeout(REFILL_MS);
        const tag = `${p}#${String(round)}`;
        const [w, n] = await Promise.all([tracedFrames(browser, observer.page, WINDOW_MS), burst(senders, tag)]);
        // The burst reached the observer: its last line is this round's, and the log never grows past its cap.
        await expect(lines.last()).toContainText(`${tag} `);
        expect(await lines.count()).toBeLessThanOrEqual(LOG_CAP);
        pooled.samples.push(...w.samples);
        pooled.workMs.push(...w.workMs);
        sent += n;
      }
      rows[p] = { ...record(p, pooled, `${label} playing, ${String(CLIENTS)} avatars, ${String(ROUNDS)} bursts pooled: ${String(sent)} chats from ${String(senders.length)} senders in ${String(ROUNDS)} × ${String(WINDOW_MS)} ms (burst ${String(CHAT_BURST)}, then 1/s each)`), sent };
    };

    await waitPlaying(clients);
    await measure("youtube", "YouTube");
    await expect(lines).toHaveCount(LOG_CAP);
    for (const c of PROVIDER_CASES) {
      await share(request, room.id, c.shareUrl);
      await waitProviderPlaying(clients, c.provider);
      await measure(c.key, c.label);
    }
    await share(request, room.id, `https://${GENERIC_HOST}/embed/42`);
    // Click-to-load is per member, so only the observer loads it (OME-813). The fixture is a canvas + rAF page;
    // 8 of them animating in this one browser dropped 2–3 observer frames on every burst, and a member never runs
    // another member's embed. The senders just chat.
    await observer.page.getByTestId("generic-load").click({ timeout: 15_000 });
    await expect(observer.page.frameLocator(site.sharedVideo).locator("div")).toBeVisible({ timeout: 15_000 });
    await measure("generic", "generic embed loaded");

    for (const [k, r] of Object.entries(rows)) {
      if (typeof r !== "object" || r === null) continue;
      expect(Reflect.get(r, "p95"), k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(Reflect.get(r, "missedPct"), k).toBeLessThanOrEqual(1);
      expect(Reflect.get(r, "workP95"), k).toBeLessThanOrEqual(8);
    }
  } finally {
    await leaveAll(clients);
  }
});
