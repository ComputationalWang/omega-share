// Created rooms on the site (OME-409, ADR 0028): create → invite link → a guest joins with the #k= key, which is gone
// from the URL before any provider SDK loads → the owner deletes → everyone sees 4004. A guest without the key is refused.
// Each test creates at most one room: the creation bucket is 2 per key (ROOM_CREATE_KEY_BURST).
import { ROOM_SECRETS_STORAGE_KEY, SHARE_TOKEN_STORAGE_KEY } from "@omega/shared";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { EMBED_URL, stubExternalNetwork } from "./support/network";
import { postShare } from "./support/share";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

declare global {
  interface Window {
    /** location.href each time an off-site script was added to the page, and at DOMContentLoaded. */
    __hrefAt?: { readonly what: string; readonly href: string }[];
  }
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await watchCsp(await browser.newContext());
  contexts.push(context);
  await stubExternalNetwork(context);
  // Records what an SDK would read from location.href at the moment it is added to the page.
  await context.addInitScript(() => {
    const seen: { what: string; href: string }[] = [];
    window.__hrefAt = seen;
    document.addEventListener("DOMContentLoaded", () => seen.push({ what: "DOMContentLoaded", href: location.href }));
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLScriptElement && n.src !== "" && new URL(n.src).origin !== location.origin) seen.push({ what: n.src, href: location.href });
    }).observe(document, { childList: true, subtree: true });
  });
  return context.newPage();
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
}

test("create a private room, invite a guest by link, then close it with 4004", async ({ browser, request }) => {
  // The owner creates the room from the home page.
  const owner = await newPage(browser);
  await owner.goto(`${URLS.web}/`);
  await owner.locator(site.createRoomTitle).fill("Movie night");
  await owner.locator(site.createRoomPrivate).check();
  await owner.locator(site.createRoomSubmit).click();
  await owner.waitForURL(/\/r\/[a-z2-7]{26}$/);
  const roomId = new URL(owner.url()).pathname.split("/")[2] ?? "";
  // The owner token lives in localStorage only, never in the URL.
  const secrets = await owner.evaluate((k) => localStorage.getItem(k), ROOM_SECRETS_STORAGE_KEY);
  const record = JSON.parse(secrets ?? "{}") as { rooms?: Record<string, { ownerToken?: string; inviteKey?: string }> };
  const ownerToken = record.rooms?.[roomId]?.ownerToken ?? "";
  const inviteKey = record.rooms?.[roomId]?.inviteKey ?? "";
  expect(ownerToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(inviteKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(owner.url()).not.toContain(ownerToken);
  await enter(owner, "owner");
  await expect(owner.locator(site.room)).toBeVisible();

  // The invite link carries the key in the fragment only.
  const link = await owner.locator(site.inviteLink).inputValue();
  expect(link).toBe(`${URLS.web}/r/${roomId}#k=${inviteKey}`);
  expect(link).not.toContain(ownerToken);

  // A guest opens it: the fragment is gone before the page finishes parsing, and so before any SDK can load.
  const guest = await newPage(browser);
  await guest.goto(link);
  expect(guest.url()).toBe(`${URLS.web}/r/${roomId}`);
  await enter(guest, "guest");
  await expect(guest.locator(site.room)).toBeVisible();
  await expect(guest.locator(site.roomRefused)).toBeHidden();

  // Share a YouTube video into the room: the SDK script the guest's page adds sees the bare /r/<id>.
  const shareToken = await guest.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? "{}") as { token?: string }, SHARE_TOKEN_STORAGE_KEY);
  expect((await postShare(request, roomId, shareToken.token ?? "", EMBED_URL)).status()).toBe(200);
  await expect(guest.locator(site.sharedVideo)).toBeVisible();
  await expect.poll(() => guest.evaluate(() => window.__fakeYt?.events.some((e) => e.type === "ready") ?? false)).toBe(true);
  const hrefs = await guest.evaluate(() => window.__hrefAt ?? []);
  expect(hrefs.some((h) => h.what.includes("youtube.com/iframe_api"))).toBe(true);
  for (const h of hrefs) expect(h.href, h.what).not.toContain("#k=");

  // "Your rooms" on the home page lists it for the owner, without any secret in the markup.
  const home = await owner.context().newPage();
  await home.goto(`${URLS.web}/`);
  await expect(home.locator(site.yourRoomLink)).toHaveAttribute("href", `/r/${roomId}`);
  expect(await home.content()).not.toContain(ownerToken);
  await home.close();

  // The owner deletes the room: every member's page shows "room closed" and stops reconnecting.
  const del = await request.delete(`${URLS.server}/rooms/${roomId}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  expect(del.status()).toBe(200);
  for (const p of [owner, guest]) await expect(p.locator(site.roomClosed)).toBeVisible();
  let sockets = 0;
  guest.on("websocket", () => sockets++);
  await guest.waitForTimeout(3000);
  expect(sockets).toBe(0);
  // A closed room is forgotten: its secrets leave localStorage.
  const after = await owner.evaluate((k) => localStorage.getItem(k) ?? "", ROOM_SECRETS_STORAGE_KEY);
  expect(after).not.toContain(roomId);
});

// The server half (join needs the key) is S4, OME-406; drop the fixme when it merges.
test("a guest with the bare room URL of a private room is refused and told why", async ({ browser }) => {
  test.fixme(true, "needs OME-406: the server checks invite keys on join");
  const owner = await newPage(browser);
  await owner.goto(`${URLS.web}/`);
  await owner.locator(site.createRoomTitle).fill("Closed door");
  await owner.locator(site.createRoomPrivate).check();
  await owner.locator(site.createRoomSubmit).click();
  await owner.waitForURL(/\/r\/[a-z2-7]{26}$/);
  const stranger = await newPage(browser);
  await stranger.goto(owner.url());
  await enter(stranger, "stranger");
  await expect(stranger.locator(site.roomRefused)).toHaveAttribute("data-code", "invite_required");
  await expect(stranger.locator(site.room)).toBeHidden();
});

test("the home page lists public rooms by title, as plain text links", async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto(`${URLS.web}/`);
  const lobby = page.locator(site.publicRoomLink).filter({ hasText: /./ }).first();
  await expect(lobby).toBeVisible();
  expect(await lobby.evaluate((a) => a.children.length)).toBe(0);
  expect(await lobby.getAttribute("href")).toMatch(/^\/r\/[a-z0-9-]+$/);
});
