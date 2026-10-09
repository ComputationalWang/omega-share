// The extension's "Add to queue" (OME-510 Q1, X1 OME-509, ADR 0031): the popup's second button posts the page's embed to
// `POST /rooms/:id/queue` with the room tab's share token. Into a room where a video plays it lands in the "Up next" list
// of every web client and the TV keeps playing; into an empty room it starts playing (ADR 0031 §5, OME-539).
// Each test (and --repeat-each round) has an owned private room of its own (support/owned-rooms.ts), reached through the invite link, so nothing
// here is POST /rooms. A room that already played in an earlier attempt isn't empty any more: run with --retries=0.
import type { BrowserContext, Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { gotoFixture } from "./support/network";
import { ownedRoom, type OwnedRoomName } from "./support/owned-rooms";
import { joinRoom, leaveAll, type Client } from "./support/room";
import { popup, site } from "./support/selectors";

test.fixme(!available.extension, PENDING.extension);
test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const VIMEO_EMBED = "https://player.vimeo.com/video/76979871?h=8272103f6e";
const TWITCH_VOD_EMBED = "https://player.twitch.tv/?video=v1234567890";

/** One room per --repeat-each round: a room that played isn't empty or clean again (the seeded set has three of each). */
const roomFor = (kind: "play" | "emp", repeatEachIndex: number): OwnedRoomName => {
  const names = kind === "play" ? (["extqplaya", "extqplayb", "extqplayc"] as const) : (["extqempa", "extqempb", "extqempc"] as const);
  const name = names[repeatEachIndex];
  if (name === undefined) throw new Error("--repeat-each above 3: add owned rooms");
  return name;
};

let observers: Client[] = [];
test.afterEach(async () => {
  await leaveAll(observers);
  observers = [];
});

/** Opens the room as a member in the extension's browser: that puts a share token in the tab's sessionStorage. */
async function joinInTab(context: BrowserContext, name: OwnedRoomName): Promise<{ tab: Page; roomId: string; url: string }> {
  const room = ownedRoom(name);
  const url = `${URLS.web}/r/${room.id}#k=${room.inviteKey}`;
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.locator(site.nicknameInput).fill("ext-member");
  await tab.locator(site.joinButton).click();
  await expect(tab.locator(site.room)).toBeVisible();
  return { tab, roomId: room.id, url };
}

/** Pick `value` in the popup opened on `source`, aim it at `roomId`, press `button`, and return the status line. */
async function useButton(openPopup: (target: Page) => Promise<Page>, source: Page, roomId: string, value: string, button: "queueButton" | "shareButton"): Promise<Page> {
  const p = await openPopup(source);
  await expect(p.locator(popup.roomSelect).locator(`option[value="${roomId}"]`)).toHaveCount(1);
  await p.locator(popup.roomSelect).selectOption(roomId);
  await p.locator(`${popup.embedItem} input[name=embed][value="${value}"]`).check();
  await expect(p.locator(popup[button])).toBeEnabled();
  await p.locator(popup[button]).click();
  await expect(p.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
  return p;
}

test("Add to queue from the popup puts the page's video in the Up next list of every client; the playing video stays", async ({ context, browser, openPopup }, info) => {
  test.setTimeout(90_000);
  const { tab, roomId, url } = await joinInTab(context, roomFor("play", info.repeatEachIndex));
  observers = await joinRoom(browser, { roomUrl: url, count: 2, nicknamePrefix: "xq" });
  const [x, y] = observers;
  if (x === undefined || y === undefined) throw new Error("need two observers");
  const everyone = [tab, x.page, y.page];

  // A video already plays: shared from a page with a YouTube embed through the popup's Share.
  const yt = await context.newPage();
  await gotoFixture(yt, "youtube-embed");
  const shared = await useButton(openPopup, yt, roomId, "https://www.youtube.com/embed/aqz-KE-bpKQ", "shareButton");
  await expect(shared.locator(popup.shareStatus)).toHaveText(`Shared to ${roomId}.`);
  for (const page of everyone) {
    await expect(page.locator(site.sharedVideo)).toHaveAttribute("src", /\/embed\/aqz-KE-bpKQ/);
    await expect(page.locator(site.queueRow)).toHaveCount(0);
  }

  // Queue a Vimeo embed from another page: a row everywhere, in the list not on the TV.
  const source = await context.newPage();
  await gotoFixture(source, "providers-embed");
  const queued = await useButton(openPopup, source, roomId, VIMEO_EMBED, "queueButton");
  await expect(queued.locator(popup.shareStatus)).toHaveText(`Added to the queue in ${roomId}.`);
  for (const page of everyone) {
    await expect(page.locator(site.queueRow)).toHaveCount(1);
    await expect(page.locator(site.queueCount)).toHaveText("1 / 20");
    await expect(page.locator(site.queueRow).first()).toContainText("Vimeo");
    await expect(page.locator(site.sharedVideo)).toHaveAttribute("src", /\/embed\/aqz-KE-bpKQ/);
  }

  // A second add lands behind the first.
  await useButton(openPopup, source, roomId, TWITCH_VOD_EMBED, "queueButton");
  for (const page of everyone) {
    await expect(page.locator(site.queueRow)).toHaveCount(2);
    await expect(page.locator(site.queueRow).first()).toContainText("Vimeo");
    await expect(page.locator(site.queueRow).nth(1)).toContainText("Twitch");
  }
  const first = await x.page.locator(site.queueRow).evaluateAll((els) => els.map((e) => (e instanceof HTMLElement ? (e.dataset["item"] ?? "") : "")));
  expect(first).toHaveLength(2);
  for (const page of [tab, y.page]) {
    expect(await page.locator(site.queueRow).evaluateAll((els) => els.map((e) => (e instanceof HTMLElement ? (e.dataset["item"] ?? "") : "")))).toEqual(first);
  }

  // Play next brings the queued Vimeo video on for everyone.
  await x.page.locator(site.queueNext).click();
  for (const page of everyone) {
    await expect(page.locator(site.sharedVideo)).toHaveAttribute("src", /player\.vimeo\.com\/video\/76979871/);
    await expect(page.locator(site.queueRow)).toHaveCount(1);
  }
});

test("Add to queue into an empty room starts the video on every client (ADR 0031 §5)", async ({ context, browser, openPopup }, info) => {
  test.setTimeout(90_000);
  const { tab, roomId, url } = await joinInTab(context, roomFor("emp", info.repeatEachIndex));
  observers = await joinRoom(browser, { roomUrl: url, count: 2, nicknamePrefix: "xs" });
  const [x] = observers;
  if (x === undefined) throw new Error("need an observer");
  const everyone = [tab, x.page];
  for (const page of everyone) {
    await expect(page.locator(site.sharedVideo)).toHaveCount(0);
    await expect(page.locator(site.queueRow)).toHaveCount(0);
  }

  const source = await context.newPage();
  await gotoFixture(source, "providers-embed");
  const queued = await useButton(openPopup, source, roomId, VIMEO_EMBED, "queueButton");
  await expect(queued.locator(popup.shareStatus)).toHaveText(`Added to the queue in ${roomId}.`);
  for (const page of everyone) {
    await expect(page.locator(site.sharedVideo)).toHaveAttribute("src", /player\.vimeo\.com\/video\/76979871/);
    await expect(page.locator(site.queueRow)).toHaveCount(0);
    await expect(page.locator(site.queueCount)).toHaveText("0 / 20");
  }
});
