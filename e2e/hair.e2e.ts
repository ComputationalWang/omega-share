// Hair colour (OME-1438, art OME-1436): a 6-swatch row beside the shirt tint row, on the landing (sent with `join`) and in
// the People panel (sends `set-hair`); every client draws the member from one sheet copy per (avatar, tint, hair), hat too.
import * as v from "valibot";
import type { Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()), sticker: v.nullable(v.string()), tint: v.number(), hair: v.number(), accessory: v.number() }));

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): my member id. */
async function self(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const state: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
    const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
    return typeof s === "object" && s !== null ? (Reflect.get(s, "self") as unknown) : null;
  });
  return v.parse(v.string(), id);
}

/** How someone is drawn now: frame keys, and the tint and hair whose sheets the avatar's texture comes from. */
async function frames(page: Page, id: string): Promise<v.InferOutput<typeof Frames>> {
  const f = await page.evaluate((id) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
    return typeof get === "function" ? ((Reflect.apply(get, room, [id]) as unknown) ?? null) : null;
  }, id);
  return v.parse(Frames, f);
}

test("landing: six named hair swatches beside the tints, 44 px to a finger, relabelled per avatar", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  const page = await context.newPage();
  await page.goto(URLS.web);
  const row = page.getByRole("radiogroup", { name: "Hair colour" });
  const swatches = row.getByRole("radio");
  await expect(swatches).toHaveCount(6);
  await expect(swatches.first()).toHaveAttribute("aria-label", "Dark");
  for (const box of await Promise.all((await swatches.all()).map((s) => s.boundingBox()))) {
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.locator(site.avatarOption).nth(1).tap();
  await expect(swatches.first()).toHaveAttribute("aria-label", "Ginger");
  await swatches.nth(4).tap();
  await expect(swatches.nth(4)).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("omega.hair"))).toBe("4");
  await context.close();
});

test("the landing's hair goes with join over a tint and a hat, and a pick in the room shows for the other client at once", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("hair", "pick").url,
    count: 2,
    nicknamePrefix: "hair",
    setup: async (context, i) => {
      if (i === 0) await context.addInitScript(() => {
          localStorage.setItem("omega.tint", "2");
          localStorage.setItem("omega.hair", "3");
          localStorage.setItem("omega.accessory", "2");
        });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = await self(a.page);
  // One look: shirt 2 and hair 3 from the same copy, and the crown drawn from that hair's hat sheet.
  await expect.poll(async () => { const f = await frames(b.page, aId); return [f?.tint, f?.hair, f?.accessory]; }, { timeout: 15_000 }).toEqual([2, 3, 2]);
  await a.page.getByTestId("people-key").click();
  const menu = a.page.getByTestId("hair-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("radiogroup", { name: "Your hair colour" }).getByRole("radio").nth(3)).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("radio").nth(1).click();
  for (const page of [a.page, b.page]) await expect.poll(async () => { const f = await frames(page, aId); return [f?.tint, f?.hair, f?.accessory]; }, { timeout: 3000, intervals: [50] }).toEqual([2, 1, 2]);
  expect(await a.page.evaluate(() => localStorage.getItem("omega.hair"))).toBe("1");
  await a.page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});
