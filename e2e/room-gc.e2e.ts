// Room GC (OME-904, ADR 0028 §2): a room nobody has been in for 20 min is deleted, and its link then shows the M9
// "Room not found" screen (OME-768), the same as for an id that never existed. The seed (fixtures/seed-rooms.ts)
// stores GC_IDLE_ROOM_ID idle for 21 min, so the e2e server's boot sweep has deleted it before any test runs.
import type { BrowserContext } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { GC_IDLE_ROOM_ID } from "./support/owned-rooms";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let context: BrowserContext | null = null;
test.afterEach(async () => {
  await context?.close();
  context = null;
});

test("a room deleted for being idle 20 min: the join path answers 404 and its link shows Room not found", async ({ browser, request }) => {
  // The join path doesn't know it (GET /rooms can't tell: it lists only the first MAX_LISTED_ROOMS).
  expect((await request.get(`${URLS.server}/rooms/${GC_IDLE_ROOM_ID}/ws`, { headers: { upgrade: "websocket" } })).status()).toBe(404);

  context = await watchCsp(await browser.newContext());
  await stubExternalNetwork(context);
  const page = await context.newPage();
  await page.goto(`${URLS.web}/r/${GC_IDLE_ROOM_ID}`);
  await page.locator(site.nicknameInput).fill("visitor");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.notFound)).toBeVisible();
  await expect(page.locator(site.room)).toBeHidden();
});
