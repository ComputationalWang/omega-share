// OME-600 (M7 W3b, set k `ui-m7-popout` / `ui-m7-away`, ADR 0035): the whole room on a second monitor. The room tab keeps
// the picture and the one WebSocket and pauses its own Pixi renderer; a same-origin `room.html` window draws the room
// (the one renderer, moved there) from the state the tab mirrors over the W3 BroadcastChannel, with the chat beside it.
// Sitting and chatting there go through the room tab. Bringing the room back reloads nothing and never touches the
// video. The channel schema, relay, window and geometry are unit tests (apps/web/test/popout-*.test.ts); the frames of
// both windows with 25 members are perf/popout-room.perf.ts.
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";
import { roomPlayback, shareVideo, waitPlaying } from "../perf/sync";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Counts the room WebSockets each page of the context opens (before any app code; the HMR socket isn't one). */
function countSockets(): void {
  const Native = window.WebSocket;
  Reflect.set(window, "__sockets", 0);
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (/\/rooms\/[^/]+\/ws$/.test(new URL(url, location.href).pathname)) Reflect.set(window, "__sockets", Number(Reflect.get(window, "__sockets")) + 1);
    }
  };
}
const sockets = (p: Page): Promise<number> => p.evaluate(() => Number(Reflect.get(window, "__sockets")));

/**
 * The room tab behind the window: hidden, so no animation frames (headless Chromium never hides a page; this stands in
 * for it, as in popout.e2e.ts).
 */
function hideable(): void {
  let hidden = false;
  const waiting: FrameRequestCallback[] = [];
  const raf = window.requestAnimationFrame.bind(window);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  window.requestAnimationFrame = (cb) => {
    if (!hidden) return raf(cb);
    waiting.push(cb);
    return 0;
  };
  Reflect.set(window, "__setHidden", (on: boolean) => {
    hidden = on;
    document.dispatchEvent(new Event("visibilitychange"));
    if (!on) for (const cb of waiting.splice(0)) raf(cb);
  });
}
const setHidden = (p: Page, on: boolean): Promise<void> =>
  p.evaluate((h) => {
    const f: unknown = Reflect.get(window, "__setHidden");
    if (typeof f === "function") Reflect.apply(f, null, [h]);
  }, on);

async function join(browser: Browser, name: RoomName<"popout-room">, count = 1, options?: BrowserContextOptions, init?: () => void): Promise<Client[]> {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("popout-room", name).url,
    count,
    nicknamePrefix: `pr${name}`,
    contextOptions: (i) => (i === 0 ? options : undefined),
    setup: async (context, i) => {
      if (i !== 0) return;
      await context.addInitScript(countSockets);
      if (init !== undefined) await context.addInitScript(init);
    },
  });
  return clients;
}

/** The room handle's dev hook (apps/web/src/main.ts `window.__omega.room`). */
const handle = (page: Page, what: "roomPaused" | "state"): Promise<unknown> =>
  page.evaluate((what) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, what) : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
  }, what);
const roomPaused = (page: Page): Promise<unknown> => handle(page, "roomPaused");
const mySeat = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
    const s: unknown = typeof f === "function" ? Reflect.apply(f, room, []) : null;
    if (typeof s !== "object" || s === null) return -1;
    const self: unknown = Reflect.get(s, "self");
    const r: unknown = Reflect.get(s, "room");
    const seats: unknown = typeof r === "object" && r !== null ? Reflect.get(r, "seats") : null;
    return Array.isArray(seats) ? seats.indexOf(self) : -1;
  });

/** Press the room's "Pop out room" key and return the room window once it's drawing the room. */
async function popRoom(page: Page, context: BrowserContext): Promise<Page> {
  const [pop] = await Promise.all([context.waitForEvent("page"), page.locator(site.roomPopout).click()]);
  await pop.waitForLoadState();
  await expect(pop.locator(`${site.poproomRoom} canvas`)).toBeVisible();
  await expect(pop.locator(site.chatInput)).toBeEnabled();
  await expect(page.locator(site.roomAway)).toBeVisible();
  return pop;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

test("pop out room: the window draws the room and the chat; the page keeps the picture and the one socket, its renderer paused", async ({ browser, request }) => {
  const room = testRoom("popout-room", "show");
  await shareVideo(request, room.id);
  const [a, b] = await join(browser, "show", 2);
  if (a === undefined || b === undefined) throw new Error("no clients");
  await waitPlaying([a, b]);
  await say(b.page, "before");
  const key = a.page.locator(site.roomPopout);
  await expect(key).toHaveAccessibleName("Pop out room");
  await expect(key).toHaveAttribute("title", "Pop out room");
  // Set k: never side by side with "Pop out chat" (that one ends the chat row).
  await expect(a.page.locator(`${site.roomPopout} + ${site.chatPopout}, ${site.chatPopout} + ${site.roomPopout}`)).toHaveCount(0);
  const video = await a.page.locator(site.sharedVideo).elementHandle();
  const pop = await popRoom(a.page, a.context);
  expect(new URL(pop.url()).pathname).toBe("/room.html");
  expect(await pop.evaluate(() => window.opener === null)).toBe(true);
  await expect(pop).toHaveTitle(/omega-share$/);
  // The room: both members' tags, the eight seats, the backlog in the chat column (a full log).
  await expect(pop.locator(site.nicknameTag)).toHaveText(["prshow-1", "prshow-2"], { useInnerText: true });
  await expect(pop.locator(site.seat)).toHaveCount(8);
  await expect(pop.locator(`${site.poproomChat} ${site.chatLogLine}`)).toHaveText(["prshow-2 before"]);
  // The brass plate says where the picture is and the room's time.
  await expect(pop.locator(site.poproomPlate)).toHaveText(/^Playing on your main screen · \d+:\d\d$/);
  // Never two renderers: the page's is paused; never two sockets: the window opened none.
  expect(await roomPaused(a.page)).toBe(true);
  expect(await sockets(a.page)).toBe(1);
  expect(await sockets(pop)).toBe(0);
  // The page: the picture in place (the same player, never reloaded), the stage's placeholder, no chat row.
  expect(await video?.evaluate((e) => e.isConnected)).toBe(true);
  await expect(a.page.locator(site.room)).toBeHidden();
  await expect(a.page.locator(site.chatInput)).toBeHidden();
  await expect(a.page.locator(site.chatAway)).toBeHidden();
  const away = a.page.locator(site.roomAway);
  await expect(away).toHaveAttribute("role", "status");
  await expect(away).toContainText("The room is in its own window.");
  await expect(away).toContainText("The picture stays here; the room and chat are over there.");
  await expect(a.page.locator(site.roomBringBack)).toHaveAccessibleName("Bring the room back");
  await expect(a.page.locator(site.roomShowWindow)).toHaveAccessibleName("Show the window");
  // Bubbles over the avatars are drawn in the window now.
  await say(b.page, "to the window");
  await expect(pop.locator(site.chatMessage)).toHaveText(["to the window"]);
  await expect(pop.locator(`${site.poproomChat} ${site.chatLogLine}`).last()).toHaveText("prshow-2 to the window");
});

test("sitting and chatting from the window go through the room tab", async ({ browser }) => {
  const [a, b] = await join(browser, "sit", 2);
  if (a === undefined || b === undefined) throw new Error("no clients");
  const pop = await popRoom(a.page, a.context);
  await pop.locator(`${site.seat}[data-seat="2"]`).click();
  await expect.poll(() => mySeat(a.page)).toBe(2);
  await expect(b.page.locator(`${site.seat}[data-seat="2"]`)).toHaveAttribute("data-occupied", "true");
  await expect(pop.locator(`${site.seat}[data-seat="2"]`)).toHaveClass(/\bmine\b/);
  await expect(pop.locator(`${site.seat}[data-seat="2"]`)).toHaveAccessibleName("Seat 3, yours: stand up");
  // Stand up again from the window.
  await pop.locator(`${site.seat}[data-seat="2"]`).click();
  await expect.poll(() => mySeat(a.page)).toBe(-1);
  // Someone else's seat in the window says whose it is.
  await b.page.locator(`${site.seat}[data-seat="5"]`).click();
  await expect(pop.locator(`${site.seat}[data-seat="5"]`)).toHaveAccessibleName("Seat 6, taken by prsit-2");
  await say(pop, "from the window");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("prsit-1 from the window");
  await expect(b.page.locator(site.chatMessage)).toContainText(["from the window"]);
  await expect(pop.locator(site.chatMessage)).toContainText(["from the window"]);
  // Emotes from the window go out too, and the window draws them.
  await pop.getByTestId("emote-key").click();
  await pop.getByTestId("emote-menu").getByRole("menuitem").first().click();
  expect(await sockets(a.page)).toBe(1);
});

test("bringing the room back (window key, page key, OS ×) reloads nothing and never drops the picture's sync", async ({ browser, request }) => {
  const room = testRoom("popout-room", "back");
  await shareVideo(request, room.id);
  const [a, b] = await join(browser, "back", 2);
  if (a === undefined || b === undefined) throw new Error("no clients");
  await waitPlaying([a, b]);
  await a.page.evaluate(() => {
    Reflect.set(window, "__noReload", true);
  });
  const video = await a.page.locator(site.sharedVideo).elementHandle();
  // The window's put-back key.
  let pop = await popRoom(a.page, a.context);
  let closed = pop.waitForEvent("close");
  await pop.locator(site.popoutBack).click();
  await closed;
  await expect(a.page.locator(site.room)).toBeVisible();
  await expect(a.page.locator(site.roomAway)).toBeHidden();
  await expect(a.page.locator(site.chatInput)).toBeVisible();
  expect(await roomPaused(a.page)).toBe(false);
  // The OS ×.
  pop = await popRoom(a.page, a.context);
  await pop.close({ runBeforeUnload: true });
  await expect(a.page.locator(site.room)).toBeVisible();
  // The page's key, by keyboard: focus lands back in the room's place (the message field, as with the chat).
  pop = await popRoom(a.page, a.context);
  closed = pop.waitForEvent("close");
  await a.page.locator(site.roomBringBack).focus();
  await a.page.keyboard.press("Enter");
  await closed;
  await expect(a.page.locator(site.room)).toBeVisible();
  await expect(a.page.locator(site.chatInput)).toBeFocused();
  // No reload, and the same player all along: it kept playing in step with the room.
  expect(await a.page.evaluate(() => Reflect.get(window, "__noReload"))).toBe(true);
  expect(await video?.evaluate((e) => e.isConnected)).toBe(true);
  const expected = await roomPlayback(browser, room.id);
  expect(expected.playing).toBe(true);
  await expect
    .poll(async () => {
      const t = await a.page.evaluate(() => window.__fakeYt?.player?.getCurrentTime() ?? -1);
      const now = await roomPlayback(browser, room.id);
      return Math.abs(t - now.position) < 1.5;
    }, { timeout: 5_000 })
    .toBe(true);
  // Back in the page, the room draws what changed while it was out.
  await b.page.locator(`${site.seat}[data-seat="1"]`).click();
  await expect(a.page.locator(`${site.seat}[data-seat="1"]`)).toHaveAttribute("data-occupied", "true");
});

test("full screen while the room is out: the picture alone, no strip; leaving it keeps the room in the window", async ({ browser, request }) => {
  const room = testRoom("popout-room", "fs");
  await shareVideo(request, room.id);
  const [a] = await join(browser, "fs");
  if (a === undefined) throw new Error("no client");
  await waitPlaying([a]);
  const pop = await popRoom(a.page, a.context);
  await a.page.locator(site.fullscreenToggle).click();
  await expect.poll(() => a.page.evaluate((sel) => document.fullscreenElement?.matches(sel) === true, site.fsRoot)).toBe(true);
  await expect(a.page.locator(site.fsStrip)).toBeHidden();
  const tv = await a.page.locator(site.tv).boundingBox();
  const vp = a.page.viewportSize();
  if (tv === null || vp === null) throw new Error("no geometry");
  // Wider than with a strip beside it: the picture takes the screen.
  expect(tv.width).toBeGreaterThan(vp.width - 300);
  expect(await roomPaused(a.page)).toBe(true);
  await a.page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => a.page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(a.page.locator(site.roomAway)).toBeVisible();
  expect(await roomPaused(a.page)).toBe(true);
  await expect(pop.locator(`${site.poproomRoom} canvas`)).toBeVisible();
});

test("keyboard: Tab to the key and Enter; in the window focus starts in the message field, seats are keys, Tab is visible", async ({ browser }) => {
  const [a] = await join(browser, "keys");
  if (a === undefined) throw new Error("no client");
  const key = a.page.locator(site.roomPopout);
  await key.focus();
  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.keyboard.press("Enter")]);
  await pop.waitForLoadState();
  await expect(pop.locator(site.chatInput)).toBeFocused();
  // The room's seats are buttons in the window's tab order; Enter on one sits.
  const seat = pop.locator(`${site.seat}[data-seat="0"]`);
  await seat.focus();
  await expect(seat).toBeFocused();
  const outline = await seat.evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(outline).not.toBe("none");
  await pop.keyboard.press("Enter");
  await expect.poll(() => mySeat(a.page)).toBe(0);
  // "Show the window" asks the window to come forward; "Bring the room back" is the first stop in the placeholder.
  await a.page.locator(site.roomShowWindow).click();
  await expect(pop.locator(site.poproomRoom)).toBeVisible();
  await a.page.keyboard.press("Shift+Tab");
  await expect(a.page.locator(site.roomBringBack)).toBeFocused();
});

test("reduced motion in the window: an emote is a still badge over the avatar", async ({ browser }) => {
  const [a, b] = await join(browser, "reduced", 2, { reducedMotion: "reduce" });
  if (a === undefined || b === undefined) throw new Error("no clients");
  const pop = await popRoom(a.page, a.context);
  await b.page.keyboard.press("3");
  await expect(pop.getByTestId("emote-badge")).toBeVisible();
});

test("the room tab hidden behind the window: the room, chat and seats still reach the window", async ({ browser }) => {
  const [a, b] = await join(browser, "hidden", 2, undefined, hideable);
  if (a === undefined || b === undefined) throw new Error("no clients");
  const pop = await popRoom(a.page, a.context);
  await setHidden(a.page, true);
  await b.page.locator(`${site.seat}[data-seat="4"]`).click();
  await expect(pop.locator(`${site.seat}[data-seat="4"]`)).toHaveAttribute("data-occupied", "true");
  await say(b.page, "while hidden");
  await expect(pop.locator(site.chatMessage)).toContainText(["while hidden"]);
  await pop.locator(`${site.seat}[data-seat="6"]`).click();
  await expect(b.page.locator(`${site.seat}[data-seat="6"]`)).toHaveAttribute("data-occupied", "true");
  await setHidden(a.page, false);
});

test("pop out room while the chat is out: the room window takes over and the chat window goes", async ({ browser }) => {
  const [a] = await join(browser, "chat");
  if (a === undefined) throw new Error("no client");
  const [chat] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.chatPopout).click()]);
  await expect(chat.locator(site.chatInput)).toBeEnabled();
  const chatClosed = chat.waitForEvent("close");
  const pop = await popRoom(a.page, a.context);
  await chatClosed;
  await expect(a.page.locator(site.chatAway)).toBeHidden();
  await expect(a.page.locator(site.roomAway)).toBeVisible();
  // Room back: the chat row comes home too (the room window held both).
  const closed = pop.waitForEvent("close");
  await a.page.locator(site.roomBringBack).click();
  await closed;
  await expect(a.page.locator(site.chatInput)).toBeVisible();
  await expect(a.page.locator(site.room)).toBeVisible();
});

test("not offered on a phone", async ({ browser }) => {
  const [phone] = await join(browser, "phone", 1, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (phone === undefined) throw new Error("no client");
  await expect(phone.page.locator(site.chatInput)).toBeVisible();
  await expect(phone.page.locator(site.roomPopout)).toBeHidden();
});
