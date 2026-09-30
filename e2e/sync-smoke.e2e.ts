// M1b smoke (OME-89): the shared transport in one context drives the player in another, through the real server,
// the real clock sync, sync loop and YouTube adapter, against the fake iframe_api (OME-85). QA's full sync specs are OME-90.
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { EMBED_URL } from "./support/network";
import { joinRoom, leaveAll } from "./support/room";
import { site } from "./support/selectors";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const SHARE_URL = `${URLS.server}/rooms/${DEFAULT_ROOM_ID}/share`;
/** YT.PlayerState */
const PLAYING = 1;
const PAUSED = 2;

const fakeState = (page: Page) => page.evaluate(() => window.__fakeYt?.state ?? null);

async function share(request: APIRequestContext): Promise<void> {
  // The per-IP share limiter (5 burst, 1 per 3 s) is shared with other specs; wait out a 429.
  await expect
    .poll(async () => (await request.post(SHARE_URL, { data: { url: EMBED_URL } })).status(), { timeout: 15_000, intervals: [1_000] })
    .toBe(200);
}

test.describe("M1b sync smoke", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("pause and play in context A → context B pauses and plays; B sees who did it", async ({ browser, request }) => {
    const clients = await joinRoom(browser, { roomUrl: ROOM_URL, count: 2, nicknamePrefix: "smoke" });
    const [a, b] = clients;
    if (!a || !b) throw new Error("need two clients");
    try {
      await share(request);
      for (const c of [a, b]) {
        await expect(c.page.locator(site.sharedVideo)).toBeVisible();
        await expect.poll(() => fakeState(c.page), { timeout: 10_000 }).toBe(PLAYING);
      }
      const toggle = a.page.locator(site.playToggle);
      await expect(toggle).toHaveAttribute("aria-label", "Pause for everyone");

      await toggle.click();
      await expect.poll(() => fakeState(b.page), { timeout: 5_000 }).toBe(PAUSED);
      await expect(b.page.locator(site.systemLine).last()).toHaveText(`${a.nickname} paused`);
      await expect(b.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Play for everyone");

      await a.page.locator(site.playToggle).click();
      await expect.poll(() => fakeState(b.page), { timeout: 5_000 }).toBe(PLAYING);
      await expect(b.page.locator(site.systemLine).last()).toHaveText(`${a.nickname} pressed play`);

      // Personal volume is local: A's mute changes nothing for B.
      await a.page.locator(site.muteToggle).click();
      await expect(a.page.locator(site.muteToggle)).toHaveAttribute("aria-pressed", "true");
      await expect(b.page.locator(site.muteToggle)).toHaveAttribute("aria-pressed", "false");
      expect(await fakeState(b.page)).toBe(PLAYING);
    } finally {
      await leaveAll(clients);
    }
  });
});
