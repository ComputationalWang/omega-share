// Owner moderation UI (OME-507, ADR 0030): the menu and the playback setting are a lazy chunk only the owner loads.
// The owner opens a guest's menu from their name tag, and Mute / Remove / the policy go out as owner frames. What the
// server does with them (S1, OME-505) is the moderation suite's (Q1, OME-510); this spec stays on the site's side.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";
import { ownedRoom } from "./support/owned-rooms";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

/** The owner chunk (Vite dev: /src/owner/moderation.ts; a build: moderation-<hash>.js). */
const MODERATION_URL = /\/owner\/moderation|\/moderation-[\w-]+\.js/;

async function newPage(browser: Browser, requests: string[], frames: string[], secrets?: string): Promise<Page> {
  const context = await watchCsp(await browser.newContext());
  contexts.push(context);
  // The owner's browser holds the seeded room's secrets the way room-secrets.ts stores them after a creation.
  if (secrets !== undefined) {
    await context.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
    );
  }
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
  // A seeded owned room (support/owned-rooms.ts): POST /rooms is rate limited and rooms-web spends it.
  const { id, ownerToken, inviteKey } = ownedRoom("mod");
  const owner = await newPage(browser, ownerReq, ownerFrames, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } }));
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "host");
  const guest = await newPage(browser, guestReq, []);
  await guest.goto(`${URLS.web}/r/${id}#k=${inviteKey}`);
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
  // OME-1254 (K7): page chrome at 1280×720, not the stage's 1× scale: 12 px words, the tail on kit's tag.
  expect(await owner.locator(site.modMenu).evaluate((m) => m.closest(".ui-room") === null)).toBe(true);
  for (const words of [owner.locator(`${site.modMenu} .name`), owner.locator(site.modMute)]) {
    expect(Number.parseFloat(await words.evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(12);
  }
  // The tail's tip and centre against kit's tag, both read in one frame (kit may still be walking in, the menu with them).
  await expect.poll(() => owner.evaluate(([menuSel, tagSel]) => {
    const m = document.querySelector(menuSel ?? "");
    const tag = [...document.querySelectorAll<HTMLElement>(tagSel ?? "")].find((t) => t.textContent.includes("kit"));
    if (m === null || tag === undefined) return "not laid out";
    const box = m.getBoundingClientRect();
    const t = tag.getBoundingClientRect();
    const tail = getComputedStyle(m, "::after");
    // The tail is placed in the tray's padding box, centred on its `left` (translate: -50% 0).
    const own = getComputedStyle(m);
    const x = box.left + Number.parseFloat(own.borderLeftWidth) + Number.parseFloat(tail.left);
    const tip = box.top + Number.parseFloat(own.borderTopWidth) + Number.parseFloat(tail.top) + Number.parseFloat(tail.height);
    return x >= t.left && x <= t.right && tip >= t.top - 1 && tip <= t.bottom ? "on the tag" : `tail ${String(x)},${String(tip)} vs tag ${String(t.left)}–${String(t.right)},${String(t.top)}–${String(t.bottom)}`;
  }, [site.modMenu, site.nicknameTag])).toBe("on the tag");
  // The whole tray shows (QA OME-1275): at 1280×720 the stage's clip is shorter than the tray, so nothing may clip it or
  // stack over it. Its corners and the name hit-test to the menu, and it's inside the viewport.
  expect(await owner.locator(site.modMenu).evaluate((m) => {
    const r = m.getBoundingClientRect();
    const n = m.querySelector(".name")?.getBoundingClientRect();
    if (n === undefined) return "no name";
    const points = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [n.left + n.width / 2, n.top + n.height / 2]];
    const hidden = points.filter(([x = 0, y = 0]) => !m.contains(document.elementFromPoint(x, y)));
    const inView = r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    return hidden.length === 0 && inView ? "visible" : `hidden at ${JSON.stringify(hidden)}, menu ${JSON.stringify(r)}`;
  })).toBe("visible");
  await owner.keyboard.press("Escape");
  // From the keyboard: the first row's focus ring is 2 CSS px.
  await kitTag.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.locator(site.modMute)).toBeFocused();
  expect(Number.parseFloat(await owner.locator(site.modMute).evaluate((e) => getComputedStyle(e).outlineWidth))).toBeGreaterThanOrEqual(2);
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
