// TV frame (OME-94/98): at a 360 px phone viewport the bezel and shelf drop their side ink (.compact), nothing scrolls
// sideways, nothing of ours covers the player, and the player keeps YouTube's minimum size. At 1280 px the full frame shows.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { joinRoom, leaveAll } from "./support/room";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const tv = (page: Page) => page.locator(".tv");
const controls = (page: Page) => page.locator(".controls");

test.describe("TV frame", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("360 px: compact bezel and shelf, no sideways scroll, player uncovered and ≥ 356×200", async ({ browser }) => {
    const [client] = await joinRoom(browser, { roomUrl: ROOM_URL, count: 1, nicknamePrefix: "tv360" });
    if (!client) throw new Error("no client");
    const { page } = client;
    try {
      await page.setViewportSize({ width: 360, height: 780 });
      await expect(tv(page)).toHaveClass(/(^|\s)ui-tv-frame(\s|$)/);
      await expect(tv(page)).toHaveClass(/(^|\s)compact(\s|$)/);
      await expect(controls(page)).toHaveClass(/(^|\s)ui-tv-shelf(\s|$)/);
      await expect(controls(page)).toHaveClass(/(^|\s)compact(\s|$)/);

      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(overflow.scroll, `scrollWidth ${String(overflow.scroll)} > clientWidth ${String(overflow.client)}`).toBeLessThanOrEqual(overflow.client);

      // Viewport coords after scrolling the player into view: elementFromPoint only sees what's on screen.
      const player = await tv(page).evaluate((el) => {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        // Corners 1 px in (the far edges themselves belong to the next box), and the centre.
        const points = {
          "top-left": [r.left + 1, r.top + 1],
          "top-right": [r.right - 1, r.top + 1],
          "bottom-left": [r.left + 1, r.bottom - 1],
          "bottom-right": [r.right - 1, r.bottom - 1],
          centre: [r.left + r.width / 2, r.top + r.height / 2],
        } as const;
        const hits = Object.entries(points).map(([name, [x, y]]) => {
          const t = document.elementFromPoint(x, y);
          return { name, inside: t !== null && el.contains(t), hit: t === null ? "nothing" : `${t.tagName}.${t.className}` };
        });
        return { w: r.width, h: r.height, hits };
      });
      expect(player.w).toBeGreaterThanOrEqual(356);
      expect(player.h).toBeGreaterThanOrEqual(200);
      for (const { name, inside, hit } of player.hits) expect(inside, `elementFromPoint at ${name} hit ${hit}, not .tv`).toBe(true);
    } finally {
      await leaveAll([client]);
    }
  });

  test("1280 px: full frame, no .compact", async ({ browser }) => {
    const [client] = await joinRoom(browser, { roomUrl: ROOM_URL, count: 1, nicknamePrefix: "tv1280" });
    if (!client) throw new Error("no client");
    const { page } = client;
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(tv(page)).toHaveClass(/(^|\s)ui-tv-frame(\s|$)/);
      await expect(controls(page)).toHaveClass(/(^|\s)ui-tv-shelf(\s|$)/);
      await expect(tv(page)).not.toHaveClass(/(^|\s)compact(\s|$)/);
      await expect(controls(page)).not.toHaveClass(/(^|\s)compact(\s|$)/);
    } finally {
      await leaveAll([client]);
    }
  });
});
