// N browser contexts joining one room with different nicknames and avatars.
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { URLS } from "./apps";
import { site } from "./selectors";
import { specRoomIds, type RoomSpec } from "./test-rooms";
import { watchCsp } from "./csp";
import { stubExternalNetwork } from "./network";

export interface Client {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly nickname: string;
  readonly avatarIndex: number;
}

export interface TestRoom {
  readonly id: string;
  /** Absolute room URL on the site. */
  readonly url: string;
}

/**
 * Hands out `spec`'s seeded rooms (e2e/support/test-rooms.ts) in order, one per call. Call it once per test in a
 * serial spec; a retry re-imports the spec and starts over, and every test shares its video first anyway.
 */
export function roomsFor(spec: RoomSpec): () => TestRoom {
  const ids = specRoomIds(spec);
  let next = 0;
  return () => {
    const id = ids[next++];
    if (id === undefined) throw new Error(`${spec} used all ${String(ids.length)} of its rooms: raise SPEC_ROOMS["${spec}"] in e2e/support/test-rooms.ts`);
    return { id, url: `${URLS.web}/r/${id}` };
  };
}

export interface JoinOptions {
  /** Absolute room URL on the site. */
  readonly roomUrl: string;
  readonly count: number;
  readonly nicknamePrefix?: string;
  /** Runs on each new context after the network stub and before the page opens, e.g. to add routes (later routes win). */
  readonly setup?: (context: BrowserContext, index: number) => Promise<void>;
}

export async function joinRoom(browser: Browser, { roomUrl, count, nicknamePrefix = "tester", setup }: JoinOptions): Promise<Client[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const context = await watchCsp(await browser.newContext());
      await stubExternalNetwork(context);
      await setup?.(context, i);
      const page = await context.newPage();
      await page.goto(roomUrl);
      const nickname = `${nicknamePrefix}-${String(i + 1)}`;
      await page.locator(site.nicknameInput).fill(nickname);
      const avatars = page.locator(site.avatarOption);
      const avatarIndex = i % Math.max(1, await avatars.count());
      await avatars.nth(avatarIndex).click();
      await page.locator(site.joinButton).click();
      await page.locator(site.room).waitFor();
      return { context, page, nickname, avatarIndex };
    }),
  );
}

export async function leaveAll(clients: readonly Client[]): Promise<void> {
  await Promise.all(clients.map((c) => c.context.close()));
}

/**
 * Click after scrolling `target` into view and letting two frames land. Right after a programmatic scroll,
 * Chromium can route the click by the previous frame's hit-test data, so a seat that scrolls up to where the
 * cross-origin TV iframe just was gets its click delivered to the iframe instead (OME-89). Users scroll first
 * and click later, so only instant scroll-then-click automation needs this.
 */
export async function clickSettled(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve();
        }));
      }),
  );
  await target.click();
}
