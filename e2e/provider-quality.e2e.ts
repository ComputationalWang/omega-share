// OME-599 (M7 W5, set k `ui-m7-quality`, research R-M7b): video quality, only you. A key at the end of the shelf, before
// full screen, only where the player can be set (Twitch here; YouTube and the generic tier have no key at all). A pick
// changes only this viewer's player, is kept on this device per provider, and never reaches the room: the fake Twitch
// player pauses, seeks and resumes by itself on a switch (the worst case R-M7b fears), and the room's playback stays put.
// Runs in the `e2e-sync` project; each case has a seeded room of its own.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { GENERIC_HOST, providerCase, shareProvider, waitProviderPlaying } from "../perf/providers";
import { roomPlayback, shareVideo, waitPlaying } from "../perf/sync";

const key = '[data-testid="quality-key"]';
const menu = '[data-testid="quality-menu"]';
const option = '[data-testid="quality-option"]';
/** Longer than the fake's switch (400 ms) and the 5 s echo window, so any stray control would have landed. */
const AFTER_SWITCH_MS = 6000;

test.describe.configure({ mode: "parallel" });

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

function pair(cs: readonly Client[]): [Client, Client] {
  const [a, b] = cs;
  if (!a || !b) throw new Error("need 2 clients");
  return [a, b];
}

/** The app's setQuality calls on this page's fake Twitch player, in order. */
const qualityCalls = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => (window.__fakeTwitch?.commands ?? []).filter((c) => c.name === "setQuality" && !c.dropped).map((c) => c.args[0]));

/** Commands the app sent this page's player after `since` (performance.now() ms). */
const commandsSince = (page: Page, since: number): Promise<string[]> =>
  page.evaluate((t) => (window.__fakeTwitch?.commands ?? []).filter((c) => c.t > t && !c.dropped).map((c) => c.name), since);

const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());

test.describe("quality, only you (M7 W5)", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(90_000);

  test("Twitch VOD: the key ends the shelf; the keyboard picks a quality for my player only; the switch's pause/seek never reaches the room", async ({ browser, request }) => {
    const room = testRoom("provider-quality", "twvod");
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "q-vod" });
    const [a, b] = pair(clients);
    await waitProviderPlaying(clients, "twitch");

    const k = a.page.locator(key);
    await expect(k).toBeVisible();
    // Before full screen, after the volume pod: a personal key in the shelf.
    expect(await k.evaluate((e) => e.nextElementSibling?.getAttribute("data-testid"))).toBe("fullscreen-toggle");
    await expect(a.page.locator(site.volume)).toBeVisible();
    await expect(k).toHaveAttribute("aria-haspopup", "menu");
    await expect(k).toHaveAttribute("aria-label", "Quality: Auto. Only you.");

    await k.focus();
    await a.page.keyboard.press("Enter");
    const m = a.page.locator(menu);
    await expect(m).toBeVisible();
    await expect(m).toHaveAttribute("role", "menu");
    await expect(m.locator(option)).toHaveText(["Auto", "1080p60 (source)", "720p60", "480p"]);
    await expect(m.locator(option).first()).toBeFocused();
    await expect(m.locator(option).first()).toHaveAttribute("aria-checked", "true");
    // It hangs under the shelf, over the room: never over the picture.
    const tvBox = await a.page.locator(site.sharedVideo).boundingBox();
    const menuBox = await m.boundingBox();
    if (tvBox === null || menuBox === null) throw new Error("no boxes");
    expect(menuBox.y).toBeGreaterThanOrEqual(tvBox.y + tvBox.height);

    const before = await roomPlayback(browser, room.id);
    const sinceB = await pageNow(b.page);
    await a.page.keyboard.press("End");
    await a.page.keyboard.press("Enter");
    await expect.poll(() => qualityCalls(a.page)).toEqual(["480p30"]);
    await expect(m.locator(option).last()).toHaveAttribute("aria-checked", "true");
    await expect(k).toHaveAttribute("aria-busy", "true");
    expect(await a.page.evaluate(() => localStorage.getItem("omega.quality.twitch"))).toBe("480p30");

    await a.page.waitForTimeout(AFTER_SWITCH_MS);
    const after = await roomPlayback(browser, room.id);
    expect(after.rev, "no control reached the room").toBe(before.rev);
    expect(after.playing).toBe(true);
    // The other viewer's player was never told to pause or seek, and both play.
    expect((await commandsSince(b.page, sinceB)).filter((n) => n === "pause" || n === "seek")).toEqual([]);
    expect(await qualityCalls(b.page)).toEqual([]);
    await waitProviderPlaying(clients, "twitch");
    await expect(k).not.toHaveAttribute("aria-busy", "true");
    await expect(k).toHaveAttribute("aria-label", "Quality: 480p. Only you.");

    // Esc closes the list and gives the keys back to the key.
    await a.page.keyboard.press("Escape");
    await expect(m).toBeHidden();
    await expect(k).toBeFocused();

    // Tab leaves the list in one press, onward from the key (QA OME-661 B); Shift+Tab lands back on the key.
    await a.page.keyboard.press("Enter");
    await expect(m).toBeVisible();
    await a.page.keyboard.press("Tab");
    await expect(m).toBeHidden();
    expect(await a.page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null)).toBe("fullscreen-toggle");
    await k.focus();
    await a.page.keyboard.press("Enter");
    await expect(m).toBeVisible();
    await a.page.keyboard.press("Shift+Tab");
    await expect(m).toBeHidden();
    await expect(k).toBeFocused();
  });

  test("Twitch live: a quality switch's pause/play stays on my screen", async ({ browser, request }) => {
    const room = testRoom("provider-quality", "live");
    await shareProvider(request, providerCase("twitchLive").shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "q-live" });
    const [a] = pair(clients);
    await waitProviderPlaying(clients, "twitch");
    const before = await roomPlayback(browser, room.id);
    await a.page.locator(key).click();
    await a.page.locator(option).filter({ hasText: "720p60" }).click();
    await expect.poll(() => qualityCalls(a.page)).toEqual(["720p60"]);
    await a.page.waitForTimeout(AFTER_SWITCH_MS);
    expect((await roomPlayback(browser, room.id)).rev).toBe(before.rev);
    await waitProviderPlaying(clients, "twitch");
  });

  test("full screen: the list is a row in the shelf's place (nothing over the picture); ←/→ move; Esc puts the shelf back", async ({ browser, request }) => {
    const room = testRoom("provider-quality", "fs");
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "q-fs" });
    const a = clients[0];
    if (!a) throw new Error("no client");
    await waitProviderPlaying(clients, "twitch");
    await a.page.locator(site.fullscreenToggle).click();
    await expect.poll(() => a.page.evaluate(() => document.fullscreenElement !== null)).toBe(true);

    await a.page.locator(key).click();
    const m = a.page.locator(menu);
    await expect(m).toBeVisible();
    await expect(m).toHaveClass(/is-row/);
    expect(await m.evaluate((e) => e.parentElement?.classList.contains("controls"))).toBe(true);
    await expect(a.page.locator(site.playToggle)).toBeHidden();
    const tvBox = await a.page.locator(site.sharedVideo).boundingBox();
    const menuBox = await m.boundingBox();
    if (tvBox === null || menuBox === null) throw new Error("no boxes");
    expect(menuBox.y).toBeGreaterThanOrEqual(tvBox.y + tvBox.height);

    await expect(m.locator(option).first()).toBeFocused();
    await a.page.keyboard.press("ArrowRight");
    await expect(m.locator(option).nth(1)).toBeFocused();
    await a.page.keyboard.press("Enter");
    await expect.poll(() => qualityCalls(a.page)).toEqual(["chunked"]);
    await a.page.keyboard.press("Escape");
    await expect(m).toBeHidden();
    await expect(a.page.locator(site.playToggle)).toBeVisible();
    await expect(a.page.locator(key)).toBeFocused();
    expect(await a.page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  });

  test("this device remembers: a new viewer with a stored quality gets it applied once, without touching the key", async ({ browser, request }) => {
    const room = testRoom("provider-quality", "memory");
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    clients = await joinRoom(browser, {
      roomUrl: room.url,
      count: 2,
      nicknamePrefix: "q-mem",
      setup: async (context, i) => {
        // Client 1 picked 720p60 on an earlier visit; client 2 has a value we'd never store (untrusted storage).
        const stored = i === 0 ? "720p60" : "<b>1080p</b>\n";
        await context.addInitScript((v) => {
          localStorage.setItem("omega.quality.twitch", v);
        }, stored);
      },
    });
    const [a, b] = pair(clients);
    await waitProviderPlaying(clients, "twitch");
    await expect.poll(() => qualityCalls(a.page)).toEqual(["720p60"]);
    await expect.poll(() => a.page.evaluate(() => window.__fakeTwitch?.quality)).toBe("720p60");
    await a.page.waitForTimeout(1000);
    expect(await qualityCalls(a.page)).toEqual(["720p60"]);
    expect(await qualityCalls(b.page)).toEqual([]);
  });

  test("YouTube: no key at all (no API since 2019), and the shelf keeps the volume pod", async ({ browser, request }) => {
    const room = testRoom("provider-quality", "yt");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "q-yt" });
    const a = clients[0];
    if (!a) throw new Error("no client");
    await waitPlaying(clients);
    await expect(a.page.locator(site.volume)).toBeVisible();
    await expect(a.page.locator(key)).toBeHidden();
    await expect(a.page.locator(menu)).toHaveCount(0);
  });

  test("a synced video after a generic one gets the whole shelf back: transport, volume pod, quality key", async ({ browser, request }) => {
    const room = testRoom("provider-quality", "generic");
    await shareProvider(request, `https://${GENERIC_HOST}/embed/42`, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "q-gen" });
    const a = clients[0];
    if (!a) throw new Error("no client");
    await expect(a.page.locator(key)).toBeHidden();
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    await waitProviderPlaying(clients, "twitch");
    await expect(a.page.locator(site.playToggle)).toBeVisible();
    await expect(a.page.locator(site.volume)).toBeVisible();
    await expect(a.page.locator(key)).toBeVisible();
  });
});
