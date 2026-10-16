// Keyboard focus in the owner's tools (OME-1244, QA research OME-1243 K3–K6): after a kick, in the member menu, on
// Escape from the editor and after "Keep it", focus lands on a defined control, never <body>. Keyboard only.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";
import { ownedRoom, type OwnedRoomName } from "./support/owned-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

async function newPage(browser: Browser, secrets?: string): Promise<Page> {
  const context = await watchCsp(await browser.newContext());
  contexts.push(context);
  if (secrets !== undefined) {
    await context.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
    );
  }
  await stubExternalNetwork(context);
  return context.newPage();
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
}

/** The owner in a seeded owned room (support/owned-rooms.ts), plus guests by nickname. */
async function room(browser: Browser, name: OwnedRoomName, guests: readonly string[]): Promise<Page> {
  const { id, ownerToken, inviteKey } = ownedRoom(name);
  const owner = await newPage(browser, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } }));
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "host");
  for (const nick of guests) {
    const guest = await newPage(browser);
    await guest.goto(`${URLS.web}/r/${id}#k=${inviteKey}`);
    await enter(guest, nick);
  }
  return owner;
}

const inMenu = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.querySelector("[data-testid=mod-menu]")?.contains(document.activeElement) === true);

test("member menu: Tab and Shift+Tab stay inside, the close key is named, Escape from outside goes back to the tag", async ({ browser }) => {
  const owner = await room(browser, "modfocus", ["kit"]);
  const kitTag = owner.locator(`${site.nicknameTag}[role=button]`).filter({ hasText: "kit" });
  await expect(kitTag).toBeVisible();
  await kitTag.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.modMute)).toBeFocused();
  await expect(owner.locator(site.modClose)).toHaveAccessibleName("Close");
  for (let i = 0; i < 4; i++) {
    await owner.keyboard.press("Tab");
    expect(await inMenu(owner)).toBe(true);
  }
  for (let i = 0; i < 4; i++) {
    await owner.keyboard.press("Shift+Tab");
    expect(await inMenu(owner)).toBe(true);
  }
  await owner.keyboard.press("Escape");
  await expect(owner.locator(site.modMenu)).toHaveCount(0);
  await expect(kitTag).toBeFocused();

  // Open again, then move focus out of the menu (here: the chat log); Escape still closes it and goes back to the tag.
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.modMenu)).toBeVisible();
  await owner.locator(site.chatLog).focus();
  await owner.keyboard.press("Escape");
  await expect(owner.locator(site.modMenu)).toHaveCount(0);
  await expect(kitTag).toBeFocused();
});

test("after a kick, focus moves to the next member's tag, never <body>", async ({ browser }) => {
  const owner = await room(browser, "modfocusk", ["kit", "bo"]);
  const tag = (nick: string) => owner.locator(`${site.nicknameTag}[role=button]`).filter({ hasText: nick });
  await expect(tag("bo")).toBeVisible();
  await tag("kit").focus();
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.modMute)).toBeFocused();
  await owner.keyboard.press("Tab");
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.modConfirm)).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(tag("kit")).toHaveCount(0);
  await expect(tag("bo")).toBeFocused();
});

test("editor: Keep it goes back to Delete room; Escape closes the editor onto Edit room", async ({ browser }) => {
  const owner = await room(browser, "edfocus", []);
  const edit = owner.locator(site.editRoom);
  await edit.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.editorTray)).toBeVisible();

  await owner.locator(site.editorDelete).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.editorDeleteConfirm)).toBeFocused();
  await owner.keyboard.press("Tab");
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.editorDelete)).toBeFocused();

  // Escape from a field in the editor, too.
  await owner.locator(site.editorTitle).focus();
  await owner.keyboard.press("Escape");
  await expect(owner.locator(site.editorTray)).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveAttribute("aria-pressed", "false");
});
