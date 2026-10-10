// N browser contexts joining one room with different nicknames and avatars.
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { URLS } from "./apps";
import { site } from "./selectors";
import { testRoomId, type RoomName, type RoomSpec } from "./test-rooms";
import { watchCsp } from "./csp";
import { stubExternalNetwork } from "./network";
import { throttleContext } from "./load";

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

/** `spec`'s seeded room `name` (e2e/support/test-rooms.ts). */
export function testRoom<S extends RoomSpec>(spec: S, name: RoomName<S>): TestRoom {
  const id = testRoomId(spec, name);
  return { id, url: `${URLS.web}/r/${id}` };
}

export interface JoinOptions {
  /** Absolute room URL on the site. */
  readonly roomUrl: string;
  readonly count: number;
  readonly nicknamePrefix?: string;
  /** Runs on each new context after the network stub and before the page opens, e.g. to add routes (later routes win). */
  readonly setup?: (context: BrowserContext, index: number) => Promise<void>;
  /** Context options per client, e.g. a phone (`devices["Pixel 7"]`) for some of them. */
  readonly contextOptions?: (index: number) => BrowserContextOptions | undefined;
}

export async function joinRoom(browser: Browser, { roomUrl, count, nicknamePrefix = "tester", setup, contextOptions }: JoinOptions): Promise<Client[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const context = await watchCsp(await browser.newContext(contextOptions?.(i)));
      await stubExternalNetwork(context);
      throttleContext(context);
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
 * Clicks a key that closes its own window and waits for the close. The window can go before the click's input round
 * trip returns, which Playwright reports as "Target page, context or browser has been closed" (OME-674); that error is
 * the expected outcome here, any other one is not.
 */
export async function clickClosing(page: Page, target: Locator): Promise<void> {
  const closed = page.waitForEvent("close");
  await Promise.all([
    closed,
    target.click().catch((e: unknown) => {
      if (!(e instanceof Error && e.message.includes("Target page, context or browser has been closed"))) throw e;
    }),
  ]);
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
