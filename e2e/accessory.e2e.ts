// Head accessories (OME-1391, 5..8 OME-1532): a 9-option row (none + 8) under the landing tint row (sent with `join`) and in the People
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

const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()), accessory: v.number(), bare: v.exactOptional(v.boolean()), hatAnchored: v.exactOptional(v.boolean()) }));
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

test("landing: nine named options under the tints, 44 px to a finger, the pick saved; the sheet never loads there", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  const page = await context.newPage();
  const requests = sheetRequests(page);
  await page.goto(URLS.web);
  const options = page.getByRole("radiogroup", { name: "Accessory" }).getByRole("radio");
  await expect(options).toHaveCount(9);
  await expect(options.last()).toHaveAttribute("aria-label", "Halo");
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

// OME-1404 (art OME-1409): under the crown, Pip and Mo are drawn on their bare-head frames, Juno on her own; the beanie
// (it hides their headwear itself) puts them back on their own frames.
test("Pip and Mo go bare-headed under a crown, Juno doesn't; under the beanie nobody does", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("accessory", "bare").url,
    count: 3,
    nicknamePrefix: "accb",
    setup: async (context) => {
      await context.addInitScript(() => {
        localStorage.setItem("omega.accessory", "2");
      });
    },
  });
  const [juno, pip, mo] = clients;
  if (juno === undefined || pip === undefined || mo === undefined) throw new Error("need three clients");
  const ids = await Promise.all([juno, pip, mo].map((c) => self(c.page)));
  const bareOn = async (id: string | undefined): Promise<string> => {
    const f = v.parse(Frames, await handle(juno.page, "avatarFrames", id));
    return `${String(f?.accessory)}:${String(f?.bare)}`;
  };
  await expect.poll(() => Promise.all(ids.map(bareOn)), { timeout: 15_000 }).toEqual(["2:false", "2:true", "2:true"]);
  await pip.page.getByTestId("people-key").click();
  await pip.page.getByTestId("accessory-menu").getByRole("radio", { name: "Beanie" }).click();
  await expect.poll(() => bareOn(ids[1]), { timeout: 3000, intervals: [50] }).toBe("4:false");
});

// OME-1532: all eight drawn in the room at 1x, Pip bare-headed under the ones marked bare (cap and bow among the new four).
// Each hat keeps its own anchor after a swap from the one before (QA OME-1538: the halo and flower sat low). A screenshot
// per accessory goes into the report for QA's look.
test("all eight accessories draw in the room at 1x, Pip bare under the party hat, crown, headphones, cap and bow", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("accessory", "eight").url, count: 2, nicknamePrefix: "acc8", contextOptions: () => ({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }) });
  const [juno, pip] = clients;
  if (juno === undefined || pip === undefined) throw new Error("need two clients");
  const pipId = await self(pip.page);
  await pip.page.getByTestId("people-key").click();
  const radios = pip.page.getByTestId("accessory-menu").getByRole("radio");
  await expect(radios).toHaveCount(9);
  const bareUnder = [true, true, true, false, true, false, true, false];
  for (let a = 1; a <= 8; a++) {
    // set-accessory shares the emote bucket (3, then 1/s): one pick a second never trips it.
    if (a > 3) await pip.page.waitForTimeout(1000);
    await radios.nth(a).click();
    await expect
      .poll(async () => v.parse(Frames, await handle(juno.page, "avatarFrames", pipId)), { timeout: 15_000 })
      .toMatchObject({ accessory: a, bare: bareUnder[a - 1], hatAnchored: true });
    await test.info().attach(`accessory-${String(a)}-1x.png`, { body: await juno.page.screenshot(), contentType: "image/png" });
  }
});
