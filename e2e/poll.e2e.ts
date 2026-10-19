// /poll watch-party polls (OME-1454, contract OME-1452, ADR 0055): the opener's /poll puts a card above everyone's chat
// log; votes show as live counts on every client; the opener closes it and the result lands in every log as a line.
// A bad /poll is a local hint. Test ids of the card are local to this spec (apps/web/src/chat/poll.ts).
import type { BrowserContext, Page } from "@playwright/test";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
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

// QA OME-1457: the card is one more child of the full-screen strip and the pop-out's 3-row grids; the log must keep the
// stretching row, so the history stays readable for the whole poll. Collapsed to the band, the card waits for the strip.
test("an open poll keeps the log as the tall row in the full-screen strip, the band and the chat pop-out", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("poll", "three").url, count: 2, nicknamePrefix: "poller" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await say(b.page, "/poll Next? One | Two");
  await expect(card(a.page)).toBeVisible();

  const taller = async (page: Page, scope: string): Promise<void> => {
    const c = await page.locator(scope).locator('[data-testid="poll-card"]').boundingBox();
    const log = await page.locator(scope).locator(site.chatLog).boundingBox();
    if (c === null || log === null) throw new Error("no boxes");
    expect(log.height).toBeGreaterThan(c.height);
  };

  await a.page.locator(site.fullscreenToggle).click();
  await expect(a.page.locator(site.fsStrip).locator('[data-testid="poll-card"]')).toBeVisible();
  await taller(a.page, site.fsStrip);
  await a.page.locator(site.fsStripToggle).click();
  await expect(a.page.locator(site.fsStrip)).toHaveAttribute("data-strip", "band");
  await expect(card(a.page)).toBeHidden();
  await a.page.locator(site.fsStripToggle).click();
  await expect(card(a.page)).toBeVisible();
  await a.page.locator(site.fullscreenToggle).click();

  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.chatPopout).click()]);
  await pop.waitForLoadState();
  await expect(card(pop)).toBeVisible();
  await taller(pop, ".popout");
});

// QA OME-1460: in a private room the owner's side column also holds the invite row, Up next and the owner's bar; at a
// laptop's 1280×720 an open 4-option poll pushed Close poll and the composer below the fold, out of reach.
test("the owner of a private room at 1280×720 reaches Close poll, the last option and the composer of a guest's poll", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("pollowner");
  const contexts: BrowserContext[] = [];
  const open = async (secrets: string | null, nickname: string): Promise<Page> => {
    const context = await watchCsp(await browser.newContext({ viewport: { width: 1280, height: 720 } }));
    contexts.push(context);
    if (secrets !== null) {
      await context.addInitScript(
        ([origin, key, value]) => {
          if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
        },
        [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
      );
    }
    await stubExternalNetwork(context);
    const page = await context.newPage();
    await page.goto(`${URLS.web}/r/${id}${secrets === null ? `#k=${inviteKey}` : ""}`);
    await page.locator(site.nicknameInput).fill(nickname);
    await page.locator(site.joinButton).click();
    await expect(page.locator(site.room)).toBeVisible();
    return page;
  };
  try {
    const owner = await open(JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } }), "host");
    const guest = await open(null, "kit");
    await say(guest, "/poll Sizes? A | B | C | D");
    await expect(card(owner).locator('[data-testid="poll-option"]')).toHaveCount(4);
    await expect(owner.locator(site.editRoom)).toBeVisible();
    await expect(card(owner).locator("button.poll-close")).toBeInViewport({ ratio: 1 });
    await expect(owner.locator(site.chatInput)).toBeInViewport({ ratio: 1 });
    // The log keeps a few lines beside the card.
    expect((await owner.locator(site.chatLog).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(60);
    // The last option is reachable (the options may scroll inside the card) and votes.
    await option(owner, 3).click();
    await expect(option(guest, 3).locator('[data-testid="poll-count"]')).toHaveText("1");
    await expect(card(owner).locator("button.poll-close")).toBeInViewport({ ratio: 1 });
    await card(owner).locator("button.poll-close").click();
    await expect(card(guest)).toBeHidden();
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
  }
});
