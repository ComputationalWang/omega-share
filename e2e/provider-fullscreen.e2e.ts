// OME-597 (M7 W2): full screen goes on our own wrapper (picture + chat strip), never on the provider's iframe. Per
// provider: entering and leaving moves no node, so the player element is the same one before, during and after, its
// iframe never loads again, and the room stays in sync while one viewer watches in full screen (spread ≤ 500 ms 2 s
// after a pause / play / seek, as provider-sync.e2e.ts; Twitch live: arrival of the pause and the play-from-live).
// Runs in the `e2e-sync` project; each case has a seeded room of its own.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";
import { GENERIC_HOST, GENERIC_PAGE, fakePlaying, measureLiveArrival, measureProviderSpread, providerCase, shareProvider, waitProviderPlaying, type ProviderCase } from "../perf/providers";
import { SETTLE_MS, SPREAD_BUDGET_MS, measureSpread, shareVideo, waitPlaying } from "../perf/sync";

const CLIENTS = 3;
const toLive = '[data-testid="to-live"]';

test.describe.configure({ mode: "parallel" });

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const first = (cs: readonly Client[]): Client => {
  const [a] = cs;
  if (!a) throw new Error("no clients");
  return a;
};

/** Remember the player element and count its iframe's loads from now on. */
async function watchPlayer(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    if (v === null) throw new Error("no player");
    const frame = v instanceof HTMLIFrameElement ? v : v.querySelector("iframe");
    Reflect.set(window, "__fsPlayer", v);
    Reflect.set(window, "__fsFrame", frame);
    Reflect.set(window, "__fsLoads", 0);
    frame?.addEventListener("load", () => {
      Reflect.set(window, "__fsLoads", Number(Reflect.get(window, "__fsLoads")) + 1);
    });
  }, site.sharedVideo);
}

/** Same player element, same iframe, still in the page, and no iframe load since `watchPlayer`. */
async function samePlayer(page: Page): Promise<{ same: boolean; connected: boolean; loads: number }> {
  return page.evaluate((sel) => {
    const v = document.querySelector(sel);
    const was: unknown = Reflect.get(window, "__fsPlayer");
    const frame: unknown = Reflect.get(window, "__fsFrame");
    const nowFrame = v instanceof HTMLIFrameElement ? v : (v?.querySelector("iframe") ?? null);
    return { same: v === was && nowFrame === frame, connected: v?.isConnected === true, loads: Number(Reflect.get(window, "__fsLoads")) };
  }, site.sharedVideo);
}

/** Enter full screen with our key; the full-screen element is our wrapper, which holds the player. */
async function enter(page: Page): Promise<void> {
  await page.locator(site.fullscreenToggle).click();
  await expect
    .poll(() =>
      page.evaluate((sel) => {
        const fs = document.fullscreenElement;
        return fs !== null && fs.matches(sel) && fs.querySelector('[data-testid="shared-video"]') !== null;
      }, site.fsRoot),
    )
    .toBe(true);
  await expect(page.locator(site.fsStrip)).toBeVisible();
}

async function leave(page: Page): Promise<void> {
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.locator(site.fsStrip)).toBeHidden();
}

test.describe("full screen on our wrapper, per provider (M7 W2)", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(90_000);

  const seekable: { c: ProviderCase | null; name: string; room: RoomName<"provider-fullscreen"> }[] = [
    { c: null, name: "YouTube", room: "yt" },
    { c: providerCase("twitchVod"), name: "Twitch VOD", room: "twvod" },
    { c: providerCase("vimeo"), name: "Vimeo", room: "vimeo" },
  ];
  for (const { c, name, room: roomName } of seekable) {
    test(`${name}: same player before, during and after; spread ≤ 500 ms while one viewer is in full screen`, async ({ browser, request }) => {
      const room = testRoom("provider-fullscreen", roomName);
      if (c === null) await shareVideo(request, room.id);
      else await shareProvider(request, c.shareUrl, room.id);
      clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: `fs-${roomName}` });
      const [a, b] = clients;
      if (!a || !b) throw new Error("need 2 clients");
      if (c === null) await waitPlaying(clients);
      else await waitProviderPlaying(clients, c.provider);
      await watchPlayer(a.page);

      await enter(a.page);
      expect(await samePlayer(a.page)).toEqual({ same: true, connected: true, loads: 0 });

      const measure = (): ReturnType<typeof measureSpread> => (c === null ? measureSpread(browser, clients, room.id) : measureProviderSpread(browser, clients, c.provider, room.id));
      // The full-screen viewer drives too: the shelf stays under the picture.
      const steps: [string, () => Promise<void>, boolean][] = [
        ["pause", () => a.page.locator(site.playToggle).click(), false],
        ["play", () => b.page.locator(site.playToggle).click(), true],
        ["seek", () => b.page.locator(site.seek).fill("120"), true],
      ];
      for (const [action, act, playing] of steps) {
        await act();
        await a.page.waitForTimeout(SETTLE_MS);
        const m = await measure();
        expect(m.playback.action, action).toBe(action);
        expect(m.playback.playing).toBe(playing);
        expect(m.spreadMs, `${action}: drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
        if (c !== null) expect(await fakePlaying(a.page, c.provider)).toBe(playing);
      }
      expect(await a.page.evaluate(() => document.fullscreenElement !== null)).toBe(true);

      await leave(a.page);
      expect(await samePlayer(a.page)).toEqual({ same: true, connected: true, loads: 0 });
    });
  }

  test("Twitch live: same player; pause and play-from-live reach every client within 500 ms while one is in full screen", async ({ browser, request }) => {
    const room = testRoom("provider-fullscreen", "live");
    await shareProvider(request, providerCase("twitchLive").shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: "fs-live" });
    const a = first(clients);
    await waitProviderPlaying(clients, "twitch");
    await watchPlayer(a.page);
    await enter(a.page);
    const pause = await measureLiveArrival(clients, "pause", () => a.page.locator(site.playToggle).click());
    await waitProviderPlaying(clients, "twitch", false);
    await expect(a.page.locator(toLive)).toBeEnabled();
    const play = await measureLiveArrival(clients, "play", () => a.page.locator(toLive).click());
    await waitProviderPlaying(clients, "twitch");
    for (const [n, r] of [["pause", pause], ["play", play]] as const) {
      expect(r.spreadMs, `${n}: first to last ${r.spreadMs.toFixed(0)} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      expect(r.latencyMs, `${n}: last ${r.latencyMs.toFixed(0)} ms after the click`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    }
    await leave(a.page);
    expect(await samePlayer(a.page)).toEqual({ same: true, connected: true, loads: 0 });
  });

  test("generic embed (ADR 0024): the loaded sandboxed iframe stays the same and keeps running through full screen", async ({ browser, request }) => {
    const room = testRoom("provider-fullscreen", "generic");
    await shareProvider(request, `https://${GENERIC_HOST}/embed/42`, room.id);
    clients = await joinRoom(browser, {
      roomUrl: room.url,
      count: 1,
      nicknamePrefix: "fs-generic",
      setup: async (context) => {
        await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
      },
    });
    const a = first(clients);
    await a.page.getByTestId("generic-load").click({ timeout: 15_000 });
    const frame = a.page.frameLocator(site.sharedVideo);
    await expect(frame.locator("div")).toBeVisible({ timeout: 15_000 });
    await watchPlayer(a.page);
    const frames = (): Promise<number> => frame.locator("body").evaluate(() => Number(Reflect.get(window, "__genericFrames")));
    await enter(a.page);
    const during = await frames();
    await expect.poll(frames).toBeGreaterThan(during);
    await leave(a.page);
    expect(await samePlayer(a.page)).toEqual({ same: true, connected: true, loads: 0 });
  });
});
