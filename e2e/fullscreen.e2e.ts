// OME-597 (M7 W2, set k `ui-m7-desktop` / `ui-m7-band`): full screen with a chat strip. Our wrapper goes full screen
// (picture + strip beside it, ADR 0012: nothing of ours over the player); the strip is the room's chat log, fading, with
// the message field always reachable, and collapses to the input bar. The room (Pixi) is hidden and stops drawing while
// in full screen. Where element full screen is missing (iPhone Safari) the same layout runs as a CSS full-viewport mode
// with a history entry, so Back leaves it. The per-provider checks (same iframe, sync) are provider-fullscreen.e2e.ts;
// the geometry and mode machine are apps/web/test/fullscreen.test.ts.
import type { Browser, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function join(browser: Browser, name: RoomName<"fullscreen">, count = 1, options?: BrowserContextOptions, init?: () => void): Promise<Client[]> {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("fullscreen", name).url,
    count,
    nicknamePrefix: `fs${name}`,
    contextOptions: (i) => (i === 0 ? options : undefined),
    ...(init === undefined ? {} : { setup: async (context, i) => { if (i === 0) await context.addInitScript(init); } }),
  });
  return clients;
}

const box = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
};

const inFullscreen = (page: Page): Promise<boolean> => page.evaluate((sel) => document.fullscreenElement?.matches(sel) === true, site.fsRoot);

/** The room handle's dev hook: is the Pixi room's render loop paused? */
const roomPaused = (page: Page): Promise<unknown> =>
  page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "roomPaused") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
  });

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

test("the strip sits beside the picture with the chat log and field; the room is hidden and paused; leaving puts it all back", async ({ browser }) => {
  const [a, b] = await join(browser, "strip", 2);
  if (!a || !b) throw new Error("need 2 clients");
  const page = a.page;
  const key = page.locator(site.fullscreenToggle);
  await expect(key).toHaveAttribute("aria-label", "Full screen");
  await page.locator(site.chatInput).fill("half a thought");
  await key.click();
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await expect(key).toHaveAttribute("aria-label", "Exit full screen");

  const strip = page.locator(site.fsStrip);
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute("aria-label", "Chat");
  // The log and the field live in the strip, inside the full-screen element; the draft came along.
  await expect(strip.locator(site.chatLog)).toHaveAttribute("data-ageing", "fade");
  await expect(strip.locator(site.chatInput)).toHaveValue("half a thought");
  // Beside the picture, never over it (ADR 0012).
  const tv = await box(page.locator(site.tv));
  const s = await box(strip);
  expect(s.x).toBeGreaterThanOrEqual(tv.x + tv.width);
  const vp = page.viewportSize();
  expect(s.x + s.width).toBeLessThanOrEqual(vp?.width ?? 0);
  expect(tv.width).toBeGreaterThan(560);

  await expect(page.locator(site.roomWindow)).toBeHidden();
  expect(await roomPaused(page)).toBe(true);

  await say(b.page, "hello full screen");
  await expect(strip.locator(site.chatLogLine).last()).toContainText("hello full screen");
  await say(page, "and back");
  await expect(b.page.locator(site.chatLogLine).last()).toContainText("and back");

  await key.click();
  await expect.poll(() => inFullscreen(page)).toBe(false);
  await expect(strip).toBeHidden();
  await expect(page.locator(site.roomWindow)).toBeVisible();
  expect(await roomPaused(page)).toBe(false);
  // The log is the page's again: under the room, settling instead of fading, with every line it had.
  const log = page.locator(site.chatLog);
  await expect(log).toHaveAttribute("data-ageing", "settle");
  await expect(log.locator(site.chatLogLine).last()).toContainText("and back");
  expect(await page.locator(site.fsRoot).locator(site.chatLog).count()).toBe(0);
});

test("collapse to the input bar: the field stays, the picture grows, the show-chat key counts what you missed and is remembered", async ({ browser }) => {
  const [a, b] = await join(browser, "band", 2);
  if (!a || !b) throw new Error("need 2 clients");
  const page = a.page;
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => inFullscreen(page)).toBe(true);
  const toggle = page.locator(site.fsStripToggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute("aria-label", "Collapse chat to the input bar");
  const open = await box(page.locator(site.tv));

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(site.fsStrip).locator(site.chatLog)).toBeHidden();
  await expect(page.locator(site.chatInput)).toBeVisible();
  const band = await box(page.locator(site.tv));
  expect(band.width).toBeGreaterThan(open.width);
  // The band is under the picture, not over it.
  const bar = await box(page.locator(site.fsStrip));
  expect(bar.y).toBeGreaterThanOrEqual(band.y + band.height);

  await say(b.page, "one");
  await say(b.page, "two");
  await expect(toggle).toHaveAttribute("aria-label", "Show chat, 2 new messages");
  await say(page, "typed in the band");
  await expect(b.page.locator(site.chatLogLine).last()).toContainText("typed in the band");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "Collapse chat to the input bar");
  await expect(page.locator(site.fsStrip).locator(site.chatLog)).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Leave and come back: still collapsed.
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => inFullscreen(page)).toBe(false);
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("keyboard: the key enters and keeps focus, F toggles outside text fields, Enter jumps to the field, the browser's exit is followed", async ({ browser }) => {
  const [a] = await join(browser, "keys");
  if (!a) throw new Error("no client");
  const page = a.page;
  const key = page.locator(site.fullscreenToggle);
  await expect(key).toHaveAttribute("aria-keyshortcuts", "F");
  await key.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await expect(key).toBeFocused();

  // Enter on nothing in particular goes to the message field.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Enter");
  await expect(page.locator(site.chatInput)).toBeFocused();
  // In the field, F is a letter.
  await page.keyboard.type("f");
  await expect(page.locator(site.chatInput)).toHaveValue("f");
  expect(await inFullscreen(page)).toBe(true);

  // Esc always leaves: the browser owns it, and an automated key press never reaches the browser's own handling, so do
  // what it does on Esc (the real key is checked headed, docs/research/m7-fullscreen-and-popout.md). The draft stays.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => inFullscreen(page)).toBe(false);
  await expect(page.locator(site.chatInput)).toHaveValue("f");

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("f");
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await page.keyboard.press("f");
  await expect.poll(() => inFullscreen(page)).toBe(false);
});

test("no element full screen (iPhone Safari): a full-viewport page with a history entry; Back and Esc leave it, the room stays", async ({ browser }) => {
  const [a] = await join(browser, "pseudo", 1, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, () => {
    Reflect.deleteProperty(Element.prototype, "requestFullscreen");
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
  });
  if (!a) throw new Error("no client");
  const page = a.page;
  const url = page.url();
  const root = page.locator(site.fsRoot);
  const depth = await page.evaluate(() => history.length);

  await page.locator(site.fullscreenToggle).click();
  await expect(root).toHaveClass(/is-pseudo-fs/);
  expect(await page.evaluate(() => history.length)).toBe(depth + 1);
  const css = await root.evaluate((el) => ({ position: getComputedStyle(el).position, top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height }));
  expect(css.position).toBe("fixed");
  expect(css.top).toBe(0);
  expect(css.height).toBe(844);
  // Portrait: the strip under the picture.
  const tv = await box(page.locator(site.tv));
  expect((await box(page.locator(site.fsStrip))).y).toBeGreaterThanOrEqual(tv.y + tv.height);
  await expect(page.locator(site.roomWindow)).toBeHidden();

  await page.evaluate(() => {
    history.back();
  });
  await expect(root).not.toHaveClass(/is-pseudo-fs/);
  expect(page.url()).toBe(url);
  await expect(page.locator(site.room)).toBeAttached();
  await expect(page.locator(site.roomWindow)).toBeVisible();

  await page.locator(site.fullscreenToggle).click();
  await expect(root).toHaveClass(/is-pseudo-fs/);
  await page.keyboard.press("Escape");
  await expect(root).not.toHaveClass(/is-pseudo-fs/);
  // Our exit popped our own entry: nothing of ours is left in the history.
  expect(await page.evaluate(() => history.length)).toBe(depth + 1);
  expect(await page.evaluate(() => (history.state as unknown) === null || typeof history.state !== "object" || !("omegaFullscreen" in history.state))).toBe(true);
});

test("a phone in portrait: the strip fills the screen under the picture, keys are 44 px to the finger", async ({ browser }) => {
  const [a] = await join(browser, "phone", 1, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (!a) throw new Error("no client");
  const page = a.page;
  await page.locator(site.fullscreenToggle).click();
  await expect(page.locator(site.fsStrip)).toBeVisible();
  const tv = await box(page.locator(site.tv));
  expect(tv.width).toBe(390);
  const strip = await box(page.locator(site.fsStrip));
  expect(strip.y).toBeGreaterThanOrEqual(tv.y + tv.height);
  expect(strip.y + strip.height).toBeCloseTo(844, 0);
  const field = await box(page.locator(site.chatInput));
  expect(field.height).toBeGreaterThanOrEqual(44);
});
