// OME-598 (M7 W3, set k `ui-m7-popout` / `ui-m7-away`, R-M7a Q3 a): pop-out chat for a second monitor. The room tab keeps
// the one WebSocket and relays chat to a same-origin `chat.html` window over a BroadcastChannel; the window never opens a
// socket or joins. The page shows the "chat is in its own window" placeholder with a bring-back key; closing the window
// brings the chat back. Desktop only, and only where BroadcastChannel exists. The channel schema, relay and window logic
// are unit tests (apps/web/test/popout-*.test.ts); the room tab's frames with the window open are perf/popout.perf.ts.
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

/** Counts the WebSockets each page of the context opens (an init script, so it runs before any app code). */
function countSockets(): void {
  const Native = window.WebSocket;
  Reflect.set(window, "__sockets", 0);
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      Reflect.set(window, "__sockets", Number(Reflect.get(window, "__sockets")) + 1);
    }
  };
}
const sockets = (p: Page): Promise<number> => p.evaluate(() => Number(Reflect.get(window, "__sockets")));

async function join(browser: Browser, name: RoomName<"popout">, count = 1, options?: BrowserContextOptions, init?: () => void): Promise<Client[]> {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("popout", name).url,
    count,
    nicknamePrefix: `po${name}`,
    contextOptions: (i) => (i === 0 ? options : undefined),
    setup: async (context, i) => {
      if (i !== 0) return;
      await context.addInitScript(countSockets);
      if (init !== undefined) await context.addInitScript(init);
    },
  });
  return clients;
}

/** Press the room's pop-out key and return the chat window once it's showing the chat. */
async function popOut(page: Page, context: BrowserContext): Promise<Page> {
  const [pop] = await Promise.all([context.waitForEvent("page"), page.locator(site.chatPopout).click()]);
  await pop.waitForLoadState();
  await expect(pop.locator(site.chatInput)).toBeVisible();
  await expect(page.locator(site.chatAway)).toBeVisible();
  return pop;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

test("pop out: the chat moves to its own window over the one socket, both ways; the page keeps a placeholder", async ({ browser }) => {
  const [a, b] = await join(browser, "relay", 2);
  if (a === undefined || b === undefined) throw new Error("no clients");
  await say(b.page, "before");
  const key = a.page.locator(site.chatPopout);
  await expect(key).toBeVisible();
  await expect(key).toHaveAccessibleName("Pop out chat");
  const pop = await popOut(a.page, a.context);
  expect(new URL(pop.url()).pathname).toBe("/chat.html");
  // Opened with noopener: the window has no handle on the room tab.
  expect(await pop.evaluate(() => window.opener)).toBeNull();
  // The backlog came over, and both ways work from here.
  await expect(pop.locator(site.chatLogLine)).toHaveText(["porelay-2 before"]);
  await say(b.page, "to the window");
  await expect(pop.locator(site.chatLogLine).last()).toHaveText("porelay-2 to the window");
  await say(pop, "from the window");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("porelay-1 from the window");
  await expect(pop.locator(site.chatLogLine).last()).toHaveText("porelay-1 from the window");
  await expect(pop.locator(`${site.chatLogLine}.self`)).toHaveText(["porelay-1 from the window"]);
  // Bubbles still show over the avatars in the room tab.
  await expect(a.page.locator(site.chatMessage)).toContainText(["from the window"]);
  // One WebSocket for this user: the room tab's. The window opened none, so it never joined (one member each).
  expect(await sockets(a.page)).toBe(1);
  expect(await sockets(pop)).toBe(0);
  await expect(pop.locator(site.popoutPeople)).toHaveText("2 / 8");
  // The page: no log or field, the set (k) placeholder (a status region) with its bring-back key.
  await expect(a.page.locator(site.chatLog)).toBeHidden();
  await expect(a.page.locator(site.chatInput)).toBeHidden();
  const away = a.page.locator(site.chatAway);
  await expect(away).toHaveAttribute("role", "status");
  await expect(away).toContainText("Chat is in its own window.");
  await expect(a.page.locator(site.chatBringBack)).toHaveAccessibleName("Bring chat back");
  await expect(pop).toHaveTitle(/^Chat · .*omega-share$/);
});

test("closing the window, its put-back key, or the page's bring-back key returns the chat in place", async ({ browser }) => {
  const [a] = await join(browser, "back");
  if (a === undefined) throw new Error("no client");
  // The OS ×.
  let pop = await popOut(a.page, a.context);
  await pop.close({ runBeforeUnload: true });
  await expect(a.page.locator(site.chatAway)).toBeHidden();
  await expect(a.page.locator(site.chatInput)).toBeVisible();
  // The window's put-back key: the window closes and the page's chat comes back.
  pop = await popOut(a.page, a.context);
  const closed = pop.waitForEvent("close");
  await pop.locator(site.popoutBack).click();
  await closed;
  await expect(a.page.locator(site.chatInput)).toBeVisible();
  // The page's bring-back key (keyboard): the window closes, focus lands in the message field.
  pop = await popOut(a.page, a.context);
  const closedAgain = pop.waitForEvent("close");
  await a.page.locator(site.chatBringBack).focus();
  await a.page.keyboard.press("Enter");
  await closedAgain;
  await expect(a.page.locator(site.chatInput)).toBeFocused();
  await expect(a.page.locator(site.chatAway)).toBeHidden();
});

test("one window per tab: a reloaded or second window takes over, and chat is never sent twice", async ({ browser }) => {
  const [a, b] = await join(browser, "reopen", 2);
  if (a === undefined || b === undefined) throw new Error("no clients");
  const first = await popOut(a.page, a.context);
  await first.reload();
  await expect(first.locator(site.chatInput)).toBeVisible();
  await say(first, "once");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("poreopen-1 once");
  // A second window on the same tab's channel: the first one is told to go.
  const second = await a.context.newPage();
  const firstClosed = first.waitForEvent("close");
  await second.goto(first.url());
  await firstClosed;
  await expect(second.locator(site.chatInput)).toBeVisible();
  await say(second, "twice?");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("poreopen-1 twice?");
  await b.page.waitForTimeout(500);
  await expect(b.page.locator(site.chatLogLine).filter({ hasText: "once" })).toHaveCount(1);
  await expect(b.page.locator(site.chatLogLine).filter({ hasText: "twice?" })).toHaveCount(1);
  expect(await sockets(a.page)).toBe(1);
});

/**
 * The room tab behind the window: hidden, so no animation frames (headless Chromium never hides a page, so this stands
 * in for it: visibilityState/hidden say so and requestAnimationFrame callbacks wait until it's visible again).
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
    if (typeof f === "function") f(h);
  }, on);

test("the room tab hidden behind the window: chat still relays both ways; on return the player catches up by seek", async ({ browser, request }) => {
  const room = testRoom("popout", "hidden");
  await shareVideo(request, room.id);
  const [a, b] = await join(browser, "hidden", 2, undefined, hideable);
  if (a === undefined || b === undefined) throw new Error("no clients");
  await waitPlaying([a, b]);
  const pop = await popOut(a.page, a.context);
  await setHidden(a.page, true);
  await say(b.page, "while hidden");
  await expect(pop.locator(site.chatLogLine).last()).toHaveText("pohidden-2 while hidden");
  await say(pop, "from behind");
  await expect(b.page.locator(site.chatLogLine).last()).toHaveText("pohidden-1 from behind");
  await b.page.locator(site.seek).fill("300");
  await expect.poll(async () => (await roomPlayback(browser, room.id)).action, { timeout: 5_000 }).toBe("seek");
  await setHidden(a.page, false);
  const expected = await roomPlayback(browser, room.id);
  await expect
    .poll(async () => {
      const t = await a.page.evaluate(() => window.__fakeYt?.player?.getCurrentTime() ?? -1);
      return Math.abs(t - expected.position) < 5;
    }, { timeout: 5_000 })
    .toBe(true);
});

test("the room tab closed: the window shows the plug and offers to open the room in itself", async ({ browser }) => {
  const [a] = await join(browser, "gone");
  if (a === undefined) throw new Error("no client");
  const pop = await popOut(a.page, a.context);
  await a.page.close({ runBeforeUnload: true });
  const gone = pop.locator(site.popoutGone);
  await expect(gone).toBeVisible();
  await expect(gone).toContainText("The room's tab was closed.");
  await expect(pop.locator(site.chatInput)).toBeDisabled();
  await pop.locator(site.popoutOpenRoom).click();
  await expect(pop).toHaveURL(new RegExp(`/r/${testRoom("popout", "gone").id}$`));
});

test("not offered on a phone, nor where BroadcastChannel is missing", async ({ browser }) => {
  const [phone] = await join(browser, "offer", 1, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (phone === undefined) throw new Error("no client");
  await expect(phone.page.locator(site.chatInput)).toBeVisible();
  await expect(phone.page.locator(site.chatPopout)).toBeHidden();
  await leaveAll(clients);
  const [old] = await join(browser, "offer", 1, undefined, () => {
    Reflect.deleteProperty(window, "BroadcastChannel");
  });
  if (old === undefined) throw new Error("no client");
  await expect(old.page.locator(site.chatInput)).toBeVisible();
  await expect(old.page.locator(site.chatPopout)).toBeHidden();
});
