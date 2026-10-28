// The touch window's home (OME-1930, OME-1843 follow-up): phones and touch tablets looked at the seats only, so whoever
// stood at the front (everyone who just joined) had their name tag at or under the window's foot, 0–1 px of 20. It looks
// at the audience now, and keeps my own standing avatar whole. The geometry is apps/web/test/touch-home.test.ts.
import type { BrowserContextOptions, Locator } from "@playwright/test";
import { expect, test } from "./support/csp";
import { presetFile, showLayout } from "../perf/show-layout";
import { shareVideo, waitPlaying } from "../perf/sync";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { EMBED_URL } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const TOUCH = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}

/** Every name tag wholly inside the room window, once everyone has walked to their spot. */
async function tagsWhole(window: Locator, tags: Locator): Promise<void> {
  await expect(async () => {
    const w = await box(window);
    for (const tag of await tags.all()) {
      const t = await box(tag);
      expect(t.y).toBeGreaterThanOrEqual(w.y);
      expect(t.y + t.height).toBeLessThanOrEqual(w.y + w.height);
      expect(t.x).toBeGreaterThanOrEqual(w.x);
      expect(t.x + t.width).toBeLessThanOrEqual(w.x + w.width);
    }
  }).toPass({ timeout: 10_000 });
}

for (const [name, w, h] of [["j320", 320, 640], ["j844", 844, 390]] as const) {
  test(`${String(w)}×${String(h)} touch, Theatre: on joining my own name tag is whole in the room window`, async ({ browser }) => {
    const theatre = presetFile("cinema");
    clients = await joinRoom(browser, { roomUrl: testRoom("touch-home", name).url, count: 1, nicknamePrefix: `th${name}`, setup: (context) => showLayout(context, theatre), contextOptions: () => TOUCH(w, h) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    const tags = page.locator(site.nicknameTag);
    await expect(tags).toHaveCount(1);
    await tagsWhole(page.locator(site.roomWindow), tags);
  });
}

for (const [name, w, h] of [["aud1024", 1024, 768], ["aud768", 768, 1024]] as const) {
  test(`${String(w)}×${String(h)} touch, Theatre with a video and 4 people: every front-row name tag is whole in the room window`, async ({ browser, request }) => {
    const room = testRoom("touch-home", name);
    await shareVideo(request, room.id);
    const theatre = presetFile("cinema");
    clients = await joinRoom(browser, { roomUrl: room.url, count: 4, nicknamePrefix: `th${name}`, setup: (context) => showLayout(context, theatre), contextOptions: () => TOUCH(w, h) });
    await waitPlaying(clients);
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    const tags = page.locator(site.nicknameTag);
    await expect(tags).toHaveCount(4);
    await tagsWhole(page.locator(site.roomWindow), tags);
  });
}

// OME-1945 (responsive audit round 4): at 320×640 the window shows a slice of the stage, and a bubble kept only inside
// the stage was cut by the window's edge (ada's, the leftmost). Once everyone stands, every tag and every bubble is
// whole across the window (the last guest's tag 1.5 s in was its walk from the door, not where it ends). Across, the
// 268 px window holds the seats and me (OME-1930), not every guest: a tag beside it may be out of the window.
test("320×640 touch, Theatre with a video and 4 people: every name tag whole top to bottom once they stand, and every bubble whole across the window", async ({ browser, request }) => {
  const room = testRoom("touch-home", "bub320");
  await shareVideo(request, room.id);
  clients = await joinRoom(browser, { roomUrl: room.url, count: 4, nicknamePrefix: "thbub", setup: (context) => showLayout(context, presetFile("cinema")), contextOptions: () => TOUCH(320, 640) });
  await waitPlaying(clients);
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  const window = page.locator(site.roomWindow);
  await expect(page.locator(site.nicknameTag)).toHaveCount(4);
  await expect(async () => {
    const w = await box(window);
    for (const tag of await page.locator(site.nicknameTag).all()) {
      const t = await box(tag);
      expect(t.y).toBeGreaterThanOrEqual(w.y);
      expect(t.y + t.height).toBeLessThanOrEqual(w.y + w.height);
    }
  }).toPass({ timeout: 10_000 });
  for (const [i, c] of clients.entries()) {
    await c.page.locator(site.chatInput).fill(`hi from guest ${String(i)}, the row is full`);
    await c.page.locator(site.chatInput).press("Enter");
  }
  await expect(page.locator(".ui-float.is-live")).toHaveCount(4);
  await expect(async () => {
    const w = await box(window);
    for (const b of await page.locator(".ui-float.is-live").all()) {
      const r = await box(b);
      expect(r.x).toBeGreaterThanOrEqual(w.x);
      expect(r.x + r.width).toBeLessThanOrEqual(w.x + w.width);
    }
  }).toPass({ timeout: 5_000 });
});

// OME-1944 (responsive audit round 4): as owner (title and owner bar over the TV) with a video at 1024×768 t, the window
// was fitted to the column's foot (OME-1929's 844×390 fix) and grew to 270 px: the reaction keys under it were cut to
// 10 px by the room column. The window keeps the wrap's height where that holds it; the keys stay whole and tappable.
test("1024×768 touch, the owner with a video in Theatre: all four reaction keys are whole and tappable", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("tabvid");
  const theatre = presetFile("cinema");
  clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}`, count: 1, nicknamePrefix: "thtabvid", contextOptions: () => TOUCH(1024, 768),
    setup: async (context) => {
      await showLayout(context, theatre);
      await context.addInitScript(([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      }, [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })]);
    } });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.roomTitle)).toBeVisible();
  await page.locator(site.queueUrl).fill(EMBED_URL);
  await page.locator(site.queueAdd).click();
  await waitPlaying(clients);
  for (const k of ["heart", "laugh", "wow", "clap"]) {
    const key = page.locator(`[data-testid=reaction-${k}]`);
    await expect(key).toBeInViewport({ ratio: 1 });
    expect(await key.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (hit === node || node.contains(hit));
    }), k).toBe(true);
  }
  // The window keeps OME-1930: my standing avatar's tag whole in it.
  await tagsWhole(page.locator(site.roomWindow), page.locator(site.nicknameTag));
});
