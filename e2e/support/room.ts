// N browser contexts joining one room with different nicknames and avatars.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { site } from "./selectors";
import { stubExternalNetwork } from "./network";

export interface Client {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly nickname: string;
  readonly avatarIndex: number;
}

export interface JoinOptions {
  /** Absolute room URL on the site. */
  readonly roomUrl: string;
  readonly count: number;
  readonly nicknamePrefix?: string;
}

export async function joinRoom(browser: Browser, { roomUrl, count, nicknamePrefix = "tester" }: JoinOptions): Promise<Client[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const context = await browser.newContext();
      await stubExternalNetwork(context);
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
