// Up next in the wide layout's side column (OME-1804, audit OME-1797, design OME-1799 §2). With a video on and one
// queued, a queue row's controls never sit over its title or its sharer's name; from 1024×768 the heading, Play next
// now and the count each keep one line; from 1280×800 the link field and the composer show their whole placeholder.
import type { Browser, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { WATCH_URL } from "./support/network";
import { URLS } from "./support/apps";
import { ownedRoom, type OwnedRoomName } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const OTHER_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const TOUCH = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

interface Box { x: number; y: number; width: number; height: number }
async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The number of line boxes an element's text lays out in. */
const lines = (l: Locator): Promise<number> =>
  l.evaluate((e) => {
    const r = document.createRange();
    r.selectNodeContents(e);
    return new Set([...r.getClientRects()].filter((c) => c.width > 0).map((c) => Math.round(c.top))).size;
  });

/** How many px the field's placeholder runs past its text box (≤ 0: it shows whole). */
const placeholderOver = (l: Locator): Promise<number> =>
  l.evaluate((e) => {
    if (!(e instanceof HTMLInputElement)) throw new Error("not an input");
    const s = getComputedStyle(e);
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx === null) throw new Error("no canvas");
    ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return ctx.measureText(e.placeholder).width - (e.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight));
  });

async function queued(browser: Browser, name: RoomName<"side-column">, options: BrowserContextOptions, owned?: OwnedRoomName): Promise<Page> {
  const room = owned === undefined ? undefined : ownedRoom(owned);
  clients = await joinRoom(browser, { roomUrl: room === undefined ? testRoom("side-column", name).url : `${URLS.web}/r/${room.id}`, count: 1,
    nicknamePrefix: `sc${name}${String(test.info().retry)}`, contextOptions: () => options,
    setup: room === undefined ? undefined : async (context) => { await context.addInitScript(([origin, key, value]) => {
      if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
    }, [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [room.id]: { ownerToken: room.ownerToken, inviteKey: room.inviteKey } } })]); } });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  const panel = page.locator(site.queuePanel);
  await expect(panel).toBeVisible();
  // The first link plays (an empty room starts it), the second waits under Up next.
  for (const [url, rows] of [[WATCH_URL, 0], [OTHER_URL, 1]] as const) {
    await page.locator(site.queueUrl).fill(url);
    await page.locator(site.queueAdd).click();
    await expect(page.locator(site.queueRow)).toHaveCount(rows);
  }
  await expect(page.locator(site.queueNext)).toBeVisible();
  return page;
}

const VIEWPORTS = [
  ["l844", 844, 390, TOUCH],
  ["t1024", 1024, 768, TOUCH],
  ["w1280", 1280, 800, {}],
  ["w1440", 1440, 900, {}],
  ["w1920", 1920, 1080, {}],
  ["w2560", 2560, 1440, {}],
] as const;

for (const [name, w, h, extra] of VIEWPORTS) {
  test(`${String(w)}×${String(h)}${"hasTouch" in extra ? " touch" : ""}: Up next's row, head and fields fit the side column`, async ({ browser }) => {
    const page = await queued(browser, name, { viewport: { width: w, height: h }, ...extra });
    const row = page.locator(site.queueRow).first();
    await expect(row.locator("[data-testid=queue-remove]")).toBeVisible();

    // 1. No control over the title or the sharer's name.
    const text = [await box(row.locator(".title")), await box(row.locator(".meta"))];
    for (const control of await row.locator(".ui-chip, button").all()) {
      const c = await box(control);
      for (const t of text) expect(overlap(c, t), `${await control.evaluate((e) => e.outerHTML.slice(0, 80))} over the row's text`).toBe(false);
    }

    // 2. From 1024×768 the head's words each keep one line.
    if (w >= 1024) for (const l of [page.locator(`${site.queuePanel} .queue-head h3`), page.locator(site.queueNext), page.locator(site.queueCount)]) expect(await lines(l)).toBe(1);

    // 3. From 1280×800 the link field and the composer say all of their placeholder.
    if (w >= 1280) for (const l of [page.locator(site.queueUrl), page.locator(site.chatInput)]) expect(await placeholderOver(l)).toBeLessThanOrEqual(0);
  });
}

// OME-1842 (responsive audit round 2): as the owner with a video on, the column stacked the invite, Up next, Edit room and
// Who controls playback above People, which got ~110 px (the shirt row only), and People open hid the chat log.
const OWNER_VIEWPORTS = [
  ["t1024", 1024, 768, TOUCH, "scownt"],
  ["w1280", 1280, 800, {}, "scownw"],
  ["w1920", 1920, 1080, {}, "scownx"],
  ["w2560", 2560, 1440, {}, "scowny"],
] as const;

for (const [name, w, h, extra, owned] of OWNER_VIEWPORTS) {
  test(`${String(w)}×${String(h)}${"hasTouch" in extra ? " touch" : ""}, the owner: People shows its look rows and first person, the chat keeps 3 lines, the owner's tools end the tab`, async ({ browser }) => {
    const page = await queued(browser, name, { viewport: { width: w, height: h }, ...extra }, owned);
    await expect(page.locator(site.editRoom)).toBeVisible();
    const tv = await box(page.locator(site.tv));
    await page.locator(site.peopleKey).click();
    const panel = page.locator(site.peoplePanel);
    await expect(panel).toBeVisible();
    await expect(page.locator(site.peopleRow).first()).toBeVisible();
    await page.waitForTimeout(300);

    // 1. The shirt, hair and accessory rows and the first person show without scrolling; the TV stays put.
    expect(await panel.evaluate((e) => e.scrollTop)).toBe(0);
    const p = await box(panel);
    const bottom = Math.min(p.y + p.height, h);
    for (const l of [...await panel.locator(".look > *").all(), page.locator(site.peopleRow).first()]) {
      const b = await box(l);
      expect(b.y + b.height, `${await l.evaluate((e) => e.className)} shows whole`).toBeLessThanOrEqual(bottom + 0.5);
    }
    expect(await panel.locator(".look > *").count()).toBeGreaterThanOrEqual(3);
    expect(await box(page.locator(site.tv))).toEqual(tv);

    // 2. The chat log keeps at least three lines beside People.
    const log = page.locator(site.chatLog);
    await expect(log).toBeVisible();
    const lb = await box(log);
    const lh = await log.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.2);
    expect(lb.height).toBeGreaterThanOrEqual(3 * lh);
    expect(lb.y + lb.height).toBeLessThanOrEqual(h);

    // 3. The owner's tools end the People tab instead of sitting above it.
    const edit = page.locator(site.editRoom);
    expect((await box(edit)).y).toBeGreaterThan(p.y);
    await edit.scrollIntoViewIfNeeded();
    await expect(edit).toBeInViewport();

    await page.locator(site.peopleKey).click();
    await expect(panel).toBeHidden();
    expect(await box(page.locator(site.tv))).toEqual(tv);
  });
}
