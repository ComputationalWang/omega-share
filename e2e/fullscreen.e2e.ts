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
  // Out of sight, not out of the accessibility tree: the log is still the polite live region screen readers hear.
  const hiddenLog = page.locator(site.fsStrip).locator(site.chatLog);
  await expect(page.getByRole("log", { name: "Chat messages" })).toBeAttached();
  expect(await hiddenLog.evaluate((el) => [getComputedStyle(el).display !== "none", el.getBoundingClientRect().width <= 1, el.tabIndex])).toEqual([true, true, -1]);
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
  expect(await hiddenLog.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(100);
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

  // A person presses F a moment later: right as Chromium finishes leaving, a new request can be refused (and the
  // refusal falls back to the CSS mode, which is not element full screen).
  await page.waitForTimeout(500);
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

test("entering from a seat (keyboard), focus lands on the exit key; leaving gives it back to the seat", async ({ browser }) => {
  const [a] = await join(browser, "seatfocus");
  if (!a) throw new Error("no client");
  const page = a.page;
  const seat = page.locator(site.seat).first();
  await seat.focus();
  await page.keyboard.press("f");
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await expect(page.locator(site.fullscreenToggle)).toBeFocused();
  await page.keyboard.press("f");
  await expect.poll(() => inFullscreen(page)).toBe(false);
  await expect(seat).toBeFocused();
});

// OME-628 (QA): in the CSS mode the page behind the wrapper is out of reach (as in element full screen), and a reload
// in the middle of it doesn't leave the next one stuck.
test("CSS mode: Tab stays inside the wrapper, and after a reload it still enters and leaves", async ({ browser }) => {
  const [a] = await join(browser, "pseudotab", 1, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, () => {
    Reflect.deleteProperty(Element.prototype, "requestFullscreen");
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
  });
  if (!a) throw new Error("no client");
  const page = a.page;
  const root = page.locator(site.fsRoot);
  await page.locator(site.fullscreenToggle).click();
  await expect(root).toHaveClass(/is-pseudo-fs/);
  await page.locator(site.chatSend).focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate((sel) => {
      const active = document.activeElement;
      return active === null || active === document.body || document.querySelector(sel)?.contains(active) === true;
    }, site.fsRoot);
    expect(inside, `Tab ${String(i + 1)}`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(root).not.toHaveClass(/is-pseudo-fs/);
  // Behind it, the page is reachable again.
  expect(await page.locator(site.inviteCopy).evaluate((el) => el.closest("[inert]") === null)).toBe(true);

  // Reload in the middle of the CSS mode, then go in and out again.
  await page.locator(site.fullscreenToggle).click();
  await expect(root).toHaveClass(/is-pseudo-fs/);
  // A reload goes straight back in with this tab's session (ADR 0043): no Enter form.
  await page.reload();
  await page.locator(site.room).waitFor();
  await page.locator(site.fullscreenToggle).click();
  await expect(root).toHaveClass(/is-pseudo-fs/);
  await page.keyboard.press("Escape");
  await expect(root).not.toHaveClass(/is-pseudo-fs/);
  await page.locator(site.fullscreenToggle).click();
  await expect(root).toHaveClass(/is-pseudo-fs/);
  await page.locator(site.fullscreenToggle).click();
  await expect(root).not.toHaveClass(/is-pseudo-fs/);
});

interface Box { x: number; y: number; width: number; height: number }
const disjoint = (p: Box, q: Box): boolean => p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;

// OME-1491 / OME-1593: hide chat. The strip and the shelf go, the picture takes the screen (the largest 16:9, centred),
// others' lines show for ~6 s where the screen leaves room beside or under it.
async function hideChatFlow(page: Page, other: Page, enter: () => Promise<void>): Promise<void> {
  const root = page.locator(site.fsRoot);
  await enter();
  const toggle = page.locator(site.fsChatToggle);
  await expect(toggle).toHaveAttribute("aria-label", "Hide chat");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-label", "Show chat");
  await expect(toggle).toBeVisible();
  await expect(page.locator(site.fsStrip)).toBeHidden();
  await expect(page.locator(site.chatInput)).toBeHidden();
  await expect(root.locator(".ui-tv-shelf")).toBeHidden();
  // Centred, as big as it gets; nothing of ours over the player (ADR 0012), the handle included.
  const tv = await box(page.locator(site.tv));
  const r = await box(root);
  expect(Math.abs(tv.x - r.x - (r.x + r.width - tv.x - tv.width))).toBeLessThanOrEqual(1);
  // Held sideways the picture keeps the bottom 8 px free for the peek (OME-1668), so it may sit that much high.
  expect(Math.abs(tv.y - r.y - (r.y + r.height - tv.y - tv.height))).toBeLessThanOrEqual(9);
  expect(Math.max(tv.width / r.width, tv.height / r.height)).toBeGreaterThan(0.9);
  expect(disjoint(await box(toggle), tv)).toBe(true);
  const bubbles = page.locator(site.fsBubbles);
  await expect(bubbles).toHaveAttribute("aria-live", "polite");
  expect(await bubbles.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  const col = await bubbles.boundingBox();
  // A 16:9 screen or a phone held sideways leaves no room for them (OME-1593): the lines stay in the chat.
  if (col === null || col.width < 100) return;
  expect(disjoint(col, tv)).toBe(true);
  await say(other, "seen as a bubble");
  const bubble = bubbles.getByText("seen as a bubble");
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveCount(0, { timeout: 9000 });
}

test("hide chat in full screen: strip and shelf go, a line shows as a bubble and fades, C brings the chat back, the choice is remembered", async ({ browser }) => {
  const [a, b] = await join(browser, "hidechat", 2);
  if (!a || !b) throw new Error("need 2 clients");
  const page = a.page;
  await hideChatFlow(page, b.page, async () => {
    await page.locator(site.fullscreenToggle).click();
    await expect.poll(() => inFullscreen(page)).toBe(true);
  });
  await page.keyboard.press("c");
  await expect(page.locator(site.fsStrip)).toBeVisible();
  await expect(page.locator(site.fsChatToggle)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("c");
  await expect(page.locator(site.fsStrip)).toBeHidden();
  await page.keyboard.press("f");
  await expect.poll(() => inFullscreen(page)).toBe(false);
  // Leaving restores the normal layout; the next full screen starts hidden again.
  await expect(page.locator(site.chatInput)).toBeVisible();
  await expect(page.locator(site.roomWindow)).toBeVisible();
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await expect(page.locator(site.fsStrip)).toBeHidden();
  await expect(page.locator(site.fsChatToggle)).toHaveAttribute("aria-expanded", "false");
});

test("hide chat in the CSS mode on a phone held sideways", async ({ browser }) => {
  const [a, b] = await join(browser, "hidepseudo", 2, { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, () => {
    Reflect.deleteProperty(Element.prototype, "requestFullscreen");
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
  });
  if (!a || !b) throw new Error("need 2 clients");
  const page = a.page;
  const root = page.locator(site.fsRoot);
  await hideChatFlow(page, b.page, async () => {
    await page.locator(site.fullscreenToggle).click();
    await expect(root).toHaveClass(/is-pseudo-fs/);
  });
  await page.locator(site.fsChatToggle).click();
  await expect(page.locator(site.fsStrip)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(root).not.toHaveClass(/is-pseudo-fs/);
});

/**
 * Inside the viewport, not covered, and 44×44 to the finger (OME-1593): the key's own box or its touch hit area (the
 * chrome's transparent ::before, assets/ui/reference.css) answers a tap at its centre and 21 px either way.
 */
async function tappable(page: Page, l: Locator): Promise<void> {
  await expect(l).toBeVisible();
  const b = await box(l);
  const vp = page.viewportSize();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const id = await l.getAttribute("data-testid");
  for (const [x, y] of [[cx, cy], [cx - 21, cy - 21], [cx + 21, cy - 21], [cx - 21, cy + 21], [cx + 21, cy + 21]] as const) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(vp?.width ?? 0);
    expect(y).toBeLessThanOrEqual(vp?.height ?? 0);
    const hit = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.closest("button")?.dataset["testid"] ?? null, { x, y });
    expect(hit, `tap at ${String(x)},${String(y)}`).toBe(id);
  }
}

test("a phone in portrait: the full-screen key is tappable in the room and in full screen", async ({ browser }) => {
  const [a] = await join(browser, "portraitkey", 1, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (!a) throw new Error("no client");
  const page = a.page;
  const key = page.locator(site.fullscreenToggle);
  await tappable(page, key);
  await key.click();
  await expect(page.locator(site.fsStrip)).toBeVisible();
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await tappable(page, key);
});

test("a phone in portrait: the handle on the strip's top edge hides the chat, then brings it back from the screen's bottom edge", async ({ browser }) => {
  const [a, b] = await join(browser, "handle", 2, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (!a || !b) throw new Error("need 2 clients");
  const page = a.page;
  const handle = page.locator(site.fsChatToggle);
  await hideChatFlow(page, b.page, async () => {
    await page.locator(site.fullscreenToggle).click();
    await expect(page.locator(site.fsStrip)).toBeVisible();
    await page.evaluate(() => { window.scrollTo(0, 0); });
    const s = await box(page.locator(site.fsStrip));
    const t = await box(handle);
    expect(Math.abs(t.x + t.width / 2 - (s.x + s.width / 2))).toBeLessThanOrEqual(1);
    expect(t.y).toBeCloseTo(s.y, 0);
    await tappable(page, handle);
  });
  // At the screen's bottom edge now; the keyboard reaches it too.
  const t = await box(handle);
  expect(t.y + t.height).toBeCloseTo(844, 0);
  expect(Math.abs(t.x + t.width / 2 - 195)).toBeLessThanOrEqual(1);
  await tappable(page, handle);
  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(site.fsStrip)).toBeVisible();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
});

// OME-1668 (board OME-1664): with nothing remembered, full screen hides the chat; the pointer at the bottom edge brings
// it back and it goes ~2 s after the pointer leaves; Enter brings it back with the field focused, and a draft holds it.
test("full screen hides the chat by default; the bottom edge and Enter bring it back; a draft keeps it", async ({ browser }) => {
  const [a] = await join(browser, "peek", 1, undefined, () => {
    localStorage.removeItem("omega.fsChatHidden");
  });
  if (!a) throw new Error("no client");
  const page = a.page;
  const strip = page.locator(site.fsStrip);
  const input = page.locator(site.chatInput);
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await expect(strip).toBeHidden();
  // The picture keeps the screen's bottom rows free: the bottom edge is ours, under the picture too.
  const r = await box(page.locator(site.fsRoot));
  const tv = await box(page.locator(site.tv));
  expect(r.y + r.height - (tv.y + tv.height)).toBeGreaterThanOrEqual(8);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height - 2);
  await expect(strip).toBeVisible();
  await expect(input).toBeVisible();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 3);
  await expect(strip).toBeHidden({ timeout: 5000 });
  await expect(input).toBeHidden();
  // QA OME-1754: a real provider's iframe swallows the pointer's events, the leave too. With no event after the peek,
  // the chat still goes ~2 s after the last one.
  await page.mouse.move(r.x + r.width / 2, r.y + r.height - 2);
  await expect(strip).toBeVisible();
  await expect(strip).toBeHidden({ timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(input).toBeFocused();
  await page.keyboard.type("a draft");
  await input.evaluate((el) => { if (el instanceof HTMLElement) el.blur(); });
  await page.waitForTimeout(2500);
  await expect(strip).toBeVisible();
  await input.fill("");
  await input.evaluate((el) => { if (el instanceof HTMLElement) el.blur(); });
  await expect(strip).toBeHidden({ timeout: 5000 });
});
