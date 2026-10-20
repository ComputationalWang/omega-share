// Arriving through the door (OME-1558, ADR 0054 amendment): Go on a door chip sends the room I left as `join.via`, and
// the next room places me in front of its door back. Rooms doors-a and doors-b are seeded with a door to each other at
// (0, 3), its front (1, 3) (fixtures/seed-rooms.ts).
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { TAG_OFFSET_Y, cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const FRONT = [1, 3] as const;
const DOOR_OPEN = { key: "furniture/door/wood/se/back", frame: 0 };
/** A walk in from the front corner (9, 9) to (1, 3) takes over 4 s; a door arrival is there at once. */
const AT_ONCE_MS = 2500;

/** Where a nickname tag hangs when its avatar rests on cell (x, y). */
const restOn = (x: number, y: number): string => {
  const p = cellCenter(x, y);
  return `${String(Math.round(p.x))}px ${String(Math.round(p.y + TAG_OFFSET_Y))}px`;
};
const tagAt = (page: Page, nickname: string): Promise<string> => page.locator(site.nicknameTag).filter({ hasText: nickname }).evaluate((el) => (el as HTMLElement).style.translate);

/** The furniture loops running now (room-view.ts `loops`): idle key and frame shown. */
const loops = (page: Page): Promise<unknown> =>
  page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const fn: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "furnitureLoops") : null;
    return typeof fn === "function" ? (Reflect.apply(fn, room, []) as unknown) : null;
  });

async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator(site.walkFloor).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const p = cellCenter(x, y);
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

test("going through A's door to B lands me at B's door back to A, for me and for whoever is in B", async ({ browser }) => {
  const a = testRoom("doors", "a");
  const b = testRoom("doors", "b");
  const [watcher] = await joinRoom(browser, { roomUrl: b.url, count: 1, nicknamePrefix: "stay" });
  const [walker] = await joinRoom(browser, { roomUrl: a.url, count: 1, nicknamePrefix: "hall" });
  if (watcher === undefined || walker === undefined) throw new Error("need two clients");
  clients = [watcher, walker];
  await walker.page.waitForTimeout(6000); // walked in from the corner
  await clickCell(walker.page, ...FRONT);
  await expect(walker.page.locator(site.doorGo)).toBeVisible({ timeout: 20_000 });
  await walker.page.locator(site.doorGo).click();
  await expect(walker.page).toHaveURL(new RegExp(`/r/${b.id}$`));
  // The via is in this tab's sessionStorage, never in the URL.
  expect(new URL(walker.page.url()).search).toBe("");
  await walker.page.locator(site.nicknameInput).fill("hall-1");
  await walker.page.locator(site.avatarOption).first().click();
  await walker.page.locator(site.joinButton).click();
  await walker.page.locator(site.room).waitFor();
  for (const page of [walker.page, watcher.page]) {
    await expect.poll(() => tagAt(page, "hall-1"), { timeout: AT_ONCE_MS }).toBe(restOn(...FRONT));
    await expect.poll(() => loops(page)).toContainEqual(DOOR_OPEN);
  }
});
