// Movie night Q4 (OME-1646): one-click share from a real watch page → the room starts where the sharer was → a second
// profile's popup lists that room first as "N watching · Join". YouTube, a Twitch VOD and Vimeo, real network, headed on
// Xvfb through `bun run e2e:real -- share-now`. Never in CI. Fake-page versions: e2e/extension-watching.e2e.ts (OME-1637),
// apps/extension/test/scan.test.ts (OME-1636). Evidence: e2e/real/results/share-now-<provider>.json (+ .png).
import { DEFAULT_ROOM_ID } from "@omega/shared";
import type { Frame, Page } from "@playwright/test";
import { URLS } from "../support/apps";
import { expect, test } from "../support/csp";
import { popup } from "../support/selectors";
import { REAL, providerFrame, sampleMedia, twitchVodUrl, vimeoUrl } from "./providers";
import { BASELINE_ID, enter, extensionDir, profile, record, requireVirtualDisplay, shot, watchAt, ytFrame } from "./real";

test.beforeAll(requireVirtualDisplay);
test.setTimeout(300_000);

/** Where the sharer seeks the watch page's own <video> before opening the popup. */
const AT = 120;
/** docs/perf-budgets.md, Extension rows. */
const POPUP_MS = 300;

const CASES = [
  { key: "youtube", url: `https://www.youtube.com/watch?v=${BASELINE_ID}`, frame: (p: Page) => ytFrame(p, BASELINE_ID, 30_000) },
  { key: "twitch-vod", url: twitchVodUrl(REAL.twitchVod), frame: (p: Page) => providerFrame(p, "twitch", `v${REAL.twitchVod}`) },
  { key: "vimeo", url: vimeoUrl(REAL.vimeo), frame: (p: Page) => providerFrame(p, "vimeo", REAL.vimeo) },
] as const;

/** The room's player time once it plays content (not an ad), sampled in its frame. */
/** The room player's first playing sample, then how long until it reaches `from` (the room's sync seeks after load). */
async function roomStart(frame: Frame, from: number): Promise<{ first: number; at: number; reachedMs: number | null; nudged: boolean }> {
  let first = Number.NaN;
  let at = Number.NaN;
  let firstAtMs = 0;
  const since = Date.now();
  let nudged = false;
  await expect.poll(async () => {
    const s = await sampleMedia(frame);
    // OME-2057: about 1 in 10 the Vimeo room player stays paused (cause unconfirmed: third-party autoplay / rate limits).
    // After 20 s, click play once in the provider frame, as watchAt does on the watch page; then keep polling.
    if (s?.paused === true && !nudged && Date.now() - since > 20_000) {
      nudged = true;
      await frame.locator("video").first().click({ force: true, timeout: 2_000 }).catch(() => undefined);
    }
    if (s === null || s.paused || s.ad || s.currentTime <= 0.5) return false;
    at = s.currentTime;
    if (Number.isNaN(first)) [first, firstAtMs] = [at, Date.now()];
    return true;
  }, { timeout: 120_000, intervals: [500], message: "room player playing" }).toBe(true);
  const reached = await expect.poll(async () => {
    at = (await sampleMedia(frame))?.currentTime ?? at;
    return at >= from;
  }, { timeout: 30_000, intervals: [250] }).toBe(true).then(() => true, () => false);
  return { first, at, reachedMs: reached ? Date.now() - firstAtMs : null, nudged };
}

let dir = "";
test.beforeAll(() => {
  // The e2e build only lists youtube.com: a viewer's toolbar click grants `activeTab` anywhere, which Playwright can't (ADR 0005).
  dir = extensionDir(["https://www.twitch.tv/*", "https://vimeo.com/*"]);
});

for (const c of CASES) {
  test(`${c.key} · one-click share at ${String(AT)} s → the room starts there → "N watching · Join" in a second profile`, async () => {
    const a = await profile(dir, URLS.server);
    const b = await profile(dir, URLS.server);
    try {
      // A is in the lobby (its tab holds the share token), then watches the video on the provider's own site.
      const room = await enter(a.context, `share-now-${c.key}`);
      const watch = await a.context.newPage();
      const pageAt = await watchAt(watch, c.url, AT);

      const pa = await a.openPopup(watch);
      const item = pa.page.locator(popup.embedItem).first();
      await expect(pa.page.locator(popup.embedItem)).toHaveCount(1);
      const startSeconds = Number(await item.locator("input").getAttribute("data-start-seconds"));
      expect(startSeconds, "listed start").toBeGreaterThanOrEqual(AT);
      expect(startSeconds).toBeLessThanOrEqual(AT + 30);
      const share = pa.page.locator(popup.shareButton);
      await expect(share).toBeEnabled();
      await expect(pa.page.locator(popup.roomSelect)).toHaveValue(DEFAULT_ROOM_ID);
      const shareFocused = await share.evaluate((el) => el === document.activeElement);
      await share.click();
      await expect(pa.page.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
      await expect(pa.page.locator(popup.shareStatus)).toHaveText("Shared · Open room");
      await shot(pa.page, `share-now-${c.key}-popup-a`);
      // "Open room" lands A in the room tab: visible, so A counts as watching.
      await pa.page.getByRole("button", { name: "Open room" }).click();
      await room.page.bringToFront();

      const frame = await c.frame(room.page);
      const roomAt = await roomStart(frame, startSeconds - 3);
      await shot(room.page, `share-now-${c.key}-room`);
      expect.soft(roomAt.at, "room reaches the shared time within 30 s of playing").toBeGreaterThanOrEqual(startSeconds - 3);
      expect.soft(roomAt.at).toBeLessThanOrEqual(startSeconds + 90);

      // B, another profile with no room tab, opens the same video: the lobby lists first, "N watching · Join".
      const bWatch = await b.context.newPage();
      await bWatch.goto(c.url, { waitUntil: "domcontentloaded" });
      // Like A, open the popup once the page has its player: popup timing, not the provider's page load.
      await bWatch.locator("video").first().waitFor({ state: "attached", timeout: 60_000 });
      const pb = await b.openPopup(bWatch);
      const first = pb.page.locator(`${popup.roomSelect} option`).first();
      await expect(first).toHaveText(/ · [1-9]\d* watching · Join$/, { timeout: 10_000 });
      await expect(first).toHaveAttribute("value", DEFAULT_ROOM_ID);
      const label = await first.textContent();
      await shot(pb.page, `share-now-${c.key}-popup-b`);

      record(`share-now-${c.key}`, { url: c.url, pageAt, startSeconds, shareFocused, roomAt, firstOptionB: label, popupListedMs: { a: pa.listedMs, b: pb.listedMs } });
      expect.soft(pa.listedMs, "popup opened → embeds listed (A)").toBeLessThanOrEqual(POPUP_MS);
      // B is recorded, not asserted: its page is still loading the provider's JS, which the scan waits on (941 ms on YouTube).
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });
}
