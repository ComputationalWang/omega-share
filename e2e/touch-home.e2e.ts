// The touch window's home (OME-1930, OME-1843 follow-up): phones and touch tablets looked at the seats only, so whoever
// stood at the front (everyone who just joined) had their name tag at or under the window's foot, 0–1 px of 20. It looks
// at the audience now, and keeps my own standing avatar whole. The geometry is apps/web/test/touch-home.test.ts.
import type { BrowserContextOptions, Locator } from "@playwright/test";
import { expect, test } from "./support/csp";
import { presetFile, showLayout } from "../perf/show-layout";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
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
