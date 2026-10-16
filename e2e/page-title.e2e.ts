// Page titles (OME-1238, WCAG 2.4.2): each view says where you are in the tab, and a hidden room tab counts what others
// said since you looked away. The room title's format is a unit test (apps/web/test/page-title.test.ts).
import type { Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { openDirectory } from "./support/directory";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, type Client } from "./support/room";
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

/** Playwright's page never hides on its own: stand in for a tab switch, the way the browser reports one. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("the entry form, the directory and Room not found each have their own title", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext());
  await stubExternalNetwork(context);
  const page = await context.newPage();
  try {
    await page.goto(URLS.web);
    await expect(page).toHaveTitle("Pick a nickname · omega-share");
    await openDirectory(page, "title-1");
    await expect(page).toHaveTitle("Find or create a room · omega-share");
    await page.goto(`${URLS.web}/r/no-such-room-title`);
    await page.locator(site.nicknameInput).fill("title-2");
    await page.locator(site.joinButton).click();
    await expect(page.locator(site.notFound)).toBeVisible();
    await expect(page).toHaveTitle("Room not found · omega-share");
  } finally {
    await context.close();
  }
});

test("a hidden room tab counts others' chat in its title, not mine or system lines; looking back clears it", async ({ browser }) => {
  const { id, title, inviteKey } = ownedRoom("pagetitle");
  clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}#k=${inviteKey}`, count: 2, nicknamePrefix: "pt" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  const base = `${title} · omega-share`;
  await expect(a.page).toHaveTitle(base);

  // Visible: nothing counts.
  await say(b.page, "while you look");
  await expect(a.page.locator(site.chatLogLine)).toHaveCount(1);
  await expect(a.page).toHaveTitle(base);

  await setHidden(a.page, true);
  await say(b.page, "one");
  await expect(a.page).toHaveTitle(`(1) ${base}`);
  await say(b.page, "two");
  await expect(a.page).toHaveTitle(`(2) ${base}`);
  // My own line and a system line (b leaves) don't count.
  await say(a.page, "mine");
  await expect(a.page.locator(site.chatLogLine)).toHaveCount(4);
  await b.context.close();
  await expect(a.page.locator(site.chatLogLine)).toHaveCount(5);
  await expect(a.page).toHaveTitle(`(2) ${base}`);

  await setHidden(a.page, false);
  await expect(a.page).toHaveTitle(base);
});
