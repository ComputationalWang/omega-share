// AGPL-3.0 §13 source offer (OME-272): a footer link to the public repo on the landing page and in the room.
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/csp";
import { joinRoom, leaveAll } from "./support/room";
import { site } from "./support/selectors";

const REPO = "https://github.com/ComputationalWang/omega-share";

test.describe("source link", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("landing page offers the source in a new tab", async ({ page }) => {
    await page.goto(`${URLS.web}/r/${DEFAULT_ROOM_ID}`);
    const link = page.locator(site.sourceLink);
    await expect(link).toBeVisible();
    await expect(link).toHaveText("Source");
    await expect(link).toHaveAttribute("href", REPO);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /^(?=.*\bnoopener\b)(?=.*\bnoreferrer\b)/);
  });

  test("in the room at 1280x720 it stays clear of the stage", async ({ browser }) => {
    const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 1, nicknamePrefix: "src" });
    try {
      const page = clients[0]?.page;
      if (page === undefined) throw new Error("no client");
      await page.setViewportSize({ width: 1280, height: 720 });
      const link = page.locator(site.sourceLink);
      await expect(link).toBeVisible();
      const stage = await page.locator(site.room).boundingBox();
      const box = await link.boundingBox();
      if (stage === null || box === null) throw new Error("no layout");
      const overlaps = box.x < stage.x + stage.width && stage.x < box.x + box.width && box.y < stage.y + stage.height && stage.y < box.y + box.height;
      expect(overlaps).toBe(false);
    } finally {
      await leaveAll(clients);
    }
  });
});
