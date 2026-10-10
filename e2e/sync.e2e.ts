// M1b sync suite (OME-90): 8 contexts in one room, the real server, clock sync, sync loop and YouTube adapter,
// against the fake iframe_api (OME-85). Spread = max − min of (expected − actual) across clients, 2 s after an
// action; each client stamps its own sample with wall-clock time, which the server shares on localhost.
// Each test has a room of its own (OME-341), so the suite runs alongside the rest, its tests in parallel.
import { expect, test } from "./support/csp";
import type { Page, TestInfo } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { VIDEO_ID } from "./support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { PLAYING, PAUSED, SPREAD_BUDGET_MS, SETTLE_MS, fakeState, measureSpread, roomPlayback, shareVideo, waitPlaying } from "../perf/sync";

// Each test has its own room, so they spread over the lane's workers (OME-341).
test.describe.configure({ mode: "parallel" });

const pair = (clients: readonly Client[]): [Client, Client] => {
  const [a, b] = clients;
  if (!a || !b) throw new Error("need two clients");
  return [a, b];
};

const only = (clients: readonly Client[]): Client => {
  const [a] = clients;
  if (!a || clients.length !== 1) throw new Error("need one client");
  return a;
};

async function attach(info: TestInfo, name: string, body: unknown): Promise<void> {
  await info.attach(name, { body: JSON.stringify(body, null, 2), contentType: "application/json" });
}

const volumeOf = (page: Page) => page.evaluate(() => window.__fakeYt?.player?.getVolume() ?? null);

test.describe("M1b sync, 8 clients", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(90_000);

  let clients: Client[] = [];
  test.afterEach(async () => {
    await leaveAll(clients);
    clients = [];
  });

  test("play, pause and seek: spread ≤ 500 ms 2 s later", async ({ browser, request }, info) => {
    const room = testRoom("sync", "spread");
    // Share first: joining after means no client can still be playing the previous test's video.
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 8, nicknamePrefix: "sync" });
    const [a] = pair(clients);
    await waitPlaying(clients);

    const results: Record<string, unknown> = {};
    const step = async (name: string, act: () => Promise<void>, check: (playing: boolean, position: number) => void) => {
      await act();
      await a.page.waitForTimeout(SETTLE_MS);
      const m = await measureSpread(browser, clients, room.id);
      results[name] = m;
      check(m.playback.playing, m.playback.position);
      expect(m.playback.action, name).toBe(name);
      expect(m.spreadMs, `${name}: drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    };

    await step("pause", () => a.page.locator(site.playToggle).click(), (playing) => {
      expect(playing).toBe(false);
    });
    for (const c of clients) expect(await fakeState(c.page)).toBe(PAUSED);
    // Everyone else sees who did it (folded in from the old sync-smoke spec, OME-89/OME-341).
    for (const c of clients.slice(1)) {
      await expect(c.page.locator(site.systemLine).last()).toHaveText(`${a.nickname} paused`);
      await expect(c.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Play for everyone");
    }
    await step("play", () => a.page.locator(site.playToggle).click(), (playing) => {
      expect(playing).toBe(true);
    });
    for (const c of clients) expect(await fakeState(c.page)).toBe(PLAYING);
    for (const c of clients.slice(1)) await expect(c.page.locator(site.systemLine).last()).toHaveText(`${a.nickname} pressed play`);
    await step("seek", () => a.page.locator(site.seek).fill("120"), (playing, position) => {
      expect(playing).toBe(true);
      expect(position).toBeCloseTo(120, 0);
    });
    for (const c of clients) expect(await fakeState(c.page)).toBe(PLAYING);
    await attach(info, "spreads", results);
  });

  test("a late joiner is within 500 ms", async ({ browser, request }, info) => {
    const room = testRoom("sync", "late");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 7, nicknamePrefix: "early" });
    await waitPlaying(clients);
    const [first] = pair(clients);
    await first.page.locator(site.seek).fill("200");
    await expect.poll(async () => (await roomPlayback(browser, room.id)).action, { timeout: 5_000 }).toBe("seek");
    const seeked = await roomPlayback(browser, room.id);
    expect(seeked.position).toBeGreaterThanOrEqual(200);

    const late = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "late" });
    clients.push(...late);
    await waitPlaying(late);
    await first.page.waitForTimeout(SETTLE_MS);
    const m = await measureSpread(browser, clients, room.id);
    await attach(info, "late-joiner", m);
    expect(m.playback.rev).toBe(seeked.rev);
    expect(m.playback.playing).toBe(true);
    expect(m.spreadMs, `drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms (late joiner last)`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
  });

  test("a 3 s buffer on one client doesn't pause the room, and it catches up", async ({ browser, request }, info) => {
    const room = testRoom("sync", "buffer");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 8, nicknamePrefix: "buf" });
    const [a, b] = pair(clients);
    await waitPlaying(clients);
    const before = await roomPlayback(browser, room.id);

    await b.page.evaluate(() => window.__fakeYt?.buffering(3000));
    // The notice shows from ~0.5 s into the stall until it ends at 3 s. Check it first: roomPlayback opens a fresh
    // context and loads the site, which on a loaded CI runner can outlast the stall (OME-863).
    await expect(b.page.locator(site.catchingNotice)).toBeVisible({ timeout: 2_500 });
    await expect(a.page.locator(site.catchingNotice)).toBeHidden();
    // Nobody else stopped and the room didn't change.
    for (const c of clients) if (c !== b) expect(await fakeState(c.page), c.nickname).toBe(PLAYING);
    const during = await roomPlayback(browser, room.id);
    expect(during.rev).toBe(before.rev);
    expect(during.playing).toBe(true);

    // After the stall B is ~3 s behind; the sync loop pulls it back.
    await expect.poll(async () => (await measureSpread(browser, clients, room.id)).spreadMs, { timeout: 10_000, intervals: [500] }).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    expect((await roomPlayback(browser, room.id)).rev).toBe(before.rev);
    await expect(b.page.locator(site.catchingNotice)).toBeHidden();
    await attach(info, "after-buffer", await measureSpread(browser, clients, room.id));
  });

  test("an ad on one client doesn't pause the room", async ({ browser, request }, info) => {
    const room = testRoom("sync", "ad");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 8, nicknamePrefix: "ad" });
    const [, b] = pair(clients);
    await waitPlaying(clients);
    const before = await roomPlayback(browser, room.id);
    const lines = await Promise.all(clients.map((c) => c.page.locator(site.systemLine).count()));

    await b.page.evaluate(() => window.__fakeYt?.ad(4000));
    await b.page.waitForTimeout(2000);
    for (const c of clients) if (c !== b) expect(await fakeState(c.page), c.nickname).toBe(PLAYING);
    const during = await roomPlayback(browser, room.id);
    expect(during.rev).toBe(before.rev);
    expect(during.playing).toBe(true);
    // No pause/play line anywhere: the ad never reached the room.
    for (const [i, c] of clients.entries()) await expect(c.page.locator(site.systemLine)).toHaveCount(lines[i] ?? 0);

    await expect.poll(async () => (await measureSpread(browser, clients, room.id)).spreadMs, { timeout: 10_000, intervals: [500] }).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    expect((await roomPlayback(browser, room.id)).rev).toBe(before.rev);
    await attach(info, "after-ad", await measureSpread(browser, clients, room.id));
  });

  test("a click-pause inside the player becomes a room pause, with a system line in the chat", async ({ browser, request }) => {
    const room = testRoom("sync", "click");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 8, nicknamePrefix: "click" });
    const [a] = pair(clients);
    await waitPlaying(clients);

    // A has been watching for a bit (clear of the adapter's 1 s echo window), then clicks the video itself.
    await a.page.waitForTimeout(SETTLE_MS);
    await a.page.evaluate(() => window.__fakeYt?.clickToggle());
    for (const c of [...clients.slice(1), a]) {
      await expect.poll(() => fakeState(c.page), { timeout: 5_000, message: c.nickname }).toBe(PAUSED);
      await expect(c.page.locator(site.systemLine).last()).toHaveText(c === a ? "You paused" : `${a.nickname} paused`);
      await expect(c.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Play for everyone");
    }
    const p = await roomPlayback(browser, room.id);
    expect(p.playing).toBe(false);
    expect(p.action).toBe("pause");
  });

  test("YouTube refusing the embed (error 150) shows a site notice and freezes this client's transport", async ({ browser, request }) => {
    const room = testRoom("sync", "err150");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "noembed" });
    const [a, b] = pair(clients);
    await waitPlaying(clients);

    await a.page.evaluate(() => window.__fakeYt?.error(150));
    await expect(a.page.locator(site.syncNotice)).toBeVisible();
    await expect(a.page.locator(site.syncNotice)).toHaveText(/can't play here.*owner doesn't allow playback on other sites/);
    await expect(a.page.locator(site.playToggle)).toBeDisabled();
    await expect(a.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Play for everyone");
    // Only the refused client: the room keeps playing for the others.
    await expect(b.page.locator(site.syncNotice)).toBeHidden();
    await expect(b.page.locator(site.playToggle)).toBeEnabled();
    expect((await roomPlayback(browser, room.id)).playing).toBe(true);
  });

  test("a volume change on A doesn't affect B", async ({ browser, request }) => {
    const room = testRoom("sync", "volume");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 8, nicknamePrefix: "vol" });
    const [a, b] = pair(clients);
    await waitPlaying(clients);
    const before = await roomPlayback(browser, room.id);
    const bVolume = await volumeOf(b.page);
    const bSlider = await b.page.locator(site.volume).inputValue();

    await a.page.locator(site.volume).fill("30");
    await expect.poll(() => volumeOf(a.page)).toBe(30);
    await a.page.waitForTimeout(1000);
    for (const c of clients) {
      if (c === a) continue;
      expect(await volumeOf(c.page), c.nickname).toBe(bVolume);
      await expect(c.page.locator(site.volume)).toHaveValue(bSlider);
    }
    // Mute is personal too.
    await a.page.locator(site.muteToggle).click();
    await expect(a.page.locator(site.muteToggle)).toHaveAttribute("aria-pressed", "true");
    for (const c of clients) if (c !== a) await expect(c.page.locator(site.muteToggle), c.nickname).toHaveAttribute("aria-pressed", "false");
    expect(await fakeState(b.page)).toBe(PLAYING);
    expect((await roomPlayback(browser, room.id)).rev).toBe(before.rev);
  });

  test("our tab URL is unchanged after a player popup", async ({ browser, request }) => {
    const room = testRoom("sync", "popup");
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "popup" });
    const { page, context } = only(clients);
    await waitPlaying(clients);
    const url = page.url();
    const frame = page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).hostname === "www.youtube-nocookie.com");
    if (!frame) throw new Error("no player frame");

    // The player's own "watch on YouTube" link: a real click on a target=_blank link inside the frame.
    await frame.evaluate((href) => {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.textContent = "Watch on YouTube";
      link.id = "yt-link";
      link.style.cssText = "position:fixed;inset:0;display:block;color:#fff";
      document.body.append(link);
    }, `https://www.youtube.com/watch?v=${VIDEO_ID}`);
    const [popup] = await Promise.all([context.waitForEvent("page"), frame.locator("#yt-link").click()]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).hostname).toBe("www.youtube.com");

    // And the frame can't navigate us away (no allow-top-navigation).
    await frame.evaluate(() => {
      try {
        window.top?.location.assign("https://evil.example/");
      } catch {
        // Chromium may throw or just refuse; either way our tab must stay put.
      }
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe(url);
    await expect(page.locator(site.room)).toBeVisible();
    await expect(page.locator(site.sharedVideo)).toBeVisible();
    // The room keeps playing in our tab.
    expect(await fakeState(page)).toBe(PLAYING);
  });
});
