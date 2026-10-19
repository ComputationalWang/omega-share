// /poll watch-party polls (OME-1454, contract OME-1452, ADR 0055): the opener's /poll puts a card above everyone's chat
// log; votes show as live counts on every client; the opener closes it and the result lands in every log as a line.
// A bad /poll is a local hint. Test ids of the card are local to this spec (apps/web/src/chat/poll.ts).
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

const card = (page: Page) => page.locator('[data-testid="poll-card"]');
const option = (page: Page, i: number) => card(page).locator('[data-testid="poll-option"]').nth(i);

test("a poll: opened by one, voted by two, counts on all three, closed by the opener, result in every log", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("poll", "three").url, count: 3, nicknamePrefix: "poller" });
  const [a, b, c] = clients;
  if (a === undefined || b === undefined || c === undefined) throw new Error("no clients");
  const pages = [a.page, b.page, c.page];

  // A bad /poll is a hint to me only: nothing is sent.
  await say(a.page, "/poll no question mark");
  await expect(a.page.locator(site.chatLogLine).last()).toContainText("/poll");
  await expect(card(a.page)).toBeHidden();
  await expect(b.page.locator(site.chatLog)).not.toContainText("/poll");

  await say(a.page, "/poll Next video? A | B | C");
  for (const page of pages) {
    await expect(card(page)).toContainText("Next video?");
    await expect(card(page).locator('[data-testid="poll-option"]')).toHaveCount(3);
  }
  // Only the opener (here) sees Close.
  await expect(card(a.page).locator("button.poll-close")).toBeVisible();
  await expect(card(b.page).locator("button.poll-close")).toBeHidden();

  await option(b.page, 0).click();
  await option(c.page, 1).click();
  for (const page of pages) {
    await expect(option(page, 0).locator('[data-testid="poll-count"]')).toHaveText("1");
    await expect(option(page, 1).locator('[data-testid="poll-count"]')).toHaveText("1");
    await expect(option(page, 2).locator('[data-testid="poll-count"]')).toHaveText("0");
  }
  // My own vote is marked, only mine.
  await expect(option(b.page, 0)).toHaveAttribute("aria-pressed", "true");
  await expect(option(b.page, 1)).toHaveAttribute("aria-pressed", "false");
  await expect(option(a.page, 0)).toHaveAttribute("aria-pressed", "false");

  await card(a.page).locator("button.poll-close").click();
  for (const page of pages) {
    await expect(card(page)).toBeHidden();
    await expect(page.locator(site.chatLogLine).filter({ hasText: "Poll: Next video? — A 1 · B 1 · C 0" })).toHaveCount(1);
  }
});
