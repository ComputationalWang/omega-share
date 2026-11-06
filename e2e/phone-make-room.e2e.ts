// Phone "Make a room" (OME-2266, audit OME-2260 item 5): on a Pixel 7 held upright the preset strip showed ~2.3 cards with
// no cue that more sat to the side, Create room was far below, and the landing's way in was its smallest control.
import type { BrowserContextOptions } from "@playwright/test";
import { ROOM_PRESET_IDS } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test, watchCsp } from "./support/csp";
import { openDirectory } from "./support/directory";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const PIXEL7: BrowserContextOptions = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };

test("412×915 touch: Find or create a room is a full-width outlined button, as tall as Enter lobby", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext(PIXEL7));
  const page = await context.newPage();
  await page.goto(URLS.web);
  const find = page.locator(site.findRoom);
  await expect(find).toBeVisible();
  const enter = await page.locator(site.joinButton).boundingBox();
  const box = await find.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(enter?.height ?? 48);
  expect(box?.width ?? 0).toBeCloseTo(enter?.width ?? 0, 0);
  const style = await find.evaluate((el) => { const s = getComputedStyle(el); return { border: Number.parseFloat(s.borderTopWidth), underline: s.textDecorationLine }; });
  expect(style.border).toBeGreaterThanOrEqual(1);
  expect(style.underline).toBe("none");
  await context.close();
});

test("412×915 touch: Create room sits within one screen of the page's heading, and the preset strip shows dots that follow it", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext(PIXEL7));
  const page = await context.newPage();
  await page.goto(URLS.web);
  await openDirectory(page, "Pixel");
  const form = page.locator(site.createRoomForm);
  const top = await page.locator("#directory-title").evaluate((el) => el.getBoundingClientRect().top + scrollY);
  const bottom = await page.locator(site.createRoomSubmit).evaluate((el) => el.getBoundingClientRect().bottom + scrollY);
  expect(bottom - top).toBeLessThanOrEqual(915);

  // The strip scrolls sideways; a dot for each preset, the first one lit, and the lit one follows the scroll.
  const list = form.locator(".preset-list");
  expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
  const dots = form.locator(".preset-dots > *");
  await expect(dots).toHaveCount(ROOM_PRESET_IDS.length);
  await expect(dots.first()).toHaveClass(/is-on/);
  await list.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(dots.last()).toHaveClass(/is-on/);
  await expect(form.locator(".preset-dots > .is-on")).toHaveCount(1);
  await context.close();
});
