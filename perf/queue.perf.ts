// OME-508 (ADR 0031, M6 plan): the queue against the budgets.
// - queue.json: frames with a 20-item "Up next" on screen next to the stage (8 avatars), per provider playing: YouTube,
//   Twitch VOD, Twitch live, Vimeo. Same budgets as the frame rows (quantised p95 ≤ one vsync, ≤ 1 % missed, ≤ 8 ms work p95),
//   asserted here like moderation.perf.ts, so the official site.frame* rows stay the plain room's.
// - queue.advanceSpread: the players reach the end, the first `ended` advances the room, and every one of 8 clients plays
//   the next item. Spread = first to last client whose new player is playing, worst of ROUNDS advances (ADR 0031 §7).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { EMBED_URL, VIDEO_ID } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { VSYNC_MS, tracedFrames } from "./frames";
import { RESULTS_DIR, p95, recordMetric } from "./metrics";
import { PROVIDER_CASES, waitProviderPlaying } from "./providers";
import { summarizeFrames } from "./spread";
import { PLAYING, fakeState, waitPlaying } from "./sync";

const CLIENTS = 8;
const ROUNDS = 3;
/** The fake YouTube's content length (fixtures/fake-iframe-api.ts default): a seek to here ends it in ~4.5 s. */
const NEAR_END = "630";
const pending = (): string | null => (!available.web ? PENDING.web : !available.server ? PENDING.server : null);

/** Share `url` as the room's current item with a member's token (the share bucket's 429s are waited out). */
async function share(request: Parameters<typeof postShare>[0], roomId: string, url: string): Promise<void> {
  const member = await joinForToken(roomId, "queue-sharer");
  try {
    expect((await postShare(request, roomId, member.token, url)).status()).toBe(200);
  } finally {
    member.close();
  }
}

/** Paste each url into "Up next", spread over the clients; a refusal (the add buckets) is retried after a pause. */
async function fill(clients: readonly Client[], urls: readonly string[]): Promise<void> {
  for (const [i, url] of urls.entries()) {
    const c = clients[i % clients.length];
    if (c === undefined) throw new Error("no clients");
    await expect
      .poll(async () => {
        const rows = c.page.locator(site.queueRow);
        if ((await rows.count()) > i) return true;
        await c.page.locator(site.queueUrl).fill(url);
        await c.page.locator(site.queueAdd).click();
        await c.page.waitForTimeout(400);
        return (await rows.count()) > i;
      }, { timeout: 30_000, intervals: [3_100] })
      .toBe(true);
  }
}

const frameRow = ({ samples, workMs }: { samples: number[]; workMs: number[] }) => {
  const f = summarizeFrames(samples, VSYNC_MS);
  return { p95: f.p95, missedPct: f.missedPct, missed: f.missed, frames: f.frames, maxMs: Math.max(...samples), rawP95: p95(samples), workP95: p95(workMs), workMax: Math.max(...workMs), traced: workMs.length };
};

test("queue: frames per provider with 20 items up next (8 avatars + video)", async ({ browser, request }) => {
  test.skip(pending() !== null, pending() ?? "");
  test.setTimeout(300_000);
  const room = testRoom("queue-perf", "frames");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: "qf" });
  const out: Record<string, unknown> = {};
  try {
    await waitPlaying(clients);
    // A mix of every kind of row: video, live stream and a pasted page.
    const kinds = ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://vimeo.com/76979871", "https://www.twitch.tv/omegatestchannel", "https://video.omega-fixture.org/embed/42"];
    await fill(clients, Array.from({ length: 20 }, (_, i) => kinds[i % kinds.length] ?? EMBED_URL));
    const [observer] = clients;
    if (observer === undefined) throw new Error("no observer");
    // Tall enough that the stage and the whole panel are on screen together, so both are painted.
    await observer.page.setViewportSize({ width: 1280, height: 1600 });
    await expect(observer.page.locator(site.queueRow)).toHaveCount(20);
    await expect(observer.page.locator(site.queueCount)).toHaveText("20 / 20");
    await expect(observer.page.locator(site.queuePanel)).toBeInViewport();
    await expect(observer.page.locator(site.room)).toBeInViewport();
    await observer.page.waitForTimeout(1000);
    out["youtube"] = frameRow(await tracedFrames(browser, observer.page, 5000));
    expect(await fakeState(observer.page)).toBe(PLAYING);
    for (const c of PROVIDER_CASES) {
      // A share replaces only the current item; the 20 upcoming stay (ADR 0031 §5).
      await share(request, room.id, c.shareUrl);
      await waitProviderPlaying(clients, c.provider);
      await expect(observer.page.locator(site.queueRow)).toHaveCount(20);
      await observer.page.waitForTimeout(1000);
      out[c.key] = frameRow(await tracedFrames(browser, observer.page, 5000));
    }
    for (const [k, r] of Object.entries(out)) {
      if (typeof r !== "object" || r === null) continue;
      expect(Reflect.get(r, "p95"), k).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(Reflect.get(r, "missedPct"), k).toBeLessThanOrEqual(1);
      expect(Reflect.get(r, "workP95"), k).toBeLessThanOrEqual(8);
    }
  } finally {
    writeFileSync(join(RESULTS_DIR, "queue.json"), JSON.stringify(out, null, 2));
    await leaveAll(clients);
  }
});

/** In the page: note when a new fake YouTube player (not the one now) is playing, as epoch ms, in `window.__queueAdvancedAt`. */
async function armAdvance(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, "__queueAdvancedAt", null);
    const old = window.__fakeYt?.player ?? null;
    const id = setInterval(() => {
      const f = window.__fakeYt;
      if (f?.player == null || f.player === old || f.state !== 1) return;
      clearInterval(id);
      Reflect.set(window, "__queueAdvancedAt", performance.timeOrigin + performance.now());
    }, 5);
  });
}

const advancedAt = (page: Page): Promise<unknown> => page.evaluate(() => Reflect.get(window, "__queueAdvancedAt") as unknown);

test("queue: advance spread after the players end, 8 clients", async ({ browser, request }) => {
  const id = "queue.advanceSpread";
  const why = pending();
  if (why !== null) {
    recordMetric({ id, pending: why });
    return;
  }
  test.setTimeout(240_000);
  const room = testRoom("queue-perf", "spread");
  await share(request, room.id, EMBED_URL);
  const clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: "qs" });
  try {
    await waitPlaying(clients);
    const [a] = clients;
    if (a === undefined) throw new Error("no clients");
    await fill(clients, Array.from({ length: ROUNDS }, (_, i) => `https://www.youtube.com/watch?v=${i % 2 === 0 ? "dQw4w9WgXcQ" : VIDEO_ID}`));
    const spreads: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      await waitPlaying(clients);
      // The server ignores an end in an item's first 3 s (ADR 0031 §4).
      await a.page.waitForTimeout(3500);
      await Promise.all(clients.map((c) => armAdvance(c.page)));
      await a.page.locator(site.seek).fill(NEAR_END);
      const times = await Promise.all(
        clients.map(async (c) => {
          await expect.poll(() => advancedAt(c.page), { timeout: 20_000, message: `${c.nickname} plays the next item` }).not.toBeNull();
          const t = await advancedAt(c.page);
          if (typeof t !== "number") throw new Error("no advance time");
          return t;
        }),
      );
      spreads.push(Math.max(...times) - Math.min(...times));
      await expect(a.page.locator(site.queueRow)).toHaveCount(ROUNDS - round - 1);
    }
    const value = Math.max(...spreads);
    recordMetric({ id, value, note: `${spreads.map((s) => s.toFixed(0)).join(" / ")} ms, worst of ${String(ROUNDS)} advances on ended, ${String(CLIENTS)} clients, fake YouTube, ${URLS.server}` });
  } finally {
    await leaveAll(clients);
  }
});
