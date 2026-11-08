// The seat and floor hover cursor is painted on the room canvas from the UI atlas (OME-2307), not a CSS tint on the seat key.
import { expect, test } from "./support/csp";
import type { Locator, Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { roomCursor } from "./support/cursor";
import { site } from "./support/selectors";
import { STAGE_W, cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const seat = (page: Page, i: number): Locator => page.locator(`${site.seat}[data-seat="${String(i)}"]`);

/** Where the seat's box is centred, in viewport CSS px. */
async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("seat not laid out");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const centreOf = (r: { x: number; y: number; w: number; h: number } | undefined): { x: number; y: number } => (r === undefined ? { x: NaN, y: NaN } : { x: r.x + r.w / 2, y: r.y + r.h / 2 });

test("the seat cursor shows free, mine and taken from the atlas; the key keeps no tint", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "main").url, count: 2, nicknamePrefix: "cursor" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  expect(await roomCursor(a.page)).toBeNull();

  const at = await centre(seat(a.page, 0));
  await a.page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await roomCursor(a.page))?.kind).toBe("free");
  // The frame is anchored on its diamond's centre, which is the seat key's.
  const free = centreOf((await roomCursor(a.page))?.rect);
  expect(Math.abs(free.x - at.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(free.y - at.y)).toBeLessThanOrEqual(1.5);
  expect(await seat(a.page, 0).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

  await a.page.mouse.click(at.x, at.y);
  await expect(seat(a.page, 0)).toHaveClass(/mine/);
  await expect.poll(async () => (await roomCursor(a.page))?.kind).toBe("mine");

  const bt = await centre(seat(b.page, 0));
  await b.page.mouse.move(bt.x, bt.y);
  await expect(seat(b.page, 0)).toHaveAttribute("data-occupied", "true");
  await expect.poll(async () => (await roomCursor(b.page))?.kind).toBe("taken");

  await b.page.mouse.move(2, 2);
  await expect.poll(() => roomCursor(b.page)).toBeNull();
});

test("hovering the floor shows the free cursor on that cell", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "main").url, count: 1, nicknamePrefix: "floorcur" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  const box = await a.page.locator("canvas.scene").boundingBox();
  if (box === null) throw new Error("no canvas");
  const k = box.width / STAGE_W;
  const p = cellCenter(2, 2);
  const x = box.x + p.x * k;
  const y = box.y + p.y * k;
  await a.page.mouse.move(x, y);
  await expect.poll(async () => (await roomCursor(a.page))?.kind).toBe("free");
  const c = centreOf((await roomCursor(a.page))?.rect);
  expect(Math.abs(c.x - x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(c.y - y)).toBeLessThanOrEqual(1.5);
  await a.page.mouse.move(2, 2);
  await expect.poll(() => roomCursor(a.page)).toBeNull();
});

test("keyboard focus on a seat shows the cursor and keeps the focus ring", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "main").url, count: 1, nicknamePrefix: "keycur" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  // A key press first, so the focus counts as keyboard focus (:focus-visible).
  await a.page.keyboard.press("Shift");
  await seat(a.page, 1).focus();
  await expect(seat(a.page, 1)).toBeFocused();
  await expect.poll(async () => (await roomCursor(a.page))?.kind).toBe("free");
  expect(await seat(a.page, 1).evaluate((e) => getComputedStyle(e).outlineStyle)).toBe("solid");
  await seat(a.page, 1).blur();
  await expect.poll(() => roomCursor(a.page)).toBeNull();
});
