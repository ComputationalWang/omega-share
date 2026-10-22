// The desktop wide layout (OME-642, M7 W7). At ≥ 1024 px wide (landscape) the room page is two columns: the TV, its
// shelf and the room on the left, the chat (log, field) and Up next in a full-height column on the right, so at
// 1280×720 and up nothing you need while watching is below the fold. The volume pod sits in the TV's shelf, right under
// the picture, on every layout. Enter (nothing that takes Enter focused) jumps to the chat field; Esc hands the keys
// back. The pure geometry is apps/web/test/wide-layout.test.ts; the key decision is apps/web/test/chat-enter.test.ts.
import type { Browser, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { providerCase, shareProvider, waitProviderPlaying } from "../perf/providers";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const DESKTOP = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height } });
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function one(browser: Browser, name: RoomName<"wide">, options: BrowserContextOptions): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("wide", name).url, count: 1, nicknamePrefix: `wd${name}`, contextOptions: () => options });
  const c = clients[0];
  if (c === undefined) throw new Error("no client");
  await expect(c.page.locator(site.chatInput)).toBeVisible();
  return c.page;
}

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}

/** Wholly inside the viewport, with the page not scrolled. */
async function inView(page: Page, l: Locator): Promise<void> {
  const b = await box(l);
  const vp = page.viewportSize();
  if (vp === null) throw new Error("no viewport");
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
}

async function volumeUnderPicture(page: Page): Promise<void> {
  const tv = await box(page.locator(site.tv));
  const pod = await box(page.locator(".ui-volume"));
  // The pod's top edge within 16 px of the video's bottom edge, and not over the picture (ADR 0012).
  expect(pod.y).toBeGreaterThanOrEqual(tv.y + tv.height);
  expect(pod.y - (tv.y + tv.height)).toBeLessThanOrEqual(16);
  // In the same bar as the shared transport.
  const play = await box(page.locator(site.playToggle));
  expect(Math.abs(play.y + play.height / 2 - (pod.y + pod.height / 2))).toBeLessThanOrEqual(8);
}

for (const [name, w, h] of [["w1280", 1280, 720], ["w1920", 1920, 1080], ["w2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: the chat is a full-height column beside the room; everything you need is in view, unscrolled`, async ({ browser }) => {
    const page = await one(browser, name, DESKTOP(w, h));
    await page.locator(site.chatInput).fill("hello from the side");
    await page.locator(site.chatInput).press("Enter");
    const latest = page.locator(site.chatLogLine).last();
    await expect(latest).toContainText("hello from the side");

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    for (const l of [site.tv, site.playToggle, site.muteToggle, site.roomWindow, site.chatInput, site.chatSend, site.queuePanel]) await inView(page, page.locator(l));
    await inView(page, latest);
    // The page itself doesn't scroll.
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(h);

    // Two columns: the chat right of the room, running (nearly) the window's height.
    const room = await box(page.locator(site.roomWindow));
    const log = await box(page.locator(site.chatLog));
    const input = await box(page.locator(site.chatInput));
    expect(log.x).toBeGreaterThanOrEqual(room.x + room.width);
    expect(input.x).toBeGreaterThanOrEqual(room.x + room.width);
    expect(input.y + input.height).toBeGreaterThan(h - 120);
    // The chat log is still the polite live region.
    await expect(page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
    // The room is a fair size: the canvas isn't squeezed to a sliver.
    expect(room.width).toBeGreaterThanOrEqual(430);

    await volumeUnderPicture(page);
    await expect(page.locator(site.chatInput)).toHaveAttribute("placeholder", "Press Enter to chat");
  });
}

/** Every visible key in the room's chrome (not the stage's seats and tags, not the site footer), with its size. */
const keys = (page: Page): Promise<{ name: string; w: number; h: number }[]> =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main summary, main [role=button]")]
    .filter((e) => e.closest(".stage-clip") === null && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 1 && r.height > 1)
    .map(({ e, r }) => ({ name: e.getAttribute("data-testid") ?? e.getAttribute("aria-label") ?? e.textContent.trim(), w: r.width, h: r.height })));

// OME-1667 (board): "Scalings on 2k and buttons need to be bigger." From 1920 px wide every key is at least 40×40, and
// at 2560×1440 the chrome is twice 1280's: the chat column, the shelf and the room fill the screen.
for (const [name, w, h] of [["w1920", 1920, 1080], ["w2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: every key in the room's chrome is at least 40×40`, async ({ browser }) => {
    const page = await one(browser, name, DESKTOP(w, h));
    const found = await keys(page);
    expect(found.map((k) => k.name)).toEqual(expect.arrayContaining(["play-toggle", "mute-toggle", "fullscreen-toggle", "chat-send", "chat-popout", "emote-key", "room-popout", "help-key"]));
    expect(found.filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// OME-1748: the moments strip's markers (OME-1628) are keys too: 16×14 zoomed, they were 24×21 at 1920 and 32×28 at
// 2560. At least 40×40 from 1920, 44×44 to the finger, and clear of the shelf above them.
for (const [name, opts, min] of [["mo1920", DESKTOP(1920, 1080), 40], ["mo2560", DESKTOP(2560, 1440), 40], ["mophone", PHONE, 44]] as const) {
  test(`${name}: a moments marker is at least ${String(min)}×${String(min)} and below the shelf`, async ({ browser, request }) => {
    const room = testRoom("wide", name);
    await shareVideo(request, room.id);
    const page = await one(browser, name, opts);
    await waitPlaying(clients);
    await page.getByTestId("reaction-bar").getByRole("button", { name: "Heart" }).click();
    const pip = page.getByTestId("moments-pip").first();
    await expect(pip).toBeVisible();
    const p = await box(pip);
    expect(p.width).toBeGreaterThanOrEqual(min - 0.5);
    expect(p.height).toBeGreaterThanOrEqual(min - 0.5);
    const play = await box(page.locator(site.playToggle));
    expect(p.y).toBeGreaterThanOrEqual(play.y + play.height);
    if (min === 40) expect((await keys(page)).filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// QA OME-1696: People open narrowed the TV and the shelf stepped down to 27 px keys at 1920×1080; the People panel's
// own keys were 25 px tall.
for (const [name, w, h] of [["people1920", 1920, 1080], ["people2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)} with People open: every key in the room's chrome is still at least 40×40`, async ({ browser }) => {
    const page = await one(browser, name, DESKTOP(w, h));
    await page.locator(site.peopleKey).click();
    await expect(page.locator(site.peoplePanel)).toBeVisible();
    const found = await keys(page);
    expect(found.map((k) => k.name)).toEqual(expect.arrayContaining(["play-toggle", "mute-toggle", "fullscreen-toggle", "people-key"]));
    expect(found.filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// QA OME-1696: a Twitch VOD's shelf (the quality key, a 1:00:00 time) left its seek bar 12–16 px wide at 1920 and 2560;
// it was 177 px at 1280×720. Its quality list's options stayed 25 px tall.
for (const [name, w, h, z] of [["tw1920", 1920, 1080, 1.5], ["tw2560", 2560, 1440, 2]] as const) {
  test(`${String(w)}×${String(h)} Twitch VOD: the seek bar keeps its 1280 width, zoomed; the quality list's keys are at least 40 px`, async ({ browser, request }) => {
    const room = testRoom("wide", name);
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    const page = await one(browser, name, DESKTOP(w, h));
    await waitProviderPlaying(clients, "twitch");
    expect((await box(page.getByTestId("seek"))).width).toBeGreaterThanOrEqual(160 * z);
    await page.locator('[data-testid="quality-key"]').click();
    await expect(page.locator('[data-testid="quality-menu"]')).toBeVisible();
    const found = await keys(page);
    expect(found.map((k) => k.name)).toEqual(expect.arrayContaining(["quality-option"]));
    expect(found.filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// QA OME-1696: the help dialog stayed 1×, a 520 px box of 12 px text in the middle of a 2560 screen.
test("2560×1440: the help dialog scales with the chrome and still fits the screen", async ({ browser }) => {
  const page = await one(browser, "help2560", DESKTOP(2560, 1440));
  await page.locator(site.helpKey).click();
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  expect((await box(dialog)).width).toBeGreaterThanOrEqual(1000);
  await inView(page, dialog);
});

test("2560×1440: the chrome scales up with the screen, no 1280 page floating in it", async ({ browser }) => {
  const page = await one(browser, "w2560", DESKTOP(2560, 1440));
  const side = await box(page.locator(site.chatLog));
  const shelf = await box(page.locator(".controls"));
  const room = await box(page.locator(site.roomWindow));
  const say = await box(page.locator(site.chatSend));
  expect(side.width).toBeGreaterThanOrEqual(560);
  expect(shelf.height).toBeGreaterThanOrEqual(80);
  expect(say.height).toBeGreaterThanOrEqual(70);
  // The room is height-bound at 16:9: the taller shelf and top row cost it a little width (1389 → 1225 px), not its fill.
  expect(room.width).toBeGreaterThanOrEqual(1200);
  // The field grows with its keys.
  expect((await box(page.locator(site.chatInput))).height).toBeGreaterThanOrEqual(70);
});

test("390×844 phone: the stacked layout stays, with the volume in the shelf under the picture", async ({ browser }) => {
  const page = await one(browser, "phone", PHONE);
  const tv = await box(page.locator(site.tv));
  const room = await box(page.locator(site.roomWindow));
  const log = await box(page.locator(site.chatLog));
  // Stacked: TV, room window, chat log, top to bottom, all full width.
  expect(room.y).toBeGreaterThan(tv.y + tv.height);
  expect(log.y).toBeGreaterThan(room.y + room.height);
  await volumeUnderPicture(page);
  // No sideways scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The desktop hint isn't a phone's (no Enter key to press).
  await expect(page.locator(site.chatInput)).not.toHaveAttribute("placeholder", "Press Enter to chat");
});

test("keyboard only: Enter → type → Enter sends and stays; Esc hands the keys back; Enter on a focused key keeps its meaning", async ({ browser }) => {
  const page = await one(browser, "keys", DESKTOP(1280, 720));
  const input = page.locator(site.chatInput);
  const focusedIs = (l: Locator): Promise<boolean> => l.evaluate((e) => e === document.activeElement);

  // Nothing focused.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Enter");
  expect(await focusedIs(input)).toBe(true);
  await page.keyboard.type("typed with keys only");
  await page.keyboard.press("Enter");
  await expect(page.locator(site.chatLogLine).last()).toContainText("typed with keys only");
  expect(await focusedIs(input)).toBe(true);
  await expect(input).toHaveValue("");
  // The field's ring shows.
  expect(await input.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe("none");

  await page.keyboard.press("Escape");
  expect(await focusedIs(input)).toBe(false);
  // A second Enter brings it back.
  await page.keyboard.press("Enter");
  expect(await focusedIs(input)).toBe(true);
  await page.keyboard.press("Escape");

  // A focused key keeps Enter: the mute key toggles and keeps focus.
  const mute = page.locator(site.muteToggle);
  await mute.focus();
  const pressed = await mute.getAttribute("aria-pressed");
  await page.keyboard.press("Enter");
  expect(await focusedIs(mute)).toBe(true);
  await expect(mute).not.toHaveAttribute("aria-pressed", pressed ?? "");
  expect(await focusedIs(input)).toBe(false);
  // A seat keeps it too (Enter sits; the chat field isn't focused).
  const seat = page.locator(site.seat).first();
  await seat.focus();
  await page.keyboard.press("Enter");
  expect(await focusedIs(input)).toBe(false);

  // Typing while the window crosses 1024 px (the chat moves column): the field keeps focus and the draft.
  await input.focus();
  await page.keyboard.type("half a line");
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") === null)).toBe(true);
  expect(await focusedIs(input)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") !== null)).toBe(true);
  expect(await focusedIs(input)).toBe(true);
  await expect(input).toHaveValue("half a line");
});

test("full screen: Enter jumps to the strip's chat field and it sends from there", async ({ browser }) => {
  const page = await one(browser, "fs", DESKTOP(1280, 720));
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => page.evaluate((sel) => document.fullscreenElement?.matches(sel) === true, site.fsRoot)).toBe(true);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Enter");
  const input = page.locator(site.fsStrip).locator(site.chatInput);
  expect(await input.evaluate((e) => e === document.activeElement)).toBe(true);
  await page.keyboard.type("from the strip");
  await page.keyboard.press("Enter");
  await expect(page.locator(site.fsStrip).locator(site.chatLogLine).last()).toContainText("from the strip");
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  // Back on the page, the volume is under the picture again.
  await volumeUnderPicture(page);
});

test("a long log stays at its foot when the chat changes column (1024 px) and in and out of full screen; new lines stay in view", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("wide", "scroll").url, count: 4, nicknamePrefix: "wdscroll", contextOptions: () => DESKTOP(1280, 720) });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  const page = a.page;
  // 4 × 5 lines (the server's chat burst): taller than the column's log.
  await Promise.all(clients.map(async (c, i) => {
    for (let n = 0; n < 5; n++) {
      await c.page.locator(site.chatInput).fill(`line ${String(i)}-${String(n)}`);
      await c.page.locator(site.chatInput).press("Enter");
    }
  }));
  const log = page.locator(site.chatLog);
  await expect(log.locator(site.chatLogLine).filter({ hasText: "line " })).toHaveCount(20);
  const atFoot = (): Promise<boolean> => log.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 2);
  // It overflows the column's log, and the reader is at its foot.
  expect(await log.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await expect.poll(atFoot).toBe(true);

  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") === null)).toBe(true);
  expect(await log.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 2)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") !== null)).toBe(true);
  expect(await atFoot()).toBe(true);

  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  expect(await atFoot()).toBe(true);
  await expect(log.locator(site.chatLogLine).last()).toBeInViewport();
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(await atFoot()).toBe(true);

  // And it still follows: a new line lands in view.
  const b = clients[1];
  if (b === undefined) throw new Error("no second client");
  await b.page.waitForTimeout(1100);
  await b.page.locator(site.chatInput).fill("after the moves");
  await b.page.locator(site.chatInput).press("Enter");
  const latest = log.locator(site.chatLogLine).last();
  await expect(latest).toContainText("after the moves");
  await expect(latest).toBeInViewport();
  expect(await atFoot()).toBe(true);
});
