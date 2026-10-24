// Tablet portrait (OME-1802, design OME-1799 §2 "medium", mockup m5): the phone's stack and dock at tablet size. The TV
// and the chat composer are both on the first screen, the room is a window at 1× that shows my avatar after joining and
// after sitting, and every control is ≥ 44×44 on-screen px (the a11y sweep judges that at these viewports too).
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const tablet = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

let clients: Client[] = [];
let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  await Promise.all(contexts.map((c) => c.close()));
  clients = [];
  contexts = [];
});

async function one(browser: Browser, name: "t768" | "t1024", options: BrowserContextOptions): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("tablet-layout", name).url, count: 1, nicknamePrefix: `tab${name}`, contextOptions: () => options });
  const c = clients[0];
  if (c === undefined) throw new Error("no client");
  return c.page;
}

const box = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
};

/** `inner` lies whole inside `outer`, half a pixel to spare. */
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): boolean =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

for (const [name, w, h] of [["t768", 768, 1024], ["t1024", 1024, 1366]] as const) {
  test(`${String(w)}×${String(h)} touch: TV and composer on the first screen, my avatar in the room window after joining and after sitting`, async ({ browser }) => {
    const page = await one(browser, name, tablet(w, h));
    const screen = { x: 0, y: 0, width: w, height: h };
    const win = page.locator(site.roomWindow);
    await expect(win).toBeVisible();

    // No page scroll: the TV and the composer are both in view, the composer under the room window.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(h);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(inside(await box(page.locator(site.tv)), screen), "TV in view").toBe(true);
    const input = await box(page.locator(site.chatInput));
    expect(inside(input, screen), "composer in view").toBe(true);
    expect(input.height, "composer ≥ 44 px").toBeGreaterThanOrEqual(43.5);

    // My avatar's tag (it hangs under the feet) is inside the room window, at rest and once I sit.
    const mine = page.locator(`${site.nicknameTag}.self`);
    await expect.poll(async () => inside(await box(mine), await box(win)), "my avatar in the window after joining").toBe(true);
    const seat = page.locator(`${site.seat}[data-occupied="false"]:not([inert])`).first();
    await seat.tap();
    await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
    await expect.poll(async () => inside(await box(mine), await box(win)), "my avatar in the window after sitting").toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
}
