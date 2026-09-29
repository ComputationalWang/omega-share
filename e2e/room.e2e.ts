// Multiplayer smoke: several clients join one room with distinct nicknames/avatars.
import { expect, test } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { joinRoom, leaveAll } from "./support/room";

test.describe("room", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("4 clients join and all see each other", async ({ browser }) => {
    const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/e2e-smoke`, count: 4 });
    try {
      for (const c of clients) {
        for (const other of clients) await expect(c.page.getByText(other.nickname)).toBeVisible();
      }
    } finally {
      await leaveAll(clients);
    }
  });
});
