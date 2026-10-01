// Generic tier in the room (OME-292, ADR 0024 §3): the room socket is routed and its snapshots carry a generic embed,
// so this runs beside the lobby suites without sharing anything. Before Load nothing reaches the embed's host;
// after Load there is one iframe with the fixed attributes. The sync controls and volume are gone, "not synced" stays.
import type { Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const HOST = "video.omega-fixture.org";
const EMBED = { provider: "generic", host: HOST, url: `https://${HOST}/embed/42` } as const;

/** Every snapshot shows the generic embed, with no playback (the wire rule for the generic tier). */
async function withGenericEmbed(page: Page): Promise<void> {
  await page.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg: unknown = typeof m === "string" ? JSON.parse(m) : null;
      const room: unknown = typeof msg === "object" && msg !== null && Reflect.get(msg, "type") === "snapshot" ? Reflect.get(msg, "room") : null;
      if (typeof room !== "object" || room === null) {
        ws.send(m);
        return;
      }
      Reflect.set(room, "embed", EMBED);
      Reflect.set(room, "playback", null);
      ws.send(JSON.stringify(msg));
    });
  });
}

test.describe("generic embed card", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("card first with no request to the host; Load gives one fixed sandboxed iframe; no sync controls", async ({ browser }) => {
    const context = await watchCsp(await browser.newContext());
    try {
      await stubExternalNetwork(context);
      const hits: string[] = [];
      // Later routes win over the stub: a tiny page stands in for the third-party embed.
      await context.route(`https://${HOST}/**`, async (route) => {
        hits.push(route.request().url());
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>fixture</title><p>generic fixture</p>" });
      });
      const page = await context.newPage();
      await withGenericEmbed(page);
      await page.goto(ROOM_URL);
      await page.locator(site.nicknameInput).fill("generic-1");
      await page.locator(site.avatarOption).first().click();
      await page.locator(site.joinButton).click();
      await expect(page.locator(site.room)).toBeVisible();

      const card = page.getByTestId("generic-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText(`Video from ${HOST}`);
      await expect(card).toContainText(/not synced/i);
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect(page.getByTestId("not-synced")).toBeVisible();
      await expect(page.getByTestId("generic-hint")).toBeHidden();
      await expect(page.locator(site.playToggle)).toHaveCount(0);
      await expect(page.locator(site.volume)).toBeHidden();
      await expect(page.locator(site.muteToggle)).toBeHidden();
      // Give a stray favicon, preconnect or prefetch time to show up.
      await page.waitForTimeout(500);
      expect(hits).toEqual([]);

      await page.getByTestId("generic-load").click();
      const frame = page.locator(site.sharedVideo);
      await expect(frame).toHaveCount(1);
      await expect(page.locator("iframe")).toHaveCount(1);
      const attrs = await frame.evaluate((f) => Object.fromEntries([...f.attributes].map((a) => [a.name, a.value])));
      expect(attrs).toEqual({
        src: EMBED.url,
        sandbox: "allow-scripts allow-same-origin allow-presentation",
        allow: "fullscreen; autoplay",
        referrerpolicy: "no-referrer",
        title: `Shared video from ${HOST}`,
        "data-testid": "shared-video",
      });
      await expect(page.frameLocator(site.sharedVideo).locator("p")).toHaveText("generic fixture");
      expect(hits).toEqual([EMBED.url]);
      await expect(page.getByTestId("not-synced")).toBeVisible();
      await expect(page.getByTestId("generic-hint")).toHaveText("Blank? This site doesn't allow embedding.");
    } finally {
      await context.close();
    }
  });
});
