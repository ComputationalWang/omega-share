// The phone watch layout (OME-596, M7 W4, set k `ui-m7-watch`). On a phone (≤ 600 px wide): the TV full width on top,
// then the compact shelf, the room at 1× in a cropped window you can drag sideways, then the chat log and the chat
// row, in that order on screen and in focus order. No editor (owners get one line in chat instead). Every key and
// field is ≥ 44×44 CSS px to the finger. At 360 px the player keeps ADR 0012's 356×200 and nothing covers it.
// The pure geometry (breakpoint, crop, pan clamp, safe areas) is apps/web/test/phone-layout.test.ts; the frame budget
// on a Pixel-class phone is perf/phone.perf.ts.
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { ROOM_WALLS } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const phone = (width = 390): BrowserContextOptions => ({ ...PHONE, viewport: { width, height: 844 } });

let clients: Client[] = [];
let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  await Promise.all(contexts.map((c) => c.close()));
  clients = [];
  contexts = [];
});

async function one(browser: Browser, name: "stack" | "touch" | "narrow" | "drag" | "keys" | "afterdrag" | "pinch" | "overscroll" | "small" | "smallfs" | "people390" | "people320" | "small360", options: BrowserContextOptions = PHONE): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("phone-layout", name).url, count: 1, nicknamePrefix: `ph${name}`, contextOptions: () => options });
  const c = clients[0];
  if (c === undefined) throw new Error("no client");
  return c.page;
}

const top = async (l: Locator): Promise<number> => {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b.y;
};

/** The stage's translate and scale inside the room window (computed transform matrix(a, b, c, d, e, f)). */
async function stageTransform(page: Page): Promise<{ scale: number; x: number; y: number }> {
  return page.locator(site.room).evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { scale: m.a, x: m.e, y: m.f };
  });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }))));
}

test("stacked: TV, shelf, room window, chat log, chat row; the room at 1×, no sideways scroll", async ({ browser }) => {
  const page = await one(browser, "stack");
  const tv = page.locator(site.tv);
  const win = page.locator(site.roomWindow);
  const log = page.locator(site.chatLog);
  const input = page.locator(site.chatInput);
  await expect(win).toBeVisible();
  const ys = [await top(tv), await top(page.locator(".controls")), await top(win), await top(log), await top(input)];
  expect(ys, "TV, shelf, room, log, chat row from top to bottom").toEqual([...ys].sort((a, b) => a - b));

  // Focus order follows: the chat comes right after the room in the DOM, before "Up next" and the invite.
  const order = await page.evaluate(() => {
    const at = (sel: string): Element | null => document.querySelector(sel);
    const before = (a: Element | null, b: Element | null): boolean => a !== null && b !== null && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const win = at('[data-testid="room-window"]');
    const log = at('[data-testid="chat-log"]');
    const keys = at('[data-testid="portrait-chat"]');
    return { roomThenLog: before(win, log), logThenKeys: before(log, keys) };
  });
  expect(order).toEqual({ roomThenLog: true, logThenKeys: true });

  // Set k: the TV is full width, the room is never scaled down, its window is 270 px tall and as wide as the page.
  const tvBox = await tv.boundingBox();
  const winBox = await win.boundingBox();
  expect(tvBox?.width).toBeGreaterThanOrEqual(386);
  expect((await stageTransform(page)).scale).toBe(1);
  expect(winBox?.height).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
  expect(winBox?.width).toBeGreaterThanOrEqual(386);
  await expect(page.locator(site.room)).toHaveClass(/(^|\s)ui-room(\s|$)/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Wider than a phone: back to the scaled stage under the TV, chat in its desktop place.
  // (Under 1024 px: from there, landscape, it is the two-column wide layout, wide-layout.e2e.ts.)
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(async () => (await stageTransform(page)).scale).toBeLessThan(1.0001);
  await expect.poll(async () => (await page.locator(site.roomWindow).boundingBox())?.height).toBeGreaterThan(400);
});

test("touch targets: every key and field in the room is ≥ 44×44 CSS px to the finger", async ({ browser }) => {
  const page = await one(browser, "touch");
  await expect(page.locator(site.roomWindow)).toBeVisible();
  await expect(page.locator("#room-root")).toHaveClass(/(^|\s)ui-touch(\s|$)/);
  const targets = page.locator("#room-root :is(button, input, select, a[href]):visible");
  const n = await targets.count();
  expect(n).toBeGreaterThan(8);
  const misses: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = targets.nth(i);
    if ((await t.getAttribute("type")) === "hidden") continue;
    // Focus brings it into view (a seat pans the room window to it); then probe 21 px out each way from its centre.
    await t.focus();
    await frames(page);
    const r = await t.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const name = `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.getAttribute("class") ?? ""}]`;
      const out: string[] = [];
      for (const [dx, dy] of [[-21, 0], [21, 0], [0, -21], [0, 21]] as const) {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        if (hit === null || !(hit === el || el.contains(hit))) out.push(`${name} @(${String(dx)},${String(dy)}) → ${hit === null ? "nothing" : `${hit.tagName}.${hit.getAttribute("class") ?? ""}`}`);
      }
      return out;
    });
    misses.push(...r);
  }
  expect(misses).toEqual([]);
});

test("ADR 0012 at 360 px: the player is ≥ 356×200, full width, and nothing of ours covers it", async ({ browser }) => {
  const page = await one(browser, "narrow", phone(360));
  const tv = page.locator(site.tv);
  await expect(tv).toHaveClass(/(^|\s)compact(\s|$)/);
  const player = await tv.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const points = [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1], [r.left + r.width / 2, r.top + r.height / 2]] as const;
    const covered = points.filter(([x, y]) => {
      const t = document.elementFromPoint(x, y);
      return t === null || !el.contains(t);
    }).length;
    return { w: r.width, h: r.height, covered };
  });
  expect(player.w).toBeGreaterThanOrEqual(356);
  expect(player.h).toBeGreaterThanOrEqual(200);
  expect(player.covered).toBe(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the room window drags sideways, a tap on a seat still sits, and sitting centres the window on my seat", async ({ browser }) => {
  const page = await one(browser, "drag");
  const win = page.locator(site.roomWindow);
  await win.scrollIntoViewIfNeeded();
  await frames(page);
  const box = await win.boundingBox();
  if (box === null) throw new Error("no window");
  const before = await stageTransform(page);
  // A drag 80 px to the right shows more of the room's left side: the stage moves right with the finger.
  const y = box.y + 20;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 10, y);
  await page.mouse.up();
  const after = await stageTransform(page);
  expect(after.x - before.x).toBeGreaterThan(0);
  expect(after.x - before.x).toBeLessThanOrEqual(80);
  expect(after.scale).toBe(1);

  // A tap (no drag) on a free seat in view sits there; the window then centres on it.
  const seat = page.locator(`${site.seat}[data-occupied="false"]`).first();
  await seat.focus();
  await frames(page);
  await seat.tap();
  await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
  const mine = await page.locator(`${site.seat}.mine`).boundingBox();
  const winNow = await win.boundingBox();
  if (mine === null || winNow === null) throw new Error("not laid out");
  const cx = mine.x + mine.width / 2;
  expect(cx).toBeGreaterThanOrEqual(winNow.x);
  expect(cx).toBeLessThanOrEqual(winNow.x + winNow.width);
});

test("after a finger drag (no click follows it), the next keyboard Enter on a seat still sits (OME-614)", async ({ browser }) => {
  const page = await one(browser, "afterdrag");
  const win = page.locator(site.roomWindow);
  await win.scrollIntoViewIfNeeded();
  await frames(page);
  const box = await win.boundingBox();
  if (box === null) throw new Error("no window");
  const before = await stageTransform(page);
  // A real touch drag over CDP: Chrome fires no click after it, unlike a mouse drag.
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + 20);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - i * 8, y }] });
    await frames(page);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frames(page);
  expect((await stageTransform(page)).x).toBeLessThan(before.x);

  // One the window shows whole: a seat it crops is inert (OME-1325).
  const seat = page.locator(`${site.seat}[data-occupied="false"]:not([inert])`).first();
  await page.keyboard.press("Shift");
  await seat.focus();
  await frames(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
});

test("a two-finger pinch zooms the room around the fingers; the keys zoom out to the whole room and back; the zoom is kept on this device (OME-1184)", async ({ browser }) => {
  const page = await one(browser, "pinch");
  const win = page.locator(site.roomWindow);
  await win.scrollIntoViewIfNeeded();
  await frames(page);
  const box = await win.boundingBox();
  if (box === null) throw new Error("no window");
  expect((await stageTransform(page)).scale).toBe(1);
  // A real two-finger touch over CDP, spread sideways (a vertical swipe stays the page's): 80 px apart to 160.
  const cdp = await page.context().newCDPSession(page);
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  const fingers = (d: number) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(80) });
  for (let d = 90; d <= 160; d += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(d) });
    await frames(page);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frames(page);
  expect((await stageTransform(page)).scale).toBeCloseTo(2, 1);
  // The page itself didn't zoom: the browser's pinch-zoom is off over the room.
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

  // The keys, for people who can't pinch: fit shows the room's walls across the window (OME-2148), not the whole 960 px
  // stage with its empty sides; zoom in brings it closer.
  const fit = page.getByTestId("room-zoom-fit");
  await fit.tap();
  await frames(page);
  const fitScale = (await stageTransform(page)).scale;
  expect(fitScale * ROOM_WALLS.w).toBeLessThanOrEqual(box.width + 0.5);
  expect(fitScale * 960).toBeGreaterThan(box.width);
  // Zoomed all the way out, a name tag is still readable: at least 10 px of text on screen.
  const tagPx = await page.locator(site.nicknameTag).first().evaluate((el) => el.getBoundingClientRect().height);
  expect(tagPx).toBeGreaterThanOrEqual(15);
  await page.getByTestId("room-zoom-in").tap();
  await frames(page);
  const zoomed = (await stageTransform(page)).scale;
  expect(zoomed * 960).toBeGreaterThan(box.width);

  // It's this viewer's alone, kept in localStorage (room-window.test.ts reads it back), never sent.
  expect(Number(await page.evaluate(() => localStorage.getItem("omega.roomZoom")))).toBeCloseTo(zoomed, 5);
});

test("a downward swipe can't pull-to-refresh the room: the page itself has no overscroll; the pop-out page is 100dvh (OME-1240)", async ({ browser }) => {
  const page = await one(browser, "overscroll");
  for (const el of ["documentElement", "body"] as const) {
    expect(await page.evaluate((k) => getComputedStyle(document[k]).overscrollBehaviorY, el)).toMatch(/^(none|contain)$/);
  }
  // The pop-out page (room.css, loaded with the room) is 100dvh too, 100vh only as the fallback.
  const popout = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) if (rule instanceof CSSStyleRule && rule.selectorText === ".popout-page") return rule.style.height;
    }
    return null;
  });
  expect(popout).toBe("100dvh");
});

test("keyboard: Tab reaches every seat, a focused seat is panned into the window with a visible ring, Enter sits", async ({ browser }) => {
  const page = await one(browser, "keys");
  const seats = page.locator(site.seat);
  await expect(seats.first()).toBeAttached();
  const win = page.locator(site.roomWindow);
  const n = await seats.count();
  for (const i of [0, n - 1]) {
    const s = seats.nth(i);
    // A key press first, as a keyboard user's last input: then focus shows its ring (:focus-visible).
    await page.keyboard.press("Shift");
    await s.focus();
    await frames(page);
    const b = await s.boundingBox();
    const w = await win.boundingBox();
    if (b === null || w === null) throw new Error("not laid out");
    expect(b.x, `seat ${String(i)} left edge in the window`).toBeGreaterThanOrEqual(w.x);
    expect(b.x + b.width, `seat ${String(i)} right edge in the window`).toBeLessThanOrEqual(w.x + w.width + 0.5);
    expect(await s.evaluate((el) => getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)")).toBe(true);
  }
  await seats.first().press("Enter");
  await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
});

async function ownerOnPhone(browser: Browser): Promise<Page> {
  const { id, ownerToken, inviteKey } = ownedRoom("phone");
  const context = await watchCsp(await browser.newContext(PHONE));
  contexts.push(context);
  await context.addInitScript(
    ([origin, key, value]) => {
      if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
    },
    [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })],
  );
  await stubExternalNetwork(context);
  const page = await context.newPage();
  await page.goto(`${URLS.web}/r/${id}`);
  await page.locator(site.nicknameInput).fill("host");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  return page;
}

test("no editor on a phone: the owner gets one line in chat instead; on a wide screen the key is back", async ({ browser }) => {
  const page = await ownerOnPhone(browser);
  const line = page.locator(site.chatLogLine).filter({ hasText: "Arrange the room on a computer." });
  await expect(line).toHaveCount(1);
  await expect(page.locator(site.editRoom)).toHaveCount(0);
  // The edit chunk never loads on a phone.
  const editorChunk = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => /\/editor[-.]/.test(e.name)));
  expect(editorChunk).toBe(false);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(site.editRoom)).toBeVisible();
  await page.locator(site.editRoom).click();
  await expect(page.locator(site.editorTray)).toBeVisible();
  // Narrowing to a phone mid-edit closes the editor (the draft is the owner's to redo on a computer).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(site.editRoom)).toHaveCount(0);
  await expect(page.locator(site.editorTray)).toHaveCount(0);
  await expect(line).toHaveCount(1);
});

// Small phones (OME-1302, QA OME-1300 F2–F4): at 320 px the TV keeps YouTube's 200×200 within the screen, full screen
// keeps the strip on it, the zoom keys never sit on a seat, and an open People panel never leaves a sliver of a room.
const SMALL: BrowserContextOptions = { viewport: { width: 320, height: 640 } };

/**
 * axe target-size in the room window, plus what axe can't see. axe ignores overflow clipping (axe-core getTargetRects
 * takes the whole boundingClientRect), so a seat cut by the room pane's edge counts the zoom keys' band past that edge
 * as covering its cut-off part. Such a seat is checked by geometry instead: no zoom key meets the pane, so no key ever
 * covers what's drawn of a seat. Anything else axe finds is returned.
 */
async function targetSize(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).include(site.roomWindow).withRules(["target-size"]).analyze();
  const found = violations.flatMap((v) => v.nodes.map((n) => ({ target: String(n.target[0]), by: n.any.flatMap((c) => (c.relatedNodes ?? []).map((r) => String(r.target[0]))) })));
  return page.evaluate((found) => {
    const pane = document.querySelector(".stage-pane")?.getBoundingClientRect();
    if (pane === undefined) return ["no room pane"];
    const meets = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const out = [...document.querySelectorAll(".room-zoom > button")].filter((k) => meets(k.getBoundingClientRect(), pane)).map((k) => `${k.ariaLabel ?? "a zoom key"} meets the room pane`);
    const isKey = (sel: string): boolean => document.querySelector(sel)?.closest(".room-zoom") != null;
    for (const f of found) {
      const r = document.querySelector(f.target)?.getBoundingClientRect();
      const cut = r !== undefined && (r.left < pane.left || r.right > pane.right || r.top < pane.top || r.bottom > pane.bottom);
      if (!(cut && f.by.length > 0 && f.by.every(isKey))) out.push(f.target);
    }
    return out;
  }, found);
}

test("320×640: the TV is no wider than the screen, and the zoom keys cover no seat (QA OME-1300 F3)", async ({ browser }) => {
  const page = await one(browser, "small", SMALL);
  await expect(page.getByTestId("room-zoom-fit")).toBeVisible();
  const { right, inner } = await page.locator(site.tv).evaluate((e) => ({ right: e.getBoundingClientRect().right, inner: innerWidth }));
  expect(right).toBeLessThanOrEqual(inner);
  expect(await targetSize(page)).toEqual([]);
});

test("320×640 full screen: the strip and every key in full screen are on the screen (QA OME-1300 F2)", async ({ browser }) => {
  const page = await one(browser, "smallfs", SMALL);
  await page.locator(site.fullscreenToggle).click();
  await expect(page.locator(site.fsStrip)).toBeVisible();
  await frames(page);
  const off = await page.locator(site.fsRoot).evaluate((root) => {
    const keys = root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [data-testid="fs-strip"]');
    return [...keys]
      .filter((e) => e.checkVisibility({ visibilityProperty: true }))
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < 0 || r.right > innerWidth);
      })
      .map((e) => e.getAttribute("data-testid") ?? e.getAttribute("aria-label") ?? e.tagName);
  });
  expect(off).toEqual([]);
});

for (const [name, label, options] of [["people390", "390×844 touch", PHONE], ["people320", "320×640", SMALL]] as const) {
  test(`${label}, the People panel open: the room window is whole or gone, its zoom keys whole inside it (QA OME-1300 F4)`, async ({ browser }) => {
    const page = await one(browser, name, options);
    await page.locator(site.peopleKey).click();
    await expect(page.locator(site.peoplePanel)).toBeVisible();
    await frames(page);
    const win = page.locator(site.roomWindow);
    if (await win.isVisible()) {
      const w = await win.boundingBox();
      if (w === null) throw new Error("not laid out");
      // No partial strip: a window shows at least the column of zoom keys.
      expect(w.height).toBeGreaterThanOrEqual(96);
      for (const k of await page.locator('[data-testid^="room-zoom-"]').all()) {
        if (!(await k.isVisible())) continue;
        const b = await k.boundingBox();
        if (b === null) throw new Error("not laid out");
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.x).toBeGreaterThanOrEqual(w.x);
        expect(b.y).toBeGreaterThanOrEqual(w.y);
        expect(b.x + b.width).toBeLessThanOrEqual(w.x + w.width + 0.5);
        expect(b.y + b.height).toBeLessThanOrEqual(w.y + w.height + 0.5);
      }
    } else await expect(page.getByTestId("room-zoom-fit")).toBeHidden();
    expect(await targetSize(page)).toEqual([]);
  });
}

// A small portrait phone (OME-1612): at 360×640 the TV, shelf, panel keys, chat row and 44 px footer leave the room
// window ~100 px with the chat strip under it. On a short portrait screen that strip goes (the Chat key's sheet holds the
// log, bubbles still show in the room), so the room keeps ≥ 170 px and every seat shows whole, at 1×, without a pan.
test("360×640 touch: the room picture is ≥ 170 px tall, every seat is in it and a tap sits; the TV is full width 16:9 and the Chat sheet opens (OME-1612)", async ({ browser }) => {
  const page = await one(browser, "small360", { ...PHONE, viewport: { width: 360, height: 640 } });
  const tv = await page.locator(site.tv).boundingBox();
  if (tv === null) throw new Error("not laid out");
  expect(tv.width).toBe(360);
  expect(Math.abs(tv.height - (360 * 9) / 16)).toBeLessThanOrEqual(1);
  await frames(page);
  const pane = await page.locator(".stage-pane").boundingBox();
  if (pane === null) throw new Error("not laid out");
  expect(pane.height, "room picture height").toBeGreaterThanOrEqual(170);
  const seats = await page.locator(site.seat).all();
  expect(seats.length).toBeGreaterThan(0);
  for (const s of seats) {
    const b = await s.boundingBox();
    if (b === null) throw new Error("seat not laid out");
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    expect(cx >= pane.x && cx <= pane.x + pane.width && cy >= pane.y && cy <= pane.y + pane.height, "seat centre in the room picture").toBe(true);
  }
  // Tapping a seat sits (the avatar walks from the door), and the window then centres on it.
  const seat = page.locator(`${site.seat}[data-occupied="false"]`).first();
  await seat.focus();
  await frames(page);
  await seat.tap();
  await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(640);
  // The hidden strip is still a Tab stop (a scrollable log): focused, it shows again, so focus is never lost (QA OME-1614).
  const log = page.locator(site.chatLog);
  await log.focus();
  const shown = await log.boundingBox();
  expect(shown?.height ?? 0, "focused chat log height").toBeGreaterThanOrEqual(44);
  await log.blur();
  await page.getByTestId("portrait-chat").click();
  await expect(page.getByTestId("portrait-sheet")).toBeVisible();
  await expect(page.getByTestId("portrait-sheet").locator(site.chatLog)).toBeVisible();
});
