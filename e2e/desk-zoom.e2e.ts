// Wheel zoom on a computer (OME-1490): the wheel over the room zooms it around the pointer, a tile click still walks
// to the cell under the pointer at that zoom, and the Fit key goes back to the whole room.
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { TAG_OFFSET_Y, cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Cell (x, y)'s centre in page px, wherever the stage is scaled and zoomed to. */
async function cellOnPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(site.walkFloor).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const p = cellCenter(x, y);
  return { x: box.left + p.x * box.k, y: box.top + p.y * box.k };
}

/** The floor's on-screen scale (its CSS px per stage px). */
const scaleOf = (page: Page): Promise<number> => page.locator(site.walkFloor).evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);

test("the wheel zooms the room around the pointer, a click still walks to the tile under it, the Fit key fits it again", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("desk-zoom", "main").url, count: 1, nicknamePrefix: "wheel" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  const { page } = a;
  await page.waitForTimeout(3000); // walked in from the door
  const fit = await scaleOf(page);
  // Over the chat, the wheel is the chat's.
  const chat = await page.locator(site.chatLog).boundingBox();
  if (chat !== null) {
    await page.mouse.move(chat.x + chat.width / 2, chat.y + chat.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100);
    expect(await scaleOf(page)).toBeCloseTo(fit, 5);
  }
  // Over the room, wheel up zooms in, and the point under the pointer stays put.
  const before = await cellOnPage(page, 3, 8);
  await page.mouse.move(before.x, before.y);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(50);
  }
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(fit * 1.5);
  const after = await cellOnPage(page, 3, 8);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Zoomed in, a click on a tile walks to that tile.
  const cell = await cellOnPage(page, 4, 8);
  await page.mouse.click(cell.x, cell.y);
  const p = cellCenter(4, 8);
  const rest = `${String(Math.round(p.x))}px ${String(Math.round(p.y + TAG_OFFSET_Y))}px`;
  await expect.poll(() => page.locator(site.nicknameTag).filter({ hasText: "wheel-1" }).evaluate((el) => (el as HTMLElement).style.translate), { timeout: 10_000 }).toBe(rest);
  // It's this viewer's alone, and the Fit key goes back to the whole room.
  expect(Number(await page.evaluate(() => localStorage.getItem("omega.roomZoomDesk")))).toBeGreaterThan(1.5);
  await page.getByTestId("room-zoom-fit").click();
  await expect(page.getByTestId("room-zoom-fit")).toBeHidden();
  await expect.poll(() => scaleOf(page)).toBeCloseTo(fit, 5);
});
