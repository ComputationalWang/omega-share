// Owner moderation UI (OME-507, ADR 0030): the menu and the playback setting are a lazy chunk only the owner loads.
// The owner opens a guest's menu from their name tag, and Mute / Remove / the policy go out as owner frames. What the
// server does with them (S1, OME-505) is the moderation suite's (Q1, OME-510); this spec stays on the site's side.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

/** The owner chunk (Vite dev: /src/owner/moderation.ts; a build: moderation-<hash>.js). */
const MODERATION_URL = /\/owner\/moderation|\/moderation-[\w-]+\.js/;

async function newPage(browser: Browser, requests: string[], frames: string[]): Promise<Page> {
  const context = await watchCsp(await browser.newContext());
  contexts.push(context);
  await stubExternalNetwork(context);
  const page = await context.newPage();
  page.on("request", (r) => requests.push(r.url()));
  page.on("websocket", (ws) => ws.on("framesent", (f) => {
    if (typeof f.payload === "string") frames.push(f.payload);
  }));
  return page;
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
}

const sent = (frames: string[], type: string): unknown[] =>
  frames.map((f): unknown => JSON.parse(f)).filter((m) => typeof m === "object" && m !== null && Reflect.get(m, "type") === type);

test("only the owner loads the moderation tools: a guest's tag opens Mute / Remove, and the setting sends the policy", async ({ browser }) => {
  const ownerReq: string[] = [];
  const guestReq: string[] = [];
  const ownerFrames: string[] = [];
  const owner = await newPage(browser, ownerReq, ownerFrames);
  await owner.goto(`${URLS.web}/`);
  await owner.locator(site.createRoomTitle).fill("House rules");
  await owner.locator(site.createRoomSubmit).click();
  await owner.waitForURL(/\/r\/[a-z2-7]{26}$/);
  await enter(owner, "host");
  const guest = await newPage(browser, guestReq, []);
  await guest.goto(owner.url());
  await enter(guest, "kit");

  // The owner gets the setting (Everyone by default); the guest gets nothing, and never fetches the chunk.
  await expect(owner.locator(site.controlPolicy)).toBeVisible();
  await expect(owner.locator(site.controlPolicyOption).first()).toHaveAttribute("aria-checked", "true");
  await expect(guest.locator(site.room)).toBeVisible();
  await guest.waitForTimeout(500);
  await expect(guest.locator(site.controlPolicy)).toHaveCount(0);
  expect(guestReq.filter((u) => MODERATION_URL.test(u))).toEqual([]);
  expect(ownerReq.some((u) => MODERATION_URL.test(u))).toBe(true);
  // A guest's tags are plain text, not buttons.
  await expect(guest.locator(`${site.nicknameTag}[role=button]`)).toHaveCount(0);

  // The owner's own tag isn't a menu; the guest's is.
  await expect(owner.locator(site.nicknameTag).filter({ hasText: "host" })).not.toHaveAttribute("role", "button");
  const kitTag = owner.locator(site.nicknameTag).filter({ hasText: "kit" });
  await kitTag.click();
  await expect(owner.locator(site.modMenu)).toBeVisible();
  await expect(owner.locator(site.modMenu)).toContainText("kit");
  await owner.locator(site.modMute).click();
  await expect(owner.locator(site.modMenu)).toHaveCount(0);
  await expect.poll(() => sent(ownerFrames, "mute")).toHaveLength(1);
  expect(sent(ownerFrames, "mute")[0]).toMatchObject({ type: "mute", muted: true });

  // Remove asks first; Keep backs out without a frame; Escape closes.
  await kitTag.click();
  await owner.locator(`${site.modRemove} button`).click();
  await expect(owner.locator(site.modRemove)).toContainText("Remove kit for 10 min?");
  await owner.locator(site.modKeep).click();
  await owner.keyboard.press("Escape");
  await expect(owner.locator(site.modMenu)).toHaveCount(0);
  expect(sent(ownerFrames, "kick")).toEqual([]);

  // Only me → a control-policy frame.
  await owner.locator(site.controlPolicyOption).filter({ hasText: "Only me" }).click();
  await expect.poll(() => sent(ownerFrames, "control-policy")).toEqual([{ type: "control-policy", policy: "owner" }]);
});
