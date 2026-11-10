// OME-2521 (ADR 0057 amendment 1): the unlocked host's page has no <video> of its own; it plays from another host's
// player frame nested inside it (like gogoanime → megaplay). The viewer allows that player host once on the consent
// page, and the room's frame then syncs; a later Unlock syncs straight away. Both hosts are fake https origins served by
// the spec's routes; the e2e build already holds player.omega-fixture.net, so Allow needs no browser prompt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Frame, Page, Route } from "@playwright/test";
import { expect, test } from "./support/extension";
import { PENDING, ROOT, URLS, available } from "./support/apps";
import { testRoom } from "./support/room";
import { joinForToken, postShare } from "./support/share";
import { site } from "./support/selectors";
import { sampleVideo } from "./real/real";

const ROOM = testRoom("provider-generic-nested", "main");
const HOST = "xfo.omega-fixture.net";
const PLAYER = "player.omega-fixture.net";
const EMBED_URL = `https://${HOST}/streaming.html`;
const PLAYER_URL = `https://${PLAYER}/video-frame.html`;
const PAGES = join(ROOT, "e2e/fixtures/pages");
const VIDEO_FRAME = readFileSync(join(PAGES, "video-frame.html"));
const WEBM = readFileSync(join(PAGES, "clip.webm"));
// The unlocked page: only a player-sized frame from another host (and a small one that must not be asked about).
const STREAMING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>streaming</title></head><body style="margin:0">
<iframe src="https://ads.omega-fixture.net/banner.html" width="300" height="60" title="ad"></iframe>
<iframe src="${PLAYER_URL}" width="640" height="360" title="player" allow="autoplay"></iframe></body></html>`;

declare const chrome: { storage: { local: { set(items: Record<string, string>): Promise<void>; get(key: string): Promise<Record<string, unknown>> } } };

async function serveHosts(context: BrowserContext): Promise<void> {
  await context.route((url) => url.hostname.endsWith(".omega-fixture.net"), async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.hostname === HOST && url.pathname === "/streaming.html") return route.fulfill({ contentType: "text/html", body: STREAMING });
    if (url.hostname === PLAYER && url.pathname === "/video-frame.html") return route.fulfill({ contentType: "text/html", body: VIDEO_FRAME });
    if (url.hostname === PLAYER && url.pathname === "/clip.webm") {
      // Range-aware: Chromium's media stack asks for byte ranges.
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
    }
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>ad</title>" });
  });
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

async function playerFrame(page: Page): Promise<Frame> {
  const find = (): Frame | undefined => page.frames().find((f) => !f.isDetached() && f.url() === PLAYER_URL);
  await expect.poll(() => find() !== undefined, { timeout: 15_000 }).toBe(true);
  const f = find();
  if (f === undefined) throw new Error("player frame went away");
  return f;
}

test.describe("generic embed whose video sits in a nested player frame (OME-2521)", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.fixme(!available.extension, PENDING.extension);

  test("Allow on the consent page syncs the player host's frame; the next Unlock syncs without asking", async ({ context, serviceWorker, request }, info) => {
    test.setTimeout(120_000);
    const tag = `${String(info.repeatEachIndex)}${String(info.retry)}`;
    await serviceWorker.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), URLS.web);
    await serveHosts(context);
    const sharer = await joinForToken(ROOM.id, `gnest-sharer-${tag}`);
    try {
      expect((await postShare(request, ROOM.id, sharer.token, EMBED_URL)).status()).toBe(200);
    } finally {
      sharer.close();
    }

    const a = await enterRoom(context, `gnest-a-${tag}`);
    const consentOpened = context.waitForEvent("page", (p) => p.url().includes("consent.html"));
    await a.getByTestId("generic-unlock").click({ timeout: 20_000 });
    const consent = await consentOpened;
    await expect(consent.getByRole("heading")).toHaveText(`Let ${PLAYER} sync in your omega-share room?`);
    await expect(consent.locator("#nested")).toContainText(HOST);
    await consent.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get("nestedHosts"))["nestedHosts"])).toEqual({ [HOST]: [PLAYER] });

    // The consent tab took over 5 s at most here; either way, Unlock again attaches at once (the second-visit path).
    if ((await a.getByTestId("synced").count()) === 0) {
      await a.bringToFront();
      await a.getByTestId("generic-strip-unlock").click({ timeout: 20_000 });
    }
    await expect(a.getByTestId("synced")).toHaveCount(1, { timeout: 20_000 });
    // ADR 0024 amendment 1 (OME-2532): on Chromium the unlocked frame has no sandbox, so anti-sandbox players show.
    await expect(a.locator(site.sharedVideo)).not.toHaveAttribute("sandbox");
    const player = await playerFrame(a);
    await info.attach("nested-synced", { body: await a.screenshot(), contentType: "image/png" });

    // The room drives the nested player's <video>: a share starts playing; pause, then play again (the shared 3-2-1).
    const paused = async (): Promise<boolean | undefined> => (await sampleVideo(player))?.paused;
    await expect.poll(paused, { timeout: 15_000 }).toBe(false);
    await a.locator(site.playToggle).click();
    await expect.poll(paused, { timeout: 15_000 }).toBe(true);
    await a.locator(site.playToggle).click();
    await expect.poll(paused, { timeout: 15_000 }).toBe(false);

    // Only the player-sized frame's host was asked about, once.
    expect(context.pages().filter((p) => p.url().includes("consent.html"))).toHaveLength(0);
  });
});
