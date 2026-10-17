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
  await expect(page.locator(site.room)).toBeVisible();
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
