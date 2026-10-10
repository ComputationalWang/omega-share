// OME-768 (M9 W2): the first-visit hint, the "?" help dialog and "Room not found", on the real page against the real server.
// What the hint and the dialog say, their focus rules and the not-found words are unit tests (apps/web/test/help-*.test.ts,
// not-found.test.ts); this spec checks what only a browser can: placement (the hint never covers the picture or the
// composer), once per browser, the real keys, no canvas redraw from opening help, and the server's answer for a bad id.
import type { Locator, Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { ownedRoom } from "./support/owned-rooms";
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

async function join(name: RoomName<"m9-help">, browser: Parameters<typeof joinRoom>[0]): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("m9-help", name).url, count: 1, nicknamePrefix: `h${name}` });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.connectionStatus)).toHaveText("");
  return page;
}

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): how many times the room canvas has rendered. */
async function roomRenders(page: Page): Promise<number> {
  const n = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "roomRenders") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
  });
  return v.parse(v.number(), n);
}

/** Waits until no line or bubble is left to expire, then until the canvas has drawn nothing for a whole second. */
async function settledRenders(page: Page): Promise<number> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const debug: unknown = Reflect.get(window, "__omega");
          const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
          const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
          const s: unknown = typeof f === "function" ? Reflect.apply(f, room, []) : null;
          if (typeof s !== "object" || s === null) return -1;
          const lines: unknown = Reflect.get(s, "syslines");
          const bubbles: unknown = Reflect.get(s, "bubbles");
          return (Array.isArray(lines) ? lines.length : 1) + (Array.isArray(bubbles) ? bubbles.length : 1);
        }),
      { timeout: 20_000 },
    )
    .toBe(0);
  let last = await roomRenders(page);
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(1000);
        const now = await roomRenders(page);
        const still = now === last;
        last = now;
        return still;
      },
      { timeout: 20_000, intervals: [0] },
    )
    .toBe(true);
  return last;
}

async function overlaps(a: Locator, b: Locator): Promise<boolean> {
  const x = await a.boundingBox();
  const y = await b.boundingBox();
  if (x === null || y === null) throw new Error("not laid out");
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
}

const focusedTestId = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

test("first visit: the hint shows, politely, clear of the picture and the composer; sitting dismisses it; a reload doesn't bring it back", async ({ browser }) => {
  const page = await join("hint", browser);
  const hint = page.locator(site.firstHint);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Click a seat to sit · type to chat · T for emotes · F for full screen");
  await expect(page.locator(`${site.firstHint}[aria-live=polite], ${site.firstHint} [aria-live=polite]`)).toHaveCount(1);
  expect(await overlaps(hint, page.locator(site.tv))).toBe(false);
  expect(await overlaps(hint, page.locator(site.chatInput))).toBe(false);

  await page.locator(`${site.seat}[data-seat="0"]`).click();
  await expect(hint).toBeHidden();

  await page.reload();
  await page.locator(site.nicknameInput).fill("hhint-2");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.connectionStatus)).toHaveText("");
  await page.waitForTimeout(500);
  await expect(hint).toBeHidden();
});

test("the hint goes with Esc", async ({ browser }) => {
  const page = await join("hintesc", browser);
  const hint = page.locator(site.firstHint);
  await expect(hint).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
});

test("? opens the help dialog: modal, focus inside and trapped, no canvas redraw; Esc closes it and focus comes back", async ({ browser }) => {
  const page = await join("help", browser);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const before = await settledRenders(page);
  await page.keyboard.press("Shift+?");
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toContainText("Report room");
  await expect(dialog.locator("a[href='/privacy.html']")).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=help-dialog]") != null)).toBe(true);
  // Twenty Tabs never leave the dialog.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=help-dialog]") != null)).toBe(true);
  }
  await page.waitForTimeout(1000);
  expect(await roomRenders(page)).toBe(before);
  // T and F wait while the dialog is open.
  await page.keyboard.press("t");
  await expect(page.locator("[data-testid=emote-menu]:visible")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await roomRenders(page)).toBe(before);
});

test("the help key in the room bar opens it too, and focus goes back to the key", async ({ browser }) => {
  const page = await join("helpkey", browser);
  const key = page.locator(site.helpKey);
  await expect(key).toBeVisible();
  await key.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(site.helpDialog)).toBeVisible();
  await page.locator(site.helpClose).click();
  await expect(page.locator(site.helpDialog)).toBeHidden();
  expect(await focusedTestId(page)).toBe("help-key");
  // Never while typing: ? in the chat field is a question mark.
  await page.locator(site.chatInput).fill("");
  await page.locator(site.chatInput).press("Shift+?");
  await expect(page.locator(site.helpDialog)).toBeHidden();
  await expect(page.locator(site.chatInput)).toHaveValue("?");
});

async function enterRoom(page: Page, url: string, nickname: string): Promise<void> {
  await page.goto(url);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
}

test("an unknown room id: 'Room not found' with Go home and the open rooms, never a reconnect loop", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  try {
    await enterRoom(page, `${URLS.web}/r/no-such-room-here`, "nf-1");
    const nf = page.locator(site.notFound);
    await expect(nf).toBeVisible();
    await expect(nf.locator("h2")).toHaveText("This room doesn't exist or was taken down");
    await expect(page.locator(site.notFoundHome)).toHaveAttribute("href", "/");
    await expect(page.locator(site.notFoundRoom).first()).toBeVisible();
    await expect(page.locator(site.connectionStatus)).toHaveText("");
    await page.waitForTimeout(2000);
    expect(sockets.filter((u) => u.includes("/rooms/no-such-room-here/ws"))).toHaveLength(1);
    // Focus lands on the screen's first key, not <body>.
    expect(await focusedTestId(page)).toBe("not-found-home");
  } finally {
    await context.close();
  }
});

test("a private room without its key looks exactly like no room", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  try {
    await enterRoom(page, `${URLS.web}/r/${ownedRoom("notfound").id}`, "nf-2");
    const nf = page.locator(site.notFound);
    await expect(nf).toBeVisible();
    const privateText = (await nf.innerText()).replace(/\n[\s\S]*Open rooms[\s\S]*$/, "");
    await page.goto(`${URLS.web}/`);
    await enterRoom(page, `${URLS.web}/r/no-such-room-either`, "nf-3");
    await expect(nf).toBeVisible();
    const unknownText = (await nf.innerText()).replace(/\n[\s\S]*Open rooms[\s\S]*$/, "");
    expect(privateText).toBe(unknownText);
    await expect(page.locator(site.roomRefused)).toBeHidden();
  } finally {
    await context.close();
  }
});
