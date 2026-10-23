// Movie night Q4 (OME-1646): one-click share from a real watch page → the room starts where the sharer was → a second
// profile's popup lists that room first as "N watching · Join". YouTube, a Twitch VOD and Vimeo, real network, headed on
// Xvfb through `bun run e2e:real -- share-now`. Never in CI. Fake-page versions: e2e/extension-watching.e2e.ts (OME-1637),
// apps/extension/test/scan.test.ts (OME-1636). Evidence: e2e/real/results/share-now-<provider>.json (+ .png).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { chromium } from "@playwright/test";
import type { BrowserContext, Frame, Page } from "@playwright/test";
import { EXTENSION_DIR, URLS, extensionBuildError } from "../support/apps";
import { expect, test, watchCsp } from "../support/csp";
import { popup } from "../support/selectors";
import { REAL, providerFrame, sampleMedia, twitchVodUrl, vimeoUrl } from "./providers";
import { BASELINE_ID, enter, record, requireVirtualDisplay, shot, ytFrame } from "./real";

test.beforeAll(requireVirtualDisplay);
test.setTimeout(300_000);

declare const chrome: {
  tabs: { query(q: Record<string, never>): Promise<{ id?: number; url?: string }[]> };
  storage: { local: { set(items: Record<string, string>): Promise<void> } };
};

/** Where the sharer seeks the watch page's own <video> before opening the popup. */
const AT = 120;
/** docs/perf-budgets.md, Extension rows. */
const POPUP_MS = 300;

const CASES = [
  { key: "youtube", url: `https://www.youtube.com/watch?v=${BASELINE_ID}`, frame: (p: Page) => ytFrame(p, BASELINE_ID, 30_000) },
  { key: "twitch-vod", url: twitchVodUrl(REAL.twitchVod), frame: (p: Page) => providerFrame(p, "twitch", `v${REAL.twitchVod}`) },
  { key: "vimeo", url: vimeoUrl(REAL.vimeo), frame: (p: Page) => providerFrame(p, "vimeo", REAL.vimeo) },
] as const;

/**
 * The e2e build with twitch.tv and vimeo.com added to its host permissions: a viewer's click on the toolbar icon grants
 * `activeTab` on any page, which Playwright can't do (ADR 0005), and the e2e build only lists youtube.com.
 */
function extensionDir(): string {
  const missing = extensionBuildError();
  if (missing !== null) throw new Error(missing);
  const dir = join(mkdtempSync(join(tmpdir(), "omega-share-now-")), "ext");
  cpSync(EXTENSION_DIR, dir, { recursive: true });
  const path = join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8")) as { host_permissions?: string[] };
  m.host_permissions = [...(m.host_permissions ?? []), "https://www.twitch.tv/*", "https://vimeo.com/*"];
  writeFileSync(path, JSON.stringify(m));
  return dir;
}

interface Profile {
  readonly context: BrowserContext;
  readonly openPopup: (target: Page) => Promise<{ page: Page; listedMs: number }>;
}

/** A fresh Chromium profile with the extension, pointed at this run's server (like e2e/support/extension.ts, headed, real network). */
async function profile(dir: string): Promise<Profile> {
  const context = await watchCsp(await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--autoplay-policy=document-user-activation-required"],
  }));
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await sw.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), URLS.server);
  const extensionId = new URL(sw.url()).host;
  return {
    context,
    async openPopup(target) {
      const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, target.url());
      if (tabId === undefined) throw new Error(`no tab for ${target.url()}`);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=${String(tabId)}`);
      await page.locator(popup.embedItem).first().waitFor({ timeout: 10_000 });
      // performance.now() is relative to the popup's navigation start (perf/extension.perf.ts).
      return { page, listedMs: Math.round(await page.evaluate(() => performance.now())) };
    },
  };
}

/** The watch page's first <video>: time, paused, and whether an ad is showing (YouTube / Twitch markers). */
const pageVideo = (page: Page): Promise<{ t: number; paused: boolean; ad: boolean } | null> =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const ad = document.querySelector(".ad-showing, [data-a-target='video-ad-label'], [data-a-target='video-ad-countdown']") !== null;
    return v === null ? null : { t: v.currentTime, paused: v.paused, ad };
  }).catch(() => null);

/** Opens the watch page as a logged-out viewer would: past a consent wall, playing content (not an ad), then seeks to AT. */
async function watchAt(page: Page, url: string): Promise<number> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // EU consent walls (YouTube's own page, Vimeo's banner): decline, as a viewer would.
  // Checked on every poll: both walls render late, and Vimeo's banner covers the play button until declined.
  const decline = page.getByRole("button", { name: /^(reject all|alles afwijzen|reject|decline)/i }).first();
  await expect.poll(async () => {
    if (await decline.isVisible().catch(() => false)) await decline.click({ timeout: 2_000 }).catch(() => undefined);
    const v = await pageVideo(page);
    if (v?.paused === true) await page.locator("video").first().click({ timeout: 2_000 }).catch(() => undefined);
    return v !== null && !v.paused && !v.ad && v.t > 1;
  }, { timeout: 120_000, intervals: [1_000], message: `content playing on ${url}` }).toBe(true);
  await page.locator("video").first().evaluate((v, at) => {
    if (v instanceof HTMLVideoElement) v.currentTime = at;
  }, AT);
  await expect.poll(async () => (await pageVideo(page))?.t ?? 0, { timeout: 15_000, message: "page seeked" }).toBeGreaterThanOrEqual(AT);
  return (await pageVideo(page))?.t ?? Number.NaN;
}

/** The room's player time once it plays content (not an ad), sampled in its frame. */
/** The room player's first playing sample, then how long until it reaches `from` (the room's sync seeks after load). */
async function roomStart(frame: Frame, from: number): Promise<{ first: number; at: number; reachedMs: number | null }> {
  let first = Number.NaN;
  let at = Number.NaN;
  let firstAtMs = 0;
  await expect.poll(async () => {
    const s = await sampleMedia(frame);
    if (s === null || s.paused || s.ad || s.currentTime <= 0.5) return false;
    at = s.currentTime;
    if (Number.isNaN(first)) [first, firstAtMs] = [at, Date.now()];
    return true;
  }, { timeout: 120_000, intervals: [500], message: "room player playing" }).toBe(true);
  const reached = await expect.poll(async () => {
    at = (await sampleMedia(frame))?.currentTime ?? at;
    return at >= from;
  }, { timeout: 30_000, intervals: [250] }).toBe(true).then(() => true, () => false);
  return { first, at, reachedMs: reached ? Date.now() - firstAtMs : null };
}

let dir = "";
test.beforeAll(() => {
  dir = extensionDir();
});

for (const c of CASES) {
  test(`${c.key} · one-click share at ${String(AT)} s → the room starts there → "N watching · Join" in a second profile`, async () => {
    const a = await profile(dir);
    const b = await profile(dir);
    try {
      // A is in the lobby (its tab holds the share token), then watches the video on the provider's own site.
      const room = await enter(a.context, `share-now-${c.key}`);
      const watch = await a.context.newPage();
      const pageAt = await watchAt(watch, c.url);

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
      const pb = await b.openPopup(bWatch);
      const first = pb.page.locator(`${popup.roomSelect} option`).first();
      await expect(first).toHaveText(/ · [1-9]\d* watching · Join$/, { timeout: 10_000 });
      await expect(first).toHaveAttribute("value", DEFAULT_ROOM_ID);
      const label = await first.textContent();
      await shot(pb.page, `share-now-${c.key}-popup-b`);

      record(`share-now-${c.key}`, { url: c.url, pageAt, startSeconds, shareFocused, roomAt, firstOptionB: label, popupListedMs: { a: pa.listedMs, b: pb.listedMs } });
      expect.soft(pa.listedMs, "popup opened → embeds listed (A)").toBeLessThanOrEqual(POPUP_MS);
      expect.soft(pb.listedMs, "popup opened → embeds listed (B)").toBeLessThanOrEqual(POPUP_MS);
    } finally {
      await Promise.all([a.context.close(), b.context.close()]);
    }
  });
}
