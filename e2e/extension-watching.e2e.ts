// "They're already watching this" (OME-1637, Movie night E4): the popup sorts the listed rooms that play the page's video
// first, labelled "N watching · Join", from `nowPlaying` in `GET /rooms` (ADR 0056). After a share it badges the tab with
// the room's watcher count, tab-scoped, so the browser clears it on navigation: no worker, nothing sent while browsing.
// `GET /rooms` is stubbed with 20 rooms (one playing the fixture's video) because owned rooms are private and never listed;
// the share itself goes to the real server, into an owned room reached through its invite link (one per attempt).
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { gotoFixture } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { popup, site } from "./support/selectors";

test.fixme(!available.extension, PENDING.extension);
test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

declare const chrome: { action: { getBadgeText(d: { tabId: number }): Promise<string> } };

const VIDEO = "aqz-KE-bpKQ"; // youtube-embed.html

/** 20 public rooms; `match` plays the fixture's video with 4 of its 6 members watching. */
async function stubRooms(context: BrowserContext, match: { id: string; title: string }): Promise<void> {
  const rooms: object[] = Array.from({ length: 19 }, (_, i) => ({ id: `room${String(i)}`.padEnd(26, "a"), memberCount: i, seatedCount: 0, nowPlaying: { provider: "youtube", id: "bbbbbbbbbbb" } }));
  rooms.splice(12, 0, { id: match.id, title: match.title, memberCount: 6, seatedCount: 0, watchingCount: 4, nowPlaying: { provider: "youtube", id: VIDEO } });
  await context.route(`${URLS.server}/rooms`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { rooms } }) : route.fallback(),
  );
}

const attempt = (info: TestInfo) => (info.retry === 0 ? "extwatcha" : "extwatchb");

function tabIdOf(p: Page): number {
  return Number(new URL(p.url()).searchParams.get("tabId"));
}

test("the room playing the page's video lists first as \"N watching · Join\"; a share into it badges the tab until it navigates", async ({ context, openPopup }, info) => {
  const room = ownedRoom(attempt(info));
  await stubRooms(context, { id: room.id, title: room.title });
  // A member tab puts the room's share token where the popup reads it.
  const member = await context.newPage();
  await member.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await member.locator(site.nicknameInput).fill("ext-watch");
  await member.locator(site.joinButton).click();
  await expect(member.locator(site.room)).toBeVisible();

  const yt = await context.newPage();
  await gotoFixture(yt, "youtube-embed");
  const p = await openPopup(yt);
  const options = p.locator(popup.roomSelect).locator("option");
  await expect(options).toHaveCount(21); // 20 rooms + "New room…"
  await expect(options.first()).toHaveText(`${room.title} · 4 watching · Join`);
  await expect(options.first()).toHaveAttribute("value", room.id);
  await expect(options.filter({ hasText: "watching" })).toHaveCount(1);

  await p.locator(popup.roomSelect).selectOption(room.id);
  await p.locator(popup.shareButton).click();
  await expect(p.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
  const tabId = tabIdOf(p);
  await expect.poll(() => p.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe("4");

  // Tab-scoped: another page in that tab drops it, with no worker involved.
  await gotoFixture(yt, "no-video");
  await expect.poll(() => p.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe("");
});
