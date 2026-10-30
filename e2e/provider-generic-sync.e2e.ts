// ADR 0057 (OME-1976): a generic embed synced by the extension. Two viewers with the extension unlock the host and their
// frame follows the room; a third without it stays "Not synced" and never gets a command. The host is the local
// <video> fixture served on a fake https origin by the spec's routes. Runs in `e2e-sync` with the other provider-* specs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Frame, type Page, type Route } from "@playwright/test";
import { COUNTDOWN_MS } from "@omega/shared";
import { expect, test } from "./support/extension";
import { EXTENSION_DIR, PENDING, ROOT, URLS, available } from "./support/apps";
import { watchCsp } from "./support/csp";
import { stubExternalNetwork } from "./support/network";
import { joinRoom, testRoom } from "./support/room";
import { joinForToken, postShare } from "./support/share";
import { site } from "./support/selectors";
import { offsetMs, sampleVideo, type VideoSample } from "./real/real";

const ROOM = testRoom("provider-generic-sync", "main");
const HOST = "xfo.omega-fixture.net";
const EMBED_URL = `https://${HOST}/video-frame.html`;
const PAGES = join(ROOT, "e2e/fixtures/pages");
const HTML = readFileSync(join(PAGES, "video-frame.html"));
const WEBM = readFileSync(join(PAGES, "clip.webm"));
const SPREAD_MS = 500;

declare const chrome: { storage: { local: { set(items: Record<string, string>): Promise<void> } } };

/** Serves the fixture host from the fixture files (Range-aware: Chromium's media stack asks for byte ranges). */
async function serveHost(context: BrowserContext): Promise<void> {
  await context.route(`https://${HOST}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/video-frame.html") return route.fulfill({ contentType: "text/html", body: HTML });
    if (path !== "/clip.webm") return route.fulfill({ status: 404, body: "" });
    const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
    if (m === null) return route.fulfill({ contentType: "video/webm", headers: { "accept-ranges": "bytes" }, body: WEBM });
    const start = m[1] === "" ? 0 : Number(m[1]);
    const end = m[2] === "" ? WEBM.length - 1 : Math.min(Number(m[2]), WEBM.length - 1);
    return route.fulfill({
      status: 206,
      contentType: "video/webm",
      headers: { "accept-ranges": "bytes", "content-range": `bytes ${String(start)}-${String(end)}/${String(WEBM.length)}` },
      body: WEBM.subarray(start, end + 1),
    });
  });
}

/** A second persistent Chromium with the extension, launched like the `context` fixture. */
async function extensionContext(): Promise<BrowserContext> {
  const context = await watchCsp(await chromium.launchPersistentContext("", {
    channel: "chromium",
    baseURL: URLS.fixtures,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  }));
  await stubExternalNetwork(context);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // The unlock only answers a room tab on "our origin": the site, since the spec shares through the API.
  await sw.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), URLS.web);
  await serveHost(context);
  return context;
}

async function enterRoom(context: BrowserContext, nickname: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ROOM.url);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  return page;
}

const hostFrame = (page: Page): Frame | undefined => page.frames().find((f) => !f.isDetached() && f.url() === EMBED_URL);

async function frameOf(page: Page): Promise<Frame> {
  await expect.poll(() => hostFrame(page) !== undefined, { timeout: 15_000 }).toBe(true);
  const f = hostFrame(page);
  if (f === undefined) throw new Error("host frame went away");
  return f;
}

/** Unlock from the card (the iframe is then made under the extension's rules and the script attaches): "Synced". */
async function unlockAndSync(page: Page): Promise<Frame> {
  await page.getByTestId("generic-unlock").click({ timeout: 20_000 });
  const frame = await frameOf(page);
  await expect(page.getByTestId("synced")).toHaveCount(1, { timeout: 20_000 });
  return frame;
}

async function sample(f: Frame): Promise<VideoSample> {
  const s = await sampleVideo(f);
  if (s === null) throw new Error("no <video> in the host frame");
  return s;
}

/** How far `a` is from `b` in ms: position at one rate when either plays, plain difference when both are paused. */
const spreadMs = (a: VideoSample, b: VideoSample): number => (a.paused && b.paused ? (a.currentTime - b.currentTime) * 1000 : offsetMs(a, b));

test.describe("generic embed synced by the extension (ADR 0057)", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.fixme(!available.extension, PENDING.extension);

  test("two extension viewers follow the room, a third without it stays unsynced, only a real click moves the room", async ({ context, serviceWorker, browser, request }, info) => {
    test.setTimeout(240_000);
    const tag = `${String(info.repeatEachIndex)}${String(info.retry)}`; // a left nickname is held for a while
    await serviceWorker.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), URLS.web);
    await serveHost(context);
    const ctxB = await extensionContext();
    try {
      const sharer = await joinForToken(ROOM.id, `gsync-sharer-${tag}`);
      try {
        expect((await postShare(request, ROOM.id, sharer.token, EMBED_URL)).status()).toBe(200);
      } finally {
        sharer.close();
      }

      const a = await enterRoom(context, `gsync-a-${tag}`);
      const b = await enterRoom(ctxB, `gsync-b-${tag}`);
      const [c] = await joinRoom(browser, { roomUrl: ROOM.url, count: 1, nicknamePrefix: `gsync-c-${tag}`, setup: serveHost });
      if (c === undefined) throw new Error("viewer C did not join");
      try {
        // C: no extension. Load plays the frame on its own; the label stays "Not synced".
        await c.page.getByTestId("generic-load").click({ timeout: 20_000 });
        const fc = await frameOf(c.page);
        await expect(c.page.getByTestId("not-synced")).toBeVisible();
        await expect(c.page.getByTestId("generic-unlock")).toHaveCount(0);

        const fa = await unlockAndSync(a);
        const fb = await unlockAndSync(b);
        await info.attach("viewers-synced", { body: await a.screenshot(), contentType: "image/png" });

        const results: Record<string, number[]> = {};
        // Waits until both frames agree on paused/playing (a seek can leave one buffering), then samples the spread a few times.
        const measure = async (name: string, playing: boolean, at?: number): Promise<void> => {
          await expect
            .poll(async () => {
              const [sa, sb] = await Promise.all([sample(fa), sample(fb)]);
              return sa.paused === !playing && sb.paused === !playing && (at === undefined || Math.abs(sa.currentTime - at) < 3);
            }, { timeout: 15_000, intervals: [250], message: `${name}: both frames ${playing ? "playing" : "paused"}` })
            .toBe(true);
          const spreads: number[] = [];
          for (let i = 0; i < 4; i++) {
            const [sa, sb] = await Promise.all([sample(fa), sample(fb)]);
            spreads.push(Math.round(spreadMs(sa, sb)));
            await a.waitForTimeout(300);
          }
          results[name] = spreads;
          expect(Math.max(...spreads.map(Math.abs)), `${name} spread ${JSON.stringify(spreads)}`).toBeLessThanOrEqual(SPREAD_MS);
          const sc = await sample(fc);
          expect({ paused: sc.paused, t: sc.currentTime }, `${name}: C's video is never commanded`).toEqual({ paused: true, t: 0 });
        };
        /** Puts the room to playing or paused with A's control, only if it isn't there already. A play from paused is the shared 3-2-1. */
        const roomTo = async (playing: boolean): Promise<void> => {
          if ((await sample(fa)).paused === !playing) return;
          await a.locator(site.playToggle).click();
          if (playing) await a.waitForTimeout(COUNTDOWN_MS);
        };

        await roomTo(true);
        await measure("play", true);
        await roomTo(false);
        await measure("pause", false);
        await roomTo(true);
        await a.locator(site.seek).fill("20");
        await measure("seek", true, 20);

        // §5: a real click inside A's frame is the viewer's own: it moves the room, and B follows.
        await roomTo(false);
        await measure("pause-before-click", false);
        await fa.locator("#play").click();
        await a.waitForTimeout(COUNTDOWN_MS);
        await measure("click-play", true);
        await fa.locator("#seek").click();
        await measure("click-seek", true, 20);
        await info.attach("after-click-seek", { body: await b.screenshot(), contentType: "image/png" });

        // A script-only play() in B's frame has no user activation: it must not move the room.
        await roomTo(false);
        await measure("pause-before-script", false);
        // Playwright's frame.evaluate (the samples above) runs with a user gesture, and Chromium keeps that transient
        // activation for 5 s: let it lapse, then play over raw CDP with no gesture.
        await b.waitForTimeout(6_000);
        const cdp = await ctxB.newCDPSession(fb);
        const active: unknown = (await cdp.send("Runtime.evaluate", { expression: "navigator.userActivation.isActive", userGesture: false, returnByValue: true })).result.value;
        await info.attach("script-play-activation", { body: JSON.stringify({ isActive: active }), contentType: "application/json" });
        expect(active, "B's frame has no transient activation before the script play").toBe(false);
        await cdp.send("Runtime.evaluate", { expression: "document.querySelector('video').play().catch(() => 0)", userGesture: false });
        await b.waitForTimeout(3_000);
        expect((await sample(fa)).paused, "A stays paused after B's script-only play()").toBe(true);

        await expect(c.page.getByTestId("not-synced")).toBeVisible();
        await info.attach("spreads.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
      } finally {
        await c.context.close();
      }
    } finally {
      await ctxB.close();
    }
  });
});
