// Harness self-checks for the fake Twitch and Vimeo SDKs (OME-121): served at the real URLs over the stubbed network, real Chromium, real time.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { stubExternalNetwork } from "./support/network";

interface Logged {
  type: string;
  data: unknown;
}

const events = (page: Page) => page.evaluate(() => (window as unknown as { __log: Logged[] }).__log.map(({ type, data }) => ({ type, data })));
const types = async (page: Page) => (await events(page)).map((e) => e.type);

/** Media seconds per wall second over `ms`, read from the fake's true clock. */
async function slope(page: Page, provider: "twitch" | "vimeo", ms: number): Promise<number> {
  const sample = () =>
    page.evaluate((p) => ({ t: performance.now(), m: (p === "twitch" ? window.__fakeTwitch?.currentTime : window.__fakeVimeo?.currentTime) ?? NaN }), provider);
  const a = await sample();
  await page.waitForTimeout(ms);
  const b = await sample();
  return (b.m - a.m) / ((b.t - a.t) / 1000);
}

test.beforeEach(async ({ context }) => {
  await stubExternalNetwork(context);
});

test.describe("fake Twitch SDK", () => {
  const ready = (page: Page) => expect.poll(() => types(page)).toContain("ready");

  test("v1.js is the fake; it appends a player.twitch.tv iframe built like the real SDK", async ({ page }) => {
    await page.goto("/twitch-player.html");
    await ready(page);
    const frame = page.locator("#tv > iframe");
    await expect(frame).toHaveCount(1);
    const src = new URL((await frame.getAttribute("src")) ?? "");
    expect(src.origin).toBe("https://player.twitch.tv");
    expect(src.searchParams.getAll("parent")).toEqual(["localhost"]);
    expect(src.searchParams.get("video")).toBe("v1234567890");
    expect(src.searchParams.get("referrer")).toBe(page.url());
    expect(await frame.getAttribute("allow")).toBe("autoplay; fullscreen");
    expect(await frame.getAttribute("sandbox")).toMatch(/^allow-modals allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox/);
    const child = page.frames().find((f) => new URL(f.url()).hostname === "player.twitch.tv");
    await expect(child?.locator("body") ?? page.locator("#missing")).toHaveAttribute("data-fake-twitch-embed", "");
    expect(await page.evaluate(() => window.__fakeTwitch?.options)).toMatchObject({ video: "v1234567890", parent: ["localhost"] });
  });

  test("VOD: clock runs at 1×, getCurrentTime() is the cached push, seek works", async ({ page }) => {
    await page.goto("/twitch-player.html");
    await ready(page);
    await page.evaluate(() => { window.__fakeTwitch?.configure({ pushIntervalMs: 1000 }); window.__fakeTwitch?.player?.play(); });
    const measured = await slope(page, "twitch", 2000);
    expect(Math.abs(measured - 1), `measured ${String(measured)}`).toBeLessThan(0.02);
    const { cached, truth } = await page.evaluate(() => ({ cached: window.__fakeTwitch?.player?.getCurrentTime() ?? NaN, truth: window.__fakeTwitch?.currentTime ?? NaN }));
    expect(cached).toBeLessThanOrEqual(truth);
    expect(truth - cached).toBeLessThan(1.05);
    await page.evaluate(() => window.__fakeTwitch?.player?.seek(120));
    await expect.poll(() => page.evaluate(() => window.__fakeTwitch?.currentTime ?? NaN)).toBeGreaterThanOrEqual(120);
    await page.evaluate(() => window.__fakeTwitch?.player?.pause());
    expect(await page.evaluate(() => window.__fakeTwitch?.player?.isPaused())).toBe(true);
    expect((await types(page)).slice(1)).toEqual(["play", "playing", "seek", "pause"]);
  });

  test("live: time stays 0, seek is recorded but ignored, resume jumps to the live edge", async ({ page }) => {
    await page.goto("/twitch-player.html?channel=omega_fixture");
    await ready(page);
    await page.evaluate(() => { const p = window.__fakeTwitch?.player; p?.play(); p?.seek(50); p?.pause(); p?.play(); });
    expect(await page.evaluate(() => [window.__fakeTwitch?.player?.getCurrentTime(), window.__fakeTwitch?.player?.getDuration()])).toEqual([0, 0]);
    expect(await page.evaluate(() => window.__fakeTwitch?.commands.filter((c) => c.name === "seek").length)).toBe(1);
    const after = (await types(page)).slice((await types(page)).lastIndexOf("pause") + 1);
    expect(after).toContain("seek");
    expect(after.at(-1)).toBe("playing");
  });

  test("injections: buffering and ad are silent, offline/online/error/playbackBlocked emit events", async ({ page }) => {
    await page.goto("/twitch-player.html");
    await ready(page);
    await page.evaluate(() => window.__fakeTwitch?.player?.play());
    await page.evaluate(() => window.__fakeTwitch?.buffering(200));
    expect(await page.evaluate(() => window.__fakeTwitch?.playback)).toBe("Buffering");
    await expect.poll(() => page.evaluate(() => window.__fakeTwitch?.playback)).toBe("Playing");
    await page.evaluate(() => window.__fakeTwitch?.ad(300));
    const frozen = await page.evaluate(() => window.__fakeTwitch?.currentTime ?? NaN);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => [window.__fakeTwitch?.playback, window.__fakeTwitch?.currentTime])).toEqual(["Playing", frozen]);
    await page.waitForTimeout(250);
    await page.evaluate(() => { const f = window.__fakeTwitch; f?.offline(); f?.online(); f?.playbackBlocked(); f?.error(5000); });
    expect((await types(page)).slice(1)).toEqual(["play", "playing", "offline", "online", "playbackBlocked", "error"]);
  });

  test("neverReady emulates a wrong parent: the iframe exists but READY never fires", async ({ page }) => {
    await page.goto("/twitch-player.html?neverReady");
    await expect(page.locator("#tv > iframe")).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(await types(page)).toEqual([]);
  });
});

test.describe("fake Vimeo SDK", () => {
  const ready = (page: Page) => page.evaluate(() => (window as unknown as { ready: Promise<string> }).ready);

  test("player.js is the fake; it attaches to our iframe and records the src query", async ({ page }) => {
    await page.goto("/vimeo-player.html");
    expect(await ready(page)).toBe("ready");
    const child = page.frames().find((f) => new URL(f.url()).hostname === "player.vimeo.com");
    await expect(child?.locator("body") ?? page.locator("#missing")).toHaveAttribute("data-fake-vimeo-embed", "");
    expect(await page.evaluate(() => window.__fakeVimeo?.query)).toMatchObject({ h: "8272103f6e", dnt: "1", autopause: "0" });
    expect(await types(page)).toEqual(["loaded"]);
  });

  test("rate: rejected by default, honoured with rateAllowed, echoed but ignored with rateIgnored", async ({ page }) => {
    await page.goto("/vimeo-player.html");
    await ready(page);
    const setRate = (r: number) => page.evaluate((rate) => window.__fakeVimeo?.player?.setPlaybackRate(rate).then(() => "ok", (e: Error) => e.name), r);
    expect(await setRate(1)).toBe("Error");
    await page.evaluate(() => { window.__fakeVimeo?.rateAllowed(true); return window.__fakeVimeo?.player?.play(); });
    expect(await setRate(1.25)).toBe("ok");
    const fine = await slope(page, "vimeo", 2000);
    expect(Math.abs(fine / 1.25 - 1), `measured ${String(fine)}`).toBeLessThan(0.02);
    await page.evaluate(() => window.__fakeVimeo?.rateIgnored(true));
    expect(await setRate(1.1)).toBe("ok");
    expect(await page.evaluate(() => window.__fakeVimeo?.player?.getPlaybackRate())).toBe(1.1);
    const ignored = await slope(page, "vimeo", 2000);
    expect(Math.abs(ignored - 1), `measured ${String(ignored)}`).toBeLessThan(0.02);
  });

  test("events: play, timeupdate cadence, seek, buffering, autoplay block, user clicks", async ({ page }) => {
    await page.goto("/vimeo-player.html");
    await ready(page);
    await page.evaluate(() => window.__fakeVimeo?.player?.on("timeupdate", (d: unknown) => (window as unknown as { __log: Logged[] }).__log.push({ type: "timeupdate", data: d })));
    await page.evaluate(() => window.__fakeVimeo?.player?.play());
    await page.waitForTimeout(1100);
    const ticks = (await events(page)).filter((e) => e.type === "timeupdate");
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks[0]?.data).toMatchObject({ duration: 634.5 });
    await page.evaluate(() => window.__fakeVimeo?.player?.setCurrentTime(100));
    await page.evaluate(() => window.__fakeVimeo?.buffering(150));
    await expect.poll(async () => (await types(page)).includes("bufferend")).toBe(true);
    await page.evaluate(() => window.__fakeVimeo?.autoplayBlocked());
    const blocked = await page.evaluate(() => window.__fakeVimeo?.player?.play().then(() => "ok", (e: Error) => e.name));
    expect(blocked).toBe("NotAllowedError");
    await page.evaluate(() => { window.__fakeVimeo?.userPlay(); window.__fakeVimeo?.userSeek(10); });
    // seeked settles asynchronously, as in the real player.
    await expect.poll(async () => (await types(page)).filter((t) => t === "seeked").length).toBe(2);
    await page.evaluate(() => window.__fakeVimeo?.userPause());
    const names = (await types(page)).filter((t) => t !== "timeupdate");
    expect(names).toEqual(["loaded", "play", "playing", "seeking", "seeked", "bufferstart", "bufferend", "pause", "play", "playing", "seeking", "seeked", "pause"]);
    expect(await page.evaluate(() => window.__fakeVimeo?.calls.some((c) => c.name === "setCurrentTime" && c.args[0] === 10))).toBe(false);
  });

  for (const refuse of ["privacy", "password"] as const) {
    test(`refusal: ${refuse} rejects ready() with the named error`, async ({ page }) => {
      await page.goto(`/vimeo-player.html?refuse=${refuse}`);
      expect(await ready(page)).toBe(refuse === "privacy" ? "PrivacyError" : "PasswordError");
      expect(await page.evaluate(() => window.__fakeVimeo?.player?.play().then(() => "ok", (e: Error) => e.name))).toBe(refuse === "privacy" ? "PrivacyError" : "PasswordError");
    });
  }
});

test("no request leaves the machine unstubbed", async ({ page }) => {
  const external: string[] = [];
  page.on("requestfinished", (r) => { const u = new URL(r.url()); if (u.hostname !== "localhost") external.push(u.href); });
  page.on("requestfailed", (r) => external.push(`FAILED ${r.url()}`));
  await page.goto("/twitch-player.html");
  await page.goto("/vimeo-player.html");
  await page.waitForLoadState("networkidle");
  expect(external.every((u) => !u.startsWith("FAILED"))).toBe(true);
  expect(external.map((u) => new URL(u).hostname).sort()).toEqual(expect.arrayContaining(["player.twitch.tv", "player.vimeo.com"]));
});
