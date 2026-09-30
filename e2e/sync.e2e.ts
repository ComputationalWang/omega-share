// M1b sync suite (OME-90): 8 contexts in one room, the real server, clock sync, sync loop and YouTube adapter,
// against the fake iframe_api (OME-85). Spread = max − min of (expected − actual) across clients, 2 s after an
// action; each client stamps its own sample with wall-clock time, which the server shares on localhost.
// Runs in its own Playwright project after `e2e`, one worker, because every spec shares the lobby.
import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { VIDEO_ID } from "./support/network";
import { joinRoom, leaveAll, type Client } from "./support/room";
import { site } from "./support/selectors";
import { PLAYING, PAUSED, SPREAD_BUDGET_MS, SETTLE_MS, fakeState, measureSpread, roomPlayback, sampleClients, shareVideo, waitPlaying } from "../perf/sync";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;

test.describe.configure({ mode: "serial" });

const pair = (clients: readonly Client[]): [Client, Client] => {
  const [a, b] = clients;
  if (!a || !b) throw new Error("need two clients");
  return [a, b];
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
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 8, nicknamePrefix: "sync" });
    const [a] = pair(clients);
    await shareVideo(request);
    await waitPlaying(clients);

    const results: Record<string, unknown> = {};
    const step = async (name: string, act: () => Promise<void>, check: (playing: boolean, position: number) => void) => {
      await act();
      await a.page.waitForTimeout(SETTLE_MS);
      const m = await measureSpread(browser, clients);
      results[name] = m;
      check(m.playback.playing, m.playback.position);
      expect(m.playback.action, name).toBe(name);
      expect(m.spreadMs, `${name}: drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    };

    await step("pause", () => a.page.locator(site.playToggle).click(), (playing) => {
      expect(playing).toBe(false);
    });
    for (const c of clients) expect(await fakeState(c.page)).toBe(PAUSED);
    await step("play", () => a.page.locator(site.playToggle).click(), (playing) => {
      expect(playing).toBe(true);
    });
    await step("seek", () => a.page.locator(site.seek).fill("120"), (playing, position) => {
      expect(playing).toBe(true);
      expect(position).toBeCloseTo(120, 0);
    });
    for (const c of clients) expect(await fakeState(c.page)).toBe(PLAYING);
    await attach(info, "spreads", results);
  });

  test("a late joiner is within 500 ms", async ({ browser, request }, info) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 7, nicknamePrefix: "early" });
    await shareVideo(request);
    await waitPlaying(clients);
    await clients[0]?.page.locator(site.seek).fill("200");
    await clients[0]?.page.waitForTimeout(3000);

    const late = await joinRoom(browser, { roomUrl: ROOM_URL, count: 1, nicknamePrefix: "late" });
    clients.push(...late);
    await waitPlaying(late);
    await clients[0]?.page.waitForTimeout(SETTLE_MS);
    const m = await measureSpread(browser, clients);
    await attach(info, "late-joiner", m);
    expect(m.playback.playing).toBe(true);
    expect(m.spreadMs, `drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms (late joiner last)`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
  });

  test("a 3 s buffer on one client doesn't pause the room, and it catches up", async ({ browser, request }, info) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 8, nicknamePrefix: "buf" });
    const [a, b] = pair(clients);
    await shareVideo(request);
    await waitPlaying(clients);
    const before = await roomPlayback(browser);

    await b.page.evaluate(() => window.__fakeYt?.buffering(3000));
    await b.page.waitForTimeout(1500);
    // Mid-stall: nobody else stopped, the room didn't change, and B says it's catching up.
    for (const c of clients) if (c !== b) expect(await fakeState(c.page), c.nickname).toBe(PLAYING);
    const during = await roomPlayback(browser);
    expect(during.rev).toBe(before.rev);
    expect(during.playing).toBe(true);
    await expect(b.page.locator(site.catchingNotice)).toBeVisible();
    await expect(a.page.locator(site.catchingNotice)).toBeHidden();

    // After the stall B is ~3 s behind; the sync loop pulls it back.
    await expect.poll(async () => (await measureSpread(browser, clients)).spreadMs, { timeout: 10_000, intervals: [500] }).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    expect((await roomPlayback(browser)).rev).toBe(before.rev);
    await expect(b.page.locator(site.catchingNotice)).toBeHidden();
    await attach(info, "after-buffer", await measureSpread(browser, clients));
  });

  test("an ad on one client doesn't pause the room", async ({ browser, request }, info) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 8, nicknamePrefix: "ad" });
    const [, b] = pair(clients);
    await shareVideo(request);
    await waitPlaying(clients);
    const before = await roomPlayback(browser);
    const lines = await Promise.all(clients.map((c) => c.page.locator(site.systemLine).count()));

    await b.page.evaluate(() => window.__fakeYt?.ad(4000));
    await b.page.waitForTimeout(2000);
    for (const c of clients) if (c !== b) expect(await fakeState(c.page), c.nickname).toBe(PLAYING);
    const during = await roomPlayback(browser);
    expect(during.rev).toBe(before.rev);
    expect(during.playing).toBe(true);
    // No pause/play line anywhere: the ad never reached the room.
    for (const [i, c] of clients.entries()) await expect(c.page.locator(site.systemLine)).toHaveCount(lines[i] ?? 0);

    await expect.poll(async () => (await measureSpread(browser, clients)).spreadMs, { timeout: 10_000, intervals: [500] }).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    expect((await roomPlayback(browser)).rev).toBe(before.rev);
    await attach(info, "after-ad", await measureSpread(browser, clients));
  });

  test("a click-pause inside the player becomes a room pause, with a system line in the chat", async ({ browser, request }) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 8, nicknamePrefix: "click" });
    const [a] = pair(clients);
    await shareVideo(request);
    await waitPlaying(clients);

    // A has been watching for a bit (clear of the adapter's 1 s echo window), then clicks the video itself.
    await a.page.waitForTimeout(SETTLE_MS);
    await a.page.evaluate(() => window.__fakeYt?.clickToggle());
    for (const c of [...clients.slice(1), a]) {
      await expect.poll(() => fakeState(c.page), { timeout: 5_000, message: c.nickname }).toBe(PAUSED);
      await expect(c.page.locator(site.systemLine).last()).toHaveText(c === a ? "You paused" : `${a.nickname} paused`);
      await expect(c.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Play for everyone");
    }
    const p = await roomPlayback(browser);
    expect(p.playing).toBe(false);
    expect(p.action).toBe("pause");
  });

  test("a volume change on A doesn't affect B", async ({ browser, request }) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 8, nicknamePrefix: "vol" });
    const [a, b] = pair(clients);
    await shareVideo(request);
    await waitPlaying(clients);
    const before = await roomPlayback(browser);
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
    expect((await roomPlayback(browser)).rev).toBe(before.rev);
  });

  test("the iframe's sandbox, allow and src are the canonical form", async ({ browser, request }) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 2, nicknamePrefix: "frame" });
    await shareVideo(request);
    await waitPlaying(clients);
    for (const c of clients) {
      await expect(c.page.locator("iframe")).toHaveCount(1);
      const tv = c.page.locator(site.sharedVideo);
      expect(await tv.evaluate((e) => e.tagName)).toBe("IFRAME");
      expect(await tv.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox");
      expect(await tv.getAttribute("allow")).toBe("autoplay; encrypted-media; picture-in-picture; fullscreen");
      expect(await tv.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
      const origin = new URL(c.page.url()).origin;
      const src = new URL((await tv.getAttribute("src")) ?? "");
      expect(`${src.origin}${src.pathname}`).toBe(`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`);
      expect(Object.fromEntries(src.searchParams)).toEqual({
        enablejsapi: "1",
        origin,
        controls: "0",
        disablekb: "1",
        playsinline: "1",
        rel: "0",
        autoplay: "1",
      });
      expect(src.hash).toBe("");
    }
  });

  test("the CSP blocks a non-allowlisted script", async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 1, nicknamePrefix: "csp" });
    const [{ page }] = clients as [Client];
    // If CSP let them through, these would run and bump the counter.
    const pwn = { contentType: "text/javascript", body: "window.__pwned = (window.__pwned ?? 0) + 1;" };
    for (const url of ["https://evil.example/pwn.js", "https://www.youtube.com/not-the-api.js"]) {
      await page.route(url, (r) => r.fulfill(pwn));
    }
    const blocked = await page.evaluate(async (urls) => {
      const violations: string[] = [];
      document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
      const load = (src: string) =>
        new Promise<string>((resolve) => {
          const s = document.createElement("script");
          s.src = src;
          s.onload = () => {
            resolve("loaded");
          };
          s.onerror = () => {
            resolve("blocked");
          };
          document.head.append(s);
        });
      const results = await Promise.all(urls.map(load));
      // Inline script too: script-src has no 'unsafe-inline'.
      const inline = document.createElement("script");
      inline.textContent = "window.__pwned = (window.__pwned ?? 0) + 1;";
      document.head.append(inline);
      await new Promise((r) => setTimeout(r, 100));
      return { results, violations, pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0 };
    }, ["https://evil.example/pwn.js", "https://www.youtube.com/not-the-api.js"]);
    expect(blocked.results).toEqual(["blocked", "blocked"]);
    expect(blocked.pwned).toBe(0);
    expect(blocked.violations).toEqual(
      expect.arrayContaining([
        "script-src-elem https://evil.example/pwn.js",
        "script-src-elem https://www.youtube.com/not-the-api.js",
        "script-src-elem inline",
      ]),
    );
  });

  test("our tab URL is unchanged after a player popup", async ({ browser, request }) => {
    clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 1, nicknamePrefix: "popup" });
    const [{ page, context }] = clients as [Client];
    await shareVideo(request);
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
    expect(await sampleClients(clients)).toHaveLength(1);
    expect(await fakeState(page)).toBe(PLAYING);
  });
});
