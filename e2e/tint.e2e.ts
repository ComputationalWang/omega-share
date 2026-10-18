// Shirt tint (OME-1352, ADR 0053): a 6-swatch row under the landing avatar picker (sent with `join`) and at the top of
// the People panel (sends `set-tint`); every client draws the member with that avatar's PLTE-swapped sheets at once.
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

const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()), sticker: v.nullable(v.string()), tint: v.number() }));

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

/** How someone is drawn now: frame keys, and the tint whose sheets the avatar's texture comes from. */
async function frames(page: Page, id: string): Promise<v.InferOutput<typeof Frames>> {
  const f = await page.evaluate((id) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
    return typeof get === "function" ? ((Reflect.apply(get, room, [id]) as unknown) ?? null) : null;
  }, id);
  return v.parse(Frames, f);
}

test("landing: six named swatches under the avatars, 44 px to a finger, recoloured per avatar", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
  const page = await context.newPage();
  await page.goto(URLS.web);
  const row = page.getByRole("radiogroup", { name: "Shirt colour" });
  const swatches = row.getByRole("radio");
  await expect(swatches).toHaveCount(6);
  await expect(swatches.first()).toHaveAttribute("aria-label", "Mustard");
  for (const box of await Promise.all((await swatches.all()).map((s) => s.boundingBox()))) {
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.locator(site.avatarOption).nth(1).tap();
  await expect(swatches.first()).toHaveAttribute("aria-label", "Teal");
  await swatches.nth(2).tap();
  await expect(swatches.nth(2)).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("omega.tint"))).toBe("2");
  await context.close();
});

test("the landing's tint goes with join, and a pick in the room shows for the other client at once", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("tint", "pick").url,
    count: 2,
    nicknamePrefix: "tint",
    setup: async (context, i) => {
      if (i === 0) await context.addInitScript(() => {
          localStorage.setItem("omega.tint", "3");
        });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = await self(a.page);
  await expect.poll(async () => (await frames(b.page, aId))?.tint, { timeout: 15_000 }).toBe(3);
  await a.page.getByTestId("people-key").click();
  const menu = a.page.getByTestId("tint-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("radio").nth(1).click();
  for (const page of [a.page, b.page]) await expect.poll(async () => (await frames(page, aId))?.tint, { timeout: 3000, intervals: [50] }).toBe(1);
  // Same frames as before, from the tinted sheet: the tier's frame keys are untouched.
  expect((await frames(b.page, aId))?.avatar ?? "").toMatch(/^(breathe\/)?\w+\/(idle|sit)\//);
  await a.page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(a.page.getByTestId("people-key")).toBeFocused();
});
