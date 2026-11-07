// Doorstep desk room chrome (OME-2306, docs/design/site-redesign-2/HANDOFF.md "Layout"): at every sign-off viewport the
// top bar, the panel head's invite and the Chat / Up next / Room tablist are on screen; two columns from 1024 px (the
// panel 300 px to 1279, 360 above), the phone layout below with the tabs right above the docked composer; the local
// avatar in its room strip; no sideways scroll.
import type { BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
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
let ownerContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
  await Promise.all(ownerContexts.map((c) => c.close()));
  ownerContexts = [];
});

type Name = "v360" | "v412" | "v768" | "v900" | "v1024" | "v1280" | "v1920";
const SIZES: readonly { name: Name; w: number; h: number; touch: boolean }[] = [
  { name: "v360", w: 360, h: 740, touch: true },
  { name: "v412", w: 412, h: 915, touch: true },
  { name: "v768", w: 768, h: 1024, touch: true },
  { name: "v900", w: 900, h: 768, touch: false },
  { name: "v1024", w: 1024, h: 768, touch: false },
  { name: "v1280", w: 1280, h: 800, touch: false },
  { name: "v1920", w: 1920, h: 1080, touch: false },
];
const options = (w: number, h: number, touch: boolean): BrowserContextOptions => ({ viewport: { width: w, height: h }, isMobile: touch && w < 600, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}

const tab = (page: Page, name: string): Locator => page.getByRole("tab", { name, exact: true });

for (const { name, w, h, touch } of SIZES) {
  test(`${String(w)}×${String(h)}: top bar, invite and the tablist on screen; ${w >= 1024 ? "two columns" : "tabs above the docked composer"}`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("room-chrome", name).url, count: 1, nicknamePrefix: `rc${String(w)}`, contextOptions: () => options(w, h, touch) });
    const c = clients[0];
    if (c === undefined) throw new Error("no client");
    const { page } = c;
    for (const key of [site.leaveKey, site.peopleKey, site.helpKey]) await expect(page.locator(key)).toBeInViewport();
    const panel = page.getByTestId("room-panel");
    await expect(page.getByRole("tablist", { name: "Room panel" })).toBeVisible();
    // The invite heads the panel: its ticket and Copy are always there, the field at 16 px (no iOS focus zoom).
    await expect(panel.locator(site.inviteLink)).toBeVisible();
    await expect(panel.locator(site.inviteCopy)).toBeVisible();
    expect(await page.locator(site.inviteLink).evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
    // Every tab, the composer and the local avatar's tag at once, without scrolling.
    for (const t of ["Chat", "Up next", "Room"]) await expect(tab(page, t)).toBeInViewport({ ratio: 1 });
    await expect(page.locator(site.chatInput)).toBeInViewport({ ratio: 1 });
    const mine = page.locator(site.nicknameTag).filter({ hasText: c.nickname });
    await expect(mine).toBeInViewport({ ratio: 1 });
    const win = await box(page.locator(site.roomWindow));
    const tag = await box(mine);
    expect(tag.y, "my tag inside the room strip").toBeGreaterThanOrEqual(win.y);
    expect(tag.y + tag.height).toBeLessThanOrEqual(win.y + win.height);
    expect(win.height, "the room strip's floor").toBeGreaterThanOrEqual(w >= 1024 ? 200 : 96);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no sideways scroll").toBeLessThanOrEqual(0);
    const p = await box(panel);
    const tv = await box(page.locator(site.tv));
    if (w >= 1024) {
      expect(p.x, "the panel is a column right of the picture").toBeGreaterThanOrEqual(tv.x + tv.width);
      // 300 px to 1279, 360 above: of 1280's chrome, which a 1920×1080 page zooms 1.5× (OME-1667).
      const chrome = Number(await page.evaluate(() => document.body.dataset["chrome"] ?? "1"));
      expect((await box(page.getByTestId("room-side"))).width).toBe((w < 1280 ? 300 : 360) * chrome);
    } else {
      expect(p.y, "the panel under the room strip").toBeGreaterThanOrEqual(win.y + win.height - 1);
      const tabs = await box(page.getByRole("tablist", { name: "Room panel" }));
      const field = await box(page.locator(site.chatInput));
      expect(tabs.y + tabs.height, "the tabs sit right above the composer").toBeLessThanOrEqual(field.y);
      expect(field.y - (tabs.y + tabs.height)).toBeLessThan(24);
    }
  });
}

test("the tabs: one tab stop, arrows wrap, and each tab shows its own panel", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("room-chrome", "keys").url, count: 1, nicknamePrefix: "rckeys", contextOptions: () => options(1280, 800, false) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  const chat = tab(page, "Chat");
  await expect(chat).toHaveAttribute("aria-selected", "true");
  await chat.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Up next")).toBeFocused();
  await expect(tab(page, "Up next")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(site.queuePanel)).toBeVisible();
  await expect(page.locator(site.chatLog)).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Room")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(chat).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab(page, "Room")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(chat).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(site.chatInput)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tab(page, "Up next")).not.toBeFocused();
});

// QA OME-2360: below 1024 px the open tab's controls are on screen, not under the sticky tabs in a 128 px inner
// scroller. The strip gives way toward its floor (96 px) first; past that, the page grows.
async function aboveTabs(page: Page, key: Locator, what: string): Promise<void> {
  await expect(key, what).toBeInViewport({ ratio: 1 });
  const k = await box(key);
  const tabs = await box(page.getByRole("tablist", { name: "Room panel" }));
  expect(k.y + k.height, `${what} above the sticky tabs`).toBeLessThanOrEqual(tabs.y + 0.5);
  const panel = page.getByRole("tabpanel");
  expect(await panel.evaluate((e) => e.scrollHeight - e.clientHeight), `${what}: the tab doesn't scroll inside`).toBeLessThanOrEqual(1);
}

const NARROW = [
  { room: "v360tabs", w: 360, h: 740, touch: true },
  { room: "v412tabs", w: 412, h: 915, touch: true },
  { room: "v768tabs", w: 768, h: 1024, touch: true },
  { room: "v900tabs", w: 900, h: 768, touch: false },
] as const;
for (const { room, w, h, touch } of NARROW) {
  test(`${String(w)}×${String(h)}: Up next's paste field and Add, and the Room tab's report key, on screen above the tabs`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("room-chrome", room).url, count: 1, nicknamePrefix: `rt${String(w)}`, contextOptions: () => options(w, h, touch) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await tab(page, "Up next").click();
    await aboveTabs(page, page.locator(site.queueUrl), "the paste field");
    await aboveTabs(page, page.locator(site.queueAdd), "Add");
    await tab(page, "Room").click();
    await aboveTabs(page, page.locator(site.reportKey), "Report");
  });
}

test("900×768 owner: Edit room on screen above the tabs", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("chromeown");
  const context = await watchCsp(await browser.newContext(options(900, 768, false)));
  ownerContexts.push(context);
  await context.addInitScript(
    ([origin, key, value]) => {
      if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
    },
    [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })],
  );
  await stubExternalNetwork(context);
  const page = await context.newPage();
  await page.goto(`${URLS.web}/r/${id}`);
  await page.locator(site.nicknameInput).fill("host");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  await tab(page, "Room").click();
  await aboveTabs(page, page.locator(site.editRoom), "Edit room");
});
