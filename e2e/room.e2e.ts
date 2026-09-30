// Multiplayer smoke: several clients join one room with distinct nicknames/avatars.
// M1a has only the default room; unknown room ids 404 on the server by design (OME-5).
import { expect, test } from "./support/csp";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { joinRoom, leaveAll } from "./support/room";

test.describe("room", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("4 clients join and all see each other", async ({ browser }) => {
    const clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${DEFAULT_ROOM_ID}`, count: 4 });
    try {
      for (const c of clients) {
        for (const other of clients) await expect(c.page.getByText(other.nickname)).toBeVisible();
      }
    } finally {
      await leaveAll(clients);
    }
  });
});
