// Harness self-checks for the fake YouTube IFrame API (OME-85): served over the stubbed network, real Chromium, real time.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { VIDEO_ID, stubExternalNetwork } from "./support/network";

interface Logged {
  type: string;
  data: number | null;
}

test.beforeEach(async ({ context, page }) => {
  await stubExternalNetwork(context);
  await page.goto("/yt-player.html");
  await expect.poll(() => page.evaluate(() => window.__fakeYt?.events.some((e) => e.type === "ready") ?? false)).toBe(true);
});

const events = (page: Page) => page.evaluate(() => (window as unknown as { __log: Logged[] }).__log.map(({ type, data }) => ({ type, data })));

test("iframe_api is the fake, and both embed hosts serve the blank fixture page", async ({ page }) => {
  expect(await page.evaluate(() => window.YT?.loaded)).toBe(1);
  expect(await page.evaluate(() => window.__fakeYt?.player?.getVideoData().video_id)).toBe(VIDEO_ID);
  for (const host of ["www.youtube.com", "www.youtube-nocookie.com"]) {
    const frame = page.frames().find((f) => new URL(f.url()).hostname === host);
    expect(frame, host).toBeDefined();
    await expect(frame?.locator("body") ?? page.locator("#missing")).toHaveAttribute("data-fake-yt-embed", "");
  }
  expect(await events(page)).toEqual([{ type: "ready", data: null }]);
});

test("media clock advances at the set rate within ±1% (performance.now, no page.clock)", async ({ page }) => {
  for (const rate of [1, 1.25]) {
    const sample = () => page.evaluate(() => ({ t: performance.now(), m: window.__fakeYt?.currentTime ?? NaN }));
    await page.evaluate((r) => { window.__fakeYt?.player?.setPlaybackRate(r); window.__fakeYt?.player?.playVideo(); }, rate);
    const a = await sample();
    await page.waitForTimeout(2000);
    const b = await sample();
    const measured = (b.m - a.m) / ((b.t - a.t) / 1000);
    expect(Math.abs(measured / rate - 1), `rate ${String(rate)} measured ${String(measured)}`).toBeLessThan(0.01);
    expect(await page.evaluate(() => window.__fakeYt?.rate)).toBe(rate);
  }
});

test("buffering, ad and error injections emit the documented events", async ({ page }) => {
  await page.evaluate(() => window.__fakeYt?.player?.playVideo());
  await page.evaluate(() => window.__fakeYt?.buffering(200));
  expect(await page.evaluate(() => window.__fakeYt?.state)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.__fakeYt?.state)).toBe(1);
  await page.evaluate(() => window.__fakeYt?.ad(200));
  expect(await page.evaluate(() => window.__fakeYt?.player?.getVideoData().video_id)).not.toBe(VIDEO_ID);
  await expect.poll(() => page.evaluate(() => window.__fakeYt?.player?.getVideoData().video_id)).toBe(VIDEO_ID);
  await page.evaluate(() => window.__fakeYt?.error(150));
  await page.evaluate(() => window.__fakeYt?.autoplayBlocked());
  await page.evaluate(() => window.__fakeYt?.clickToggle());
  expect((await events(page)).slice(1)).toEqual([
    { type: "state", data: 1 },
    { type: "state", data: 3 }, { type: "state", data: 1 },
    { type: "state", data: 3 }, { type: "state", data: 1 }, { type: "state", data: 3 }, { type: "state", data: 1 },
    { type: "error", data: 150 },
    { type: "state", data: 2 }, { type: "autoplayBlocked", data: null },
    { type: "state", data: 1 },
  ]);
});
