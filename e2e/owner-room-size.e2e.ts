// The owner's room stays usable (OME-1301, QA OME-1300 F1/F5). At 1280×800 the owner's panels (Edit room, Who controls
// playback) used to sit under the stage and shrink the owner's room to half a guest's: seats 16×8 px, a 7×6 tag. On touch
// the guest's tag and the member menu's keys are 44×44 to the finger (assets/STYLE.md), counting a `::before` hit area.
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { QUEUE_ADD_MEMBER_BURST, QUEUE_ADD_ROOM_BURST, QUEUE_ADD_ROOM_REFILL_MS, QUEUE_MAX, ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
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

const DESK: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const TOUCH: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function open(browser: Browser, options: BrowserContextOptions, url: string, nickname: string, secrets?: string): Promise<Page> {
  const context = await watchCsp(await browser.newContext(options));
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
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  // Attached, not visible: a 320×640 window too short for the room hides it whole (OME-1302).
  await expect(page.locator(site.room)).toBeAttached();
  await expect(page.locator(site.chatInput)).toBeVisible();
  return page;
}

/** The owner and a guest ("kit") in the seeded room; the owner sees kit's tag as a menu opener. Nicknames are fresh per retry. */
async function ownerAndGuest(browser: Browser, name: OwnedRoomName, owner: BrowserContextOptions, guest: BrowserContextOptions): Promise<{ host: Page; kit: Page; kitTag: Locator }> {
  const { id, ownerToken, inviteKey } = ownedRoom(name);
  const n = String(test.info().retry);
  const host = await open(browser, owner, `${URLS.web}/r/${id}`, `host${n}`, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } }));
  const kit = await open(browser, guest, `${URLS.web}/r/${id}#k=${inviteKey}`, `kit${n}`);
  await expect(host.locator(site.controlPolicy)).toBeAttached();
  const kitTag = host.locator(`${site.nicknameTag}[role=button]`).filter({ hasText: `kit${n}` });
  await expect(kitTag).toHaveCount(1);
  return { host, kit, kitTag };
}

/** The box a finger or pointer can hit (CSS px): the element's own, or its `::before` if that's bigger (scaled as drawn). */
const hitBox = (target: Locator): Promise<{ w: number; h: number }> =>
  target.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const k = e instanceof HTMLElement && e.offsetWidth > 0 ? r.width / e.offsetWidth : 1;
    const b = getComputedStyle(e, "::before");
    const px = (v: string): number => (b.content === "none" || b.display === "none" ? 0 : (Number.parseFloat(v) || 0) * k);
    // Whole px: offsetWidth is rounded, so the scale is off by a fraction of a pixel.
    return { w: Math.round(Math.max(r.width, px(b.width))), h: Math.round(Math.max(r.height, px(b.height))) };
  });

const area = async (page: Page): Promise<number> => {
  const b = await page.locator(site.roomWindow).boundingBox();
  return b === null ? 0 : b.width * b.height;
};

test("1280×800: the owner's room is as big as a guest's, and axe finds no target too small", async ({ browser }) => {
  const { host, kit } = await ownerAndGuest(browser, "roomsize", DESK, DESK);
  await expect.poll(async () => (await area(host)) / (await area(kit)), { message: "owner room-window area / guest's" }).toBeGreaterThanOrEqual(0.9);
  // The owner's tools are still on the page, in reach.
  await expect(host.locator(site.editRoom)).toBeInViewport();
  await expect(host.locator(site.controlPolicy)).toBeInViewport();
  const { violations } = await new AxeBuilder({ page: host }).include(site.room).withRules(["target-size"]).analyze();
  expect(violations.map((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? ""}`)).flat()).toEqual([]);
});

/**
 * Fills Up next to QUEUE_MAX through raw members (one plays, QUEUE_MAX wait): a room burst at once, then one per room
 * refill, round-robin so no member passes its own burst. Returns the closer.
 */
async function fillQueue(roomId: string, inviteKey: string, tag: string): Promise<() => void> {
  const total = QUEUE_MAX + 1;
  const members = Math.ceil(total / QUEUE_ADD_MEMBER_BURST);
  const sockets = await Promise.all(Array.from({ length: members }, (_, m) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "join", nickname: `${tag}${String(m)}r${String(test.info().retry)}`, avatar: 0, inviteKey })); });
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data === "string" && ev.data.includes('"snapshot"')) resolve(ws);
    });
    ws.addEventListener("error", () => { reject(new Error("websocket error")); });
  })));
  for (let i = 0; i < total; i++) {
    if (i >= QUEUE_ADD_ROOM_BURST) await new Promise((r) => setTimeout(r, QUEUE_ADD_ROOM_REFILL_MS + 200));
    // An 11-character video id.
    sockets[i % members]?.send(JSON.stringify({ type: "queue-add", url: `https://youtu.be/${`${tag}${String(test.info().retry)}x${String(i)}`.padEnd(11, "a")}` }));
  }
  return () => { for (const ws of sockets) ws.close(); };
}

// 1024×768 (OME-1320): the smallest wide layout, where the owner's bar left the log two lines.
for (const [size, viewport, name] of [["1280×800", DESK, "roomfull"], ["1024×768", { viewport: { width: 1024, height: 768 } }, "roomfulls"]] as const) {
  test(`${size}, a full Up next: the owner's list shows a row and scrolls to the last, the chat log keeps three lines`, async ({ browser }) => {
    test.setTimeout(90_000);
    const { host } = await ownerAndGuest(browser, name, viewport, viewport);
    const { id, inviteKey } = ownedRoom(name);
    const close = await fillQueue(id, inviteKey, "qf");
    try {
      const rows = host.locator(site.queueRow);
      await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(QUEUE_MAX);
      const list = host.locator(`${site.queuePanel} .ui-qlist`);
      const row = (await rows.first().boundingBox())?.height ?? 0;
      expect(await list.evaluate((n) => n.clientHeight), "Up next list height").toBeGreaterThanOrEqual(row);
      expect((await host.locator(site.chatLog).boundingBox())?.height ?? 0, "chat log height").toBeGreaterThanOrEqual(60);
      await rows.last().scrollIntoViewIfNeeded();
      await expect(rows.last()).toBeInViewport();
      expect(await host.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    } finally {
      close();
    }
  });
}

test("390×844 touch: the guest's tag and every key in the member menu are 44×44 to the finger", async ({ browser }) => {
  const { host, kitTag } = await ownerAndGuest(browser, "roomtouch", TOUCH, DESK);
  const tag = await hitBox(kitTag);
  expect(tag.w, "tag opener width").toBeGreaterThanOrEqual(44);
  expect(tag.h, "tag opener height").toBeGreaterThanOrEqual(44);

  // A tag the window crops is inert (OME-1325): the whole room on screen first.
  await host.locator("[data-testid=room-zoom-fit]").click();
  await expect(kitTag).not.toHaveAttribute("inert");
  await kitTag.focus();
  await host.keyboard.press("Enter");
  const menu = host.locator(site.modMenu);
  await expect(menu).toBeVisible();
  const measure = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const key of await menu.locator("button:visible").all()) {
      const b = await hitBox(key);
      if (b.w < 44 || b.h < 44) out.push(`${(await key.textContent()) ?? ""}|${await key.getAttribute("data-testid") ?? ""} ${String(Math.round(b.w))}×${String(Math.round(b.h))}`);
    }
    return out;
  };
  expect(await measure()).toEqual([]);
  // Remove asks first: Keep and Remove are keys too.
  await host.locator(site.modRemove).locator("button").first().click();
  await expect(host.locator(site.modKeep)).toBeVisible();
  expect(await measure()).toEqual([]);
});

// QA OME-1324 G1–G3 (OME-1325): a phone held sideways, a narrow mouse window, and seats a window crops.
const LAND: BrowserContextOptions = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const NARROW: BrowserContextOptions = { viewport: { width: 320, height: 640 } };

const targetSize = async (page: Page): Promise<string[]> => {
  const { violations } = await new AxeBuilder({ page }).include(site.room).withRules(["target-size"]).analyze();
  return violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? ""}`));
};

/**
 * Every seat and tag opener in the room window a finger can reach (visible, not inert) whose hit box (its own or its
 * centred `::before`, as drawn) has under 44×44 CSS px showing inside the stage's pane. A seat the window crops must
 * be inert or hidden, never visible, clipped and still focusable (G3). `zoomed`: the viewer zoomed out, so a target may
 * be drawn under 44 px, but must still show whole.
 */
const exposedSmall = (page: Page, zoomed = false): Promise<string[]> =>
  page.evaluate((zoomed) => {
    const out: string[] = [];
    const room = document.querySelector("[data-testid=room-window]");
    const pane = room?.querySelector(".stage-pane") ?? room;
    if (!(room instanceof HTMLElement) || !(pane instanceof HTMLElement)) return ["no room window"];
    const p = pane.getBoundingClientRect();
    for (const e of room.querySelectorAll<HTMLElement>("[data-testid=seat], [data-testid=nickname-tag][role=button]")) {
      if (e.closest("[inert]") !== null || !e.checkVisibility({ visibilityProperty: true })) continue;
      const r = e.getBoundingClientRect();
      const k = e.offsetWidth > 0 ? r.width / e.offsetWidth : 1;
      const b = getComputedStyle(e, "::before");
      const px = (v: string): number => (b.content === "none" || b.display === "none" ? 0 : (Number.parseFloat(v) || 0) * k);
      const w = Math.max(r.width, px(b.width));
      const h = Math.max(r.height, px(b.height));
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const vw = Math.min(cx + w / 2, p.right) - Math.max(cx - w / 2, p.left);
      const vh = Math.min(cy + h / 2, p.bottom) - Math.max(cy - h / 2, p.top);
      if (Math.round(vw) < (zoomed ? Math.round(w) : 44) || Math.round(vh) < (zoomed ? Math.round(h) : 44)) out.push(`${e.dataset["testid"] ?? ""}${e.dataset["seat"] ?? ""} ${String(Math.round(w))}×${String(Math.round(h))}, ${String(Math.round(Math.max(0, vw)))}×${String(Math.round(Math.max(0, vh)))} showing`);
    }
    return out;
  }, zoomed);

/** The room window is wholly on screen once scrolled to, or not shown at all (OME-1302's whole-room-or-none). */
async function wholeOrNone(page: Page): Promise<void> {
  const win = page.locator(site.roomWindow);
  const b = await win.boundingBox();
  if (b === null || b.height === 0 || !(await win.isVisible())) return;
  await win.scrollIntoViewIfNeeded();
  const vp = page.viewportSize();
  const r = await win.boundingBox();
  if (vp === null || r === null) throw new Error("not laid out");
  expect(r.y, "room window top").toBeGreaterThanOrEqual(0);
  expect(r.y + r.height, "room window bottom").toBeLessThanOrEqual(vp.height);
  expect(r.x, "room window left").toBeGreaterThanOrEqual(0);
  expect(r.x + r.width, "room window right").toBeLessThanOrEqual(vp.width);
}

test("844×390 touch, owner and guest: .ui-touch, the whole room on screen, seats and the tag 44×44, axe clean at rest and with People open", async ({ browser }) => {
  const { host, kit, kitTag } = await ownerAndGuest(browser, "roomland", LAND, LAND);
  for (const page of [host, kit]) {
    await expect(page.locator(".ui-touch").first()).toBeAttached();
    await wholeOrNone(page);
    expect(await exposedSmall(page)).toEqual([]);
    expect(await targetSize(page)).toEqual([]);
  }
  const tag = await hitBox(kitTag);
  expect(Math.min(tag.w, tag.h), "owner's tag opener").toBeGreaterThanOrEqual(44);
  for (const page of [host, kit]) {
    await page.locator(site.peopleKey).click();
    await expect(page.locator(site.peoplePanel)).toBeVisible();
    await wholeOrNone(page);
    expect(await exposedSmall(page)).toEqual([]);
    expect(await targetSize(page)).toEqual([]);
  }
});

test("320×640 with a mouse, owner and guest: the tag is 44×44, no seat or tag shows clipped, axe clean at rest, with the share sheet and the member menu", async ({ browser }) => {
  const { host, kit, kitTag } = await ownerAndGuest(browser, "roomnarr", NARROW, NARROW);
  await expect(host.locator(".ui-touch").first()).toBeAttached();
  const tag = await hitBox(kitTag);
  expect(Math.min(tag.w, tag.h), "owner's tag opener").toBeGreaterThanOrEqual(44);
  for (const page of [host, kit]) {
    expect(await exposedSmall(page)).toEqual([]);
    expect(await targetSize(page)).toEqual([]);
    await page.locator("[data-testid=portrait-link]").click();
    expect(await exposedSmall(page)).toEqual([]);
    expect(await targetSize(page)).toEqual([]);
    await page.getByRole("button", { name: "Close" }).click();
  }
  // A tag the window crops is inert, and this window is too short to show kit's tag whole: the owner opens kit's menu
  // in a taller window (the whole room on screen), then the window goes back to 320×640 with the menu open.
  await host.setViewportSize({ width: 390, height: 844 });
  await host.locator("[data-testid=room-zoom-fit]").click();
  await expect(kitTag).not.toHaveAttribute("inert");
  await kitTag.focus();
  await host.keyboard.press("Enter");
  await expect(host.locator(site.modMenu)).toBeVisible();
  await host.setViewportSize({ width: 320, height: 640 });
  await expect(host.locator(site.modMenu)).toBeVisible();
  expect(await exposedSmall(host, true)).toEqual([]);
});
