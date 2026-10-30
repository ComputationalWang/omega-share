// The 180° view swap (OME-1961): in the Dank Dungeon (two rooms split by a partition with a doorway) a viewer whose
// avatar is on the bedroom side sees the room from the north; everyone else's view is untouched.
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Clicks the floor point where cell (x, y) is drawn now: the north view is the south view turned 180° (stage 960×760 about its centre). */
async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const north = (await page.locator(site.room).getAttribute("data-view")) === "north";
  const floor = page.locator(site.walkFloor);
  const box = await floor.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const c = cellCenter(x, y);
  const p = north ? { x: 960 - c.x, y: 760 - c.y } : c;
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

const stage = (page: Page) => page.locator(site.room);

test("walking into the bedroom turns my view north, and only mine; walking back turns it south", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("view-swap", "main").url, count: 2, nicknamePrefix: "turner" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await expect(stage(a.page)).toHaveAttribute("data-view", "south");
  await expect(stage(b.page)).toHaveAttribute("data-view", "south");

  await clickCell(a.page, 2, 2);
  await expect(stage(a.page)).toHaveAttribute("data-view", "north", { timeout: 15_000 });
  await expect(stage(b.page)).toHaveAttribute("data-view", "south");

  await clickCell(a.page, 3, 8);
  await expect(stage(a.page)).toHaveAttribute("data-view", "south", { timeout: 15_000 });
  await expect(stage(b.page)).toHaveAttribute("data-view", "south");
});
