// Head accessories (OME-1391): a 5-option row (none + 4) under the landing tint row (sent with `join`) and in the People
// panel (sends `set-accessory`). The overlay is drawn where a theme hat goes, and a member's own accessory wins over the
// theme's hat. The sheet loads only once someone in the room wears one. Sheet parsing and the hat choice are unit tests
// (apps/web/test/accessory-sheet.test.ts).
import * as v from "valibot";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()), accessory: v.number() }));
const Hats = v.object({ hats: v.number() });

/** Read `window.__omega.room[name](...args)`, the dev handle (apps/web/src/main.ts). */
async function handle(page: Page, name: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ([name, args]) => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, name) : null;
      return typeof get === "function" ? ((Reflect.apply(get, room, args) as unknown) ?? null) : null;
    },
    [name, args] as const,
  );
}

async function self(page: Page): Promise<string> {
  const s = await handle(page, "state");
  return v.parse(v.object({ self: v.string() }), s).self;
}

/** The accessory drawn on someone now (0: none, or the theme's hat). */
async function accessoryOn(page: Page, id: string): Promise<number | undefined> {
  return v.parse(Frames, await handle(page, "avatarFrames", id))?.accessory;
}

const wearing = (a: string) => async (context: BrowserContext, i: number) => {
  if (i === 0) await context.addInitScript((a) => {
      localStorage.setItem("omega.accessory", a);
    }, a);
};

/** Every request for the accessories sheet a page makes. */
const sheetRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("accessories")) seen.push(r.url());
  });
  return seen;
};

test("landing: five named options under the tints, 44 px to a finger, the pick saved; the sheet never loads there", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  const page = await context.newPage();
  const requests = sheetRequests(page);
  await page.goto(URLS.web);
  const options = page.getByRole("radiogroup", { name: "Accessory" }).getByRole("radio");
  await expect(options).toHaveCount(5);
  await expect(options.first()).toHaveAttribute("aria-label", "None");
  for (const box of await Promise.all((await options.all()).map((s) => s.boundingBox()))) {
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await options.nth(2).tap();
  await expect(options.nth(2)).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("omega.accessory"))).toBe("2");
  expect(requests).toEqual([]);
  await context.close();
});

test("the landing's accessory goes with join, and a People panel pick shows for the other client at once", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("accessory", "pick").url, count: 2, nicknamePrefix: "acc", setup: wearing("2") });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = await self(a.page);
  await expect.poll(() => accessoryOn(b.page, aId), { timeout: 15_000 }).toBe(2);
  await a.page.getByTestId("people-key").click();
  const menu = a.page.getByTestId("accessory-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("radio", { name: "Beanie" }).click();
  for (const page of [a.page, b.page]) await expect.poll(() => accessoryOn(page, aId), { timeout: 3000, intervals: [50] }).toBe(4);
  expect(await a.page.evaluate(() => localStorage.getItem("omega.accessory"))).toBe("4");
  await menu.getByRole("radio", { name: "None" }).click();
  await expect.poll(() => accessoryOn(b.page, aId), { timeout: 3000, intervals: [50] }).toBe(0);
});

test("a room where nobody wears one never fetches the sheet", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("accessory", "none").url, count: 1, nicknamePrefix: "accn" });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  const requests = sheetRequests(page);
  const id = await self(page);
  // The motion sheets are in (a sprite frame is drawn), so anything lazy the room wanted has been asked for.
  await expect.poll(async () => v.parse(Frames, await handle(page, "avatarFrames", id))?.avatar ?? null, { timeout: 15_000 }).not.toBeNull();
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
});

test("under a holiday theme, my own accessory wins over its hat: one hat each", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("accessory", "theme").url,
    count: 2,
    nicknamePrefix: "acct",
    setup: async (context, i) => {
      await context.addInitScript(() => {
        localStorage.setItem("omega.theme", "christmas");
      });
      await wearing("1")(context, i);
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = await self(a.page);
  const bId = await self(b.page);
  await expect.poll(() => accessoryOn(b.page, aId), { timeout: 15_000 }).toBe(1);
  // B wears none, so B gets the theme's hat; A only the party hat. Two members, two hats.
  expect(await accessoryOn(b.page, bId)).toBe(0);
  await expect.poll(async () => v.parse(Hats, await handle(b.page, "theme")).hats).toBe(2);
});
