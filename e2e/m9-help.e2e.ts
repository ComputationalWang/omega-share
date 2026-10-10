// OME-768 (M9 W2): the first-visit hint, the "?" help dialog and "Room not found", on the real page against the real server.
// What the hint and the dialog say, their focus rules and the not-found words are unit tests (apps/web/test/help-*.test.ts,
// not-found.test.ts); this spec checks what only a browser can: placement (the hint never covers the picture or the
// composer), once per browser, the real keys, no canvas redraw from opening help, and the server's answer for a bad id.
import { devices, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";
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

async function join(name: RoomName<"m9-help">, browser: Parameters<typeof joinRoom>[0], still = false, options?: BrowserContextOptions): Promise<Page> {
  // `still`: reduced motion, so idle avatars don't breathe and the canvas draws only when something happens.
  const contextOptions: BrowserContextOptions = { ...options, ...(still ? { reducedMotion: "reduce" as const } : {}) };
  clients = await joinRoom(browser, { roomUrl: testRoom("m9-help", name).url, count: 1, nicknamePrefix: `h${name}`, contextOptions: () => contextOptions });
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
  const page = await join("help", browser, true);
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

const inDialog = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest("[data-testid=help-dialog]") != null);

test("phone (touch): the hint sits in the viewport clear of the picture and the composer, the help key opens the dialog by tap, it fits and scrolls, Close is a finger-sized target and returns focus to the key", async ({ browser }) => {
  const page = await join("touch", browser, false, devices["Pixel 7"]);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport");
  const hint = page.locator(site.firstHint);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Tap a seat to sit");
  const box = await hint.boundingBox();
  if (box === null) throw new Error("hint not laid out");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(await overlaps(hint, page.locator(site.tv))).toBe(false);
  expect(await overlaps(hint, page.locator(site.chatInput))).toBe(false);
  expect(await overlaps(hint, page.locator(site.chatSend))).toBe(false);
  const wide = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth);
  expect(await wide()).toBe(false);

  const key = page.locator(site.helpKey);
  await key.scrollIntoViewIfNeeded();
  await key.tap();
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  expect(await wide()).toBe(false);
  const d = await dialog.boundingBox();
  if (d === null) throw new Error("dialog not laid out");
  expect(d.x).toBeGreaterThanOrEqual(0);
  expect(d.y).toBeGreaterThanOrEqual(0);
  expect(d.x + d.width).toBeLessThanOrEqual(viewport.width);
  expect(d.y + d.height).toBeLessThanOrEqual(viewport.height);
  // Taller than the screen is fine only if it scrolls.
  const scroll = await dialog.evaluate((e) => ({ over: e.scrollHeight > e.clientHeight, overflowY: getComputedStyle(e).overflowY, across: e.scrollWidth > e.clientWidth }));
  expect(scroll.across).toBe(false);
  if (scroll.over) expect(["auto", "scroll"]).toContain(scroll.overflowY);
  const close = page.locator(site.helpClose);
  await close.scrollIntoViewIfNeeded();
  // `.ui-touch .ui-button::before` grows the tap area to 44 px: the box or the pseudo-element must reach it.
  const target = await close.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const before = getComputedStyle(e, "::before");
    return { width: Math.max(r.width, parseFloat(before.width) || 0), height: Math.max(r.height, parseFloat(before.height) || 0) };
  });
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await close.tap();
  await expect(dialog).toBeHidden();
  expect(await focusedTestId(page)).toBe("help-key");
  expect(await wide()).toBe(false);
});

/** Opacity, transform and the animation and transition setup of `target`, sampled now and after two frames. */
async function motionOf(target: Locator): Promise<{ names: string[]; durations: string[]; first: string; second: string }> {
  return target.evaluate(
    (e) =>
      new Promise((resolve) => {
        const look = (): string => {
          const s = getComputedStyle(e);
          return `${s.opacity}|${s.transform}|${s.display}`;
        };
        const s = getComputedStyle(e);
        const first = look();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve({ names: s.animationName.split(", "), durations: [...s.animationDuration.split(", "), ...s.transitionDuration.split(", ")], first, second: look() });
          });
        });
      }),
  );
}

test("reduced motion: the hint and the help dialog appear and go with no animation, and both still work", async ({ browser }) => {
  const page = await join("reduced", browser, true);
  const hint = page.locator(site.firstHint);
  await expect(hint).toBeVisible();
  const h = await motionOf(hint);
  expect(h.names.every((n) => n === "none")).toBe(true);
  expect(h.durations.every((t) => parseFloat(t) === 0)).toBe(true);
  expect(h.second).toBe(h.first);
  expect(h.first.startsWith("1|")).toBe(true);
  // Gone at once on dismiss: hidden in the same task as the click.
  expect(
    await hint.evaluate((e) => {
      e.querySelector<HTMLElement>("[data-testid=first-hint-close]")?.click();
      return e instanceof HTMLElement && e.hidden && getComputedStyle(e).display === "none";
    }),
  ).toBe(true);

  const key = page.locator(site.helpKey);
  await key.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  const d = await motionOf(dialog);
  expect(d.names.every((n) => n === "none")).toBe(true);
  expect(d.durations.every((t) => parseFloat(t) === 0)).toBe(true);
  expect(d.second).toBe(d.first);
  expect(d.first.startsWith("1|")).toBe(true);
  // And the backdrop doesn't fade either.
  const backdrop = await dialog.evaluate((e) => {
    const s = getComputedStyle(e, "::backdrop");
    return { name: s.animationName, duration: s.animationDuration, transition: s.transitionDuration };
  });
  expect(backdrop.name).toBe("none");
  expect(parseFloat(backdrop.duration)).toBe(0);
  expect(parseFloat(backdrop.transition)).toBe(0);
  // Closing: shut in the same task as the click, no leaving animation.
  expect(
    await dialog.evaluate((e) => {
      e.querySelector<HTMLElement>("[data-testid=help-close]")?.click();
      return e instanceof HTMLDialogElement && !e.open && getComputedStyle(e).display === "none";
    }),
  ).toBe(true);
  expect(await focusedTestId(page)).toBe("help-key");
  // Still works with the keyboard: ? opens, Esc closes.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Shift+?");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await focusedTestId(page)).toBe("help-key");
});

test("keyboard: Tab and Shift+Tab stay in the dialog; Esc after the help key opened it gives focus back to the key", async ({ browser }) => {
  const page = await join("kbkey", browser);
  const key = page.locator(site.helpKey);
  await key.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  await expect(page.locator(site.helpClose)).toBeFocused();
  // Forward from the last stop (Close) wraps to the first link; back from the first lands on Close.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/privacy.html");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(site.helpClose)).toBeFocused();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inDialog(page)).toBe(true);
  }
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(await inDialog(page)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await focusedTestId(page)).toBe("help-key");
});

test("keyboard: ? from a focused control, Esc, and focus goes back to that control; ? from nothing goes back to the help key", async ({ browser }) => {
  const page = await join("kbq", browser);
  const dialog = page.locator(site.helpDialog);
  // From a focused button (the chat's send key is one, and not a text field).
  const send = page.locator(site.chatSend);
  await send.focus();
  await page.keyboard.press("Shift+?");
  await expect(dialog).toBeVisible();
  await expect(page.locator(site.helpClose)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await inDialog(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(send).toBeFocused();
  // From nothing focused: the help key.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Shift+?");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await focusedTestId(page)).toBe("help-key");
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
