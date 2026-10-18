// /roll dice (OME-1426, contract OME-1423): the server rolls; every client shows "🎲 n / sides" over the roller (the
// aria-hidden bubble layer) and a log line anyone can read back ("Sam rolled 17 (d20)"). A bad /roll is a local hint.
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

test("/roll d20 shows the same roll on both clients: a bubble over the roller and a log line", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("roll", "two").url, count: 2, nicknamePrefix: "dice" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");

  await say(a.page, "/roll 1");
  await expect(a.page.locator(site.chatLogLine).last()).toContainText("/roll");
  await expect(b.page.locator(site.chatLog)).not.toContainText("rolled");

  await say(a.page, "/roll d20");
  const theirs = b.page.locator(site.chatLogLine).filter({ hasText: /rolled \d+ \(d20\)/ });
  await expect(theirs).toHaveCount(1);
  const value = /rolled (\d+) \(d20\)/.exec(await theirs.innerText())?.[1];
  if (value === undefined) throw new Error("no value");
  expect(Number(value)).toBeGreaterThanOrEqual(1);
  expect(Number(value)).toBeLessThanOrEqual(20);
  await expect(theirs).toContainText(`${a.nickname} rolled ${value} (d20)`);
  await expect(a.page.locator(site.chatLogLine).filter({ hasText: /rolled \d+ \(d20\)/ })).toContainText(`You rolled ${value} (d20)`);
  for (const page of [a.page, b.page]) await expect(page.locator(".ui-float").filter({ hasText: `🎲 ${value} / 20` })).toHaveCount(1);
  // Nothing went out as chat: system lines only (the hint itself names /roll, so check the kind of line, not its text).
  for (const page of [a.page, b.page]) await expect(page.locator(`${site.chatLog} .ui-fs-line`)).toHaveCount(0);
});
