// M10 W4 (OME-911, ADR 0043): durable sessions on a phone. Hiding the page or reloading `/r/<id>` keeps your member, seat
// and standing slot; nobody sees you leave and come back. The hold ends after the grace window (RESUME_GRACE_MS, 40 s on
// the e2e server, playwright.config.ts) with one leave line. A kick ends it at once, and one token is one member.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { RESUME_STORAGE_KEY_PREFIX, ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { clickSettled, testRoom } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(150_000);

/** The e2e server's grace window (playwright.config.ts). */
const GRACE_MS = 40_000;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

interface Member {
  readonly context: BrowserContext;
  readonly page: Page;
  /** `join` frames this page has sent, and the URLs of every socket it opened. */
  readonly joins: () => number;
  readonly sockets: () => readonly string[];
}

async function open(browser: Browser, url: string, nickname: string, setup?: (c: BrowserContext) => Promise<void>, phone = true): Promise<Member> {
  const context = await watchCsp(await browser.newContext(phone ? PHONE : {}));
  contexts.push(context);
  await stubExternalNetwork(context);
  await setup?.(context);
  const page = await context.newPage();
  return enterOn(context, page, url, nickname);
}

async function enterOn(context: BrowserContext, page: Page, url: string, nickname: string): Promise<Member> {
  let joins = 0;
  const sockets: string[] = [];
  page.on("websocket", (ws) => {
    // The room's sockets only (the dev server's HMR socket carries its own query token).
    if (!ws.url().startsWith(URLS.server.replace(/^http/, "ws"))) return;
    sockets.push(ws.url());
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string" && f.payload.includes('"type":"join"')) joins++;
    });
  });
  await page.goto(url);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  return { context, page, joins: () => joins, sockets: () => sockets };
}

const tag = (page: Page, nickname: string) => page.locator(site.nicknameTag).filter({ hasText: nickname });
const chatLines = (page: Page, text: string) => page.locator(site.chatLogLine).filter({ hasText: text });

interface Seen {
  readonly self: string | null;
  /** Seat index per nickname; null when standing. */
  readonly seats: Readonly<Record<string, number | null>>;
}

/** What this page's room state says (dev handle `window.__omega.room.state()`). */
function seen(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const handle = (window as { __omega?: { room: { state: () => { self: string | null; room: { members: { id: string; nickname: string }[]; seats: (string | null)[] } | null } } | null } }).__omega?.room;
    const s = handle?.state();
    const seats: Record<string, number | null> = {};
    for (const m of s?.room?.members ?? []) {
      const i = s?.room?.seats.indexOf(m.id) ?? -1;
      seats[m.nickname] = i < 0 ? null : i;
    }
    return { self: s?.self ?? null, seats };
  });
}

const seatOf = async (page: Page, nickname: string): Promise<number | null> => (await seen(page)).seats[nickname] ?? null;

/** How the page looks to lifecycle code while it is in the background on a phone: hidden, then `pagehide`. */
async function goAway(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
}

async function comeBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function sit(page: Page, seat: number, nickname: string): Promise<void> {
  await clickSettled(page, page.locator(`${site.seat}[data-seat="${String(seat)}"]`));
  await expect.poll(() => seatOf(page, nickname)).toBe(seat);
}

test("hide for 30 s on a phone, then return: same seat, no Enter form, no leave/join lines; peers saw Away", async ({ browser }) => {
  const room = testRoom("m10-sessions", "hide");
  const ana = await open(browser, room.url, "ana");
  const obs = await open(browser, room.url, "obs");
  await sit(ana.page, 2, "ana");
  await expect.poll(() => seatOf(obs.page, "ana")).toBe(2);

  await goAway(ana.page);
  await expect(obs.page.locator(`${site.peopleRow}.is-away`).filter({ hasText: "ana" })).toHaveCount(1);
  await ana.page.waitForTimeout(30_000);
  await comeBack(ana.page);

  await expect(ana.page.locator(site.room)).toBeVisible();
  await expect(ana.page.locator(site.nicknameInput)).toBeHidden();
  await expect.poll(() => seatOf(ana.page, "ana")).toBe(2);
  await expect.poll(() => seatOf(obs.page, "ana")).toBe(2);
  await expect(obs.page.locator(`${site.peopleRow}.is-away`)).toHaveCount(0);
  await expect(tag(obs.page, "ana")).toHaveCount(1);
  for (const p of [ana.page, obs.page]) await expect(chatLines(p, "left the room")).toHaveCount(0);
  // Tokens never travel in a URL (ADR 0043): every socket the page opened is the plain room URL.
  for (const u of ana.sockets()) expect(u).toBe(`${URLS.server.replace(/^http/, "ws")}/rooms/${room.id}/ws`);
});

test("a full reload of /r/<id> goes straight back in: same seat, same member, no Enter form, nothing in chat", async ({ browser }) => {
  const room = testRoom("m10-sessions", "reload");
  const ana = await open(browser, room.url, "ana");
  const obs = await open(browser, room.url, "obs");
  await sit(ana.page, 1, "ana");
  const before = (await seen(ana.page)).self;

  await ana.page.reload();
  await expect(ana.page.locator(site.room)).toBeVisible();
  await expect(ana.page.locator(site.nicknameInput)).toBeHidden();
  await expect.poll(() => seatOf(ana.page, "ana")).toBe(1);
  const after = (await seen(ana.page)).self;
  expect(after).toBe(before);
  await expect(tag(obs.page, "ana")).toHaveCount(1);
  await expect(chatLines(obs.page, "left the room")).toHaveCount(0);
  // The token stays in this tab's sessionStorage, never in the URL.
  expect(ana.page.url()).toBe(room.url);
  expect(await ana.page.evaluate((k) => sessionStorage.getItem(k) !== null, `${RESUME_STORAGE_KEY_PREFIX}${room.id}`)).toBe(true);
});

test("after the grace window the seat is free and peers saw one leave line; the page still open comes back as a new member", async ({ browser }) => {
  const room = testRoom("m10-sessions", "expire");
  const ana = await open(browser, room.url, "ana");
  const obs = await open(browser, room.url, "obs");
  await sit(ana.page, 3, "ana");
  await expect.poll(() => seatOf(obs.page, "ana")).toBe(3);
  const before = (await seen(ana.page)).self;

  await goAway(ana.page);
  await expect(chatLines(obs.page, "ana left the room")).toHaveCount(1, { timeout: GRACE_MS + 15_000 });
  await expect(tag(obs.page, "ana")).toHaveCount(0);
  await sit(obs.page, 3, "obs");

  // The page never closed: its token is dead, so it rejoins once as a new member, standing (ADR 0043 amendment).
  await comeBack(ana.page);
  await expect(tag(obs.page, "ana")).toHaveCount(1);
  await expect.poll(async () => (await seen(ana.page)).self).not.toBe(before);
  expect(await seatOf(obs.page, "ana")).toBeNull();
  expect(await seatOf(obs.page, "obs")).toBe(3);
  await expect(chatLines(obs.page, "ana left the room")).toHaveCount(1);
});

test("a reload after the grace window shows the card back to Enter, not a silent new member", async ({ browser }) => {
  const room = testRoom("m10-sessions", "expreload");
  const ana = await open(browser, room.url, "ana");
  const obs = await open(browser, room.url, "obs");
  await goAway(ana.page);
  await expect(chatLines(obs.page, "ana left the room")).toHaveCount(1, { timeout: GRACE_MS + 15_000 });

  await ana.page.reload();
  const card = ana.page.locator(site.roomRefused);
  await expect(card).toHaveAttribute("data-code", "resume_expired");
  await ana.page.locator(site.roomRefusedAction).click();
  await expect(ana.page.locator(site.nicknameInput)).toBeVisible();
  await expect(tag(obs.page, "ana")).toHaveCount(0);
});

test("a member kicked while away cannot resume with the stored token", async ({ browser }) => {
  const r = ownedRoom("sesskick");
  const secrets = JSON.stringify({ v: 1, rooms: { [r.id]: { ownerToken: r.ownerToken, inviteKey: r.inviteKey } } });
  const owner = await open(browser, `${URLS.web}/r/${r.id}`, "host", async (c) => {
    await c.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
    );
  }, false); // The host moderates from a desktop (moderation.e2e.ts); the kicked guest is the phone.
  const kit = await open(browser, `${URLS.web}/r/${r.id}#k=${r.inviteKey}`, "kit");
  await expect(tag(owner.page, "kit")).toHaveCount(1);

  await goAway(kit.page);
  await expect(owner.page.locator(`${site.peopleRow}.is-away`).filter({ hasText: "kit" })).toHaveCount(1);
  await tag(owner.page, "kit").click();
  await owner.page.locator(`${site.modRemove} button`).click();
  await owner.page.locator(site.modConfirm).click();
  await expect(tag(owner.page, "kit")).toHaveCount(0);

  await kit.page.reload();
  await expect(kit.page.locator(site.roomRefused)).toHaveAttribute("data-code", "resume_expired");
  await expect(tag(owner.page, "kit")).toHaveCount(0);
});

test("two tabs with one token: only one member; the older tab says the session moved and does not fight back", async ({ browser }) => {
  const room = testRoom("m10-sessions", "tabs");
  const ana = await open(browser, room.url, "ana");
  const obs = await open(browser, room.url, "obs");
  const key = `${RESUME_STORAGE_KEY_PREFIX}${room.id}`;
  const record = await ana.page.evaluate((k) => sessionStorage.getItem(k), key);
  expect(record).not.toBeNull();

  // A second tab carrying the same session (as a duplicated tab would).
  const twin = await ana.context.newPage();
  await twin.addInitScript(([k, v]) => {
    if (sessionStorage.getItem(k ?? "") === null) sessionStorage.setItem(k ?? "", v ?? "");
  }, [key, record ?? ""]);
  await twin.goto(room.url);
  await expect(twin.locator(site.room)).toBeVisible();
  await expect(twin.locator(site.nicknameInput)).toBeHidden();

  await expect(ana.page.getByTestId("room-replaced")).toBeVisible();
  await expect(tag(obs.page, "ana")).toHaveCount(1);
  await expect(obs.page.locator(site.peopleRow).filter({ hasText: "ana" })).toHaveCount(1);
  const joinsBefore = ana.joins();
  await ana.page.waitForTimeout(3000);
  expect(ana.joins()).toBe(joinsBefore);

  // Return here takes it back; the twin is the one told now.
  await ana.page.getByTestId("room-replaced-return").click();
  await expect(ana.page.getByTestId("room-replaced")).toBeHidden();
  await expect(twin.getByTestId("room-replaced")).toBeVisible();
  await expect(obs.page.locator(site.peopleRow).filter({ hasText: "ana" })).toHaveCount(1);
});
