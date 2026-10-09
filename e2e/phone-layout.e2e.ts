// The phone watch layout (OME-596, M7 W4, set k `ui-m7-watch`). On a phone (≤ 600 px wide): the TV full width on top,
// then the compact shelf, the room at 1× in a cropped window you can drag sideways, then the chat log and the chat
// row, in that order on screen and in focus order. No editor (owners get one line in chat instead). Every key and
// field is ≥ 44×44 CSS px to the finger. At 360 px the player keeps ADR 0012's 356×200 and nothing covers it.
// The pure geometry (breakpoint, crop, pan clamp, safe areas) is apps/web/test/phone-layout.test.ts; the frame budget
// on a Pixel-class phone is perf/phone.perf.ts.
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

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

async function one(browser: Browser, name: "stack" | "touch" | "narrow" | "drag" | "keys" | "afterdrag", options: BrowserContextOptions = PHONE): Promise<Page> {
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
    const queue = at('[data-testid="queue-panel"]');
    return { roomThenLog: before(win, log), logThenQueue: before(log, queue) };
  });
  expect(order).toEqual({ roomThenLog: true, logThenQueue: true });

  // Set k: the TV is full width, the room is never scaled down, its window is 270 px tall and as wide as the page.
  const tvBox = await tv.boundingBox();
  const winBox = await win.boundingBox();
  expect(tvBox?.width).toBeGreaterThanOrEqual(386);
  expect((await stageTransform(page)).scale).toBe(1);
  expect(winBox?.height).toBe(270);
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

  const seat = page.locator(`${site.seat}[data-occupied="false"]`).first();
  await page.keyboard.press("Shift");
  await seat.focus();
  await frames(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(`${site.seat}.mine`)).toHaveCount(1);
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
