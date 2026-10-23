// Lying down (OME-1691, contract OME-1773): sit on a sofa, lie down on it, and get up. Everyone sees the lier in the
// lying sheet's frames, and the sofa's key is taken while they lie. The room is SET_G (e2e/fixtures/layouts.ts): its
// first sofa is layout piece 2, seats 0 and 1.
import * as v from "valibot";
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const SOFA = 2;
const State = v.object({ self: v.string(), room: v.object({ seats: v.array(v.nullable(v.string())), members: v.array(v.object({ id: v.string(), lying: v.optional(v.number()) })) }) });
const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()) }));

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): the view state now. */
async function state(page: Page): Promise<v.InferOutput<typeof State>> {
  const s = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
    return typeof get === "function" ? (Reflect.apply(get, room, []) as unknown) : null;
  });
  return v.parse(State, s);
}

async function frame(page: Page, id: string): Promise<string> {
  const f = await page.evaluate((id) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
    return typeof get === "function" ? ((Reflect.apply(get, room, [id]) as unknown) ?? null) : null;
  }, id);
  return v.parse(Frames, f)?.avatar ?? "";
}

const lyingOf = async (page: Page, id: string): Promise<number | null> => (await state(page)).room.members.find((m) => m.id === id)?.lying ?? null;

test("sit on a sofa, lie down on it, get up: both clients see it, and the sofa is taken meanwhile", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("lie", "sofa").url, count: 2, nicknamePrefix: "lier" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = (await state(a.page)).self;
  const key = (page: Page) => page.locator(`${site.lieKey}[data-lie="${String(SOFA)}"]`);

  await a.page.locator(`${site.seat}[data-seat="0"]`).click();
  for (const page of [a.page, b.page]) await expect.poll(async () => (await state(page)).room.seats[0], { timeout: 15_000 }).toBe(aId);
  await expect(key(a.page)).toHaveAccessibleName("Lie down on the sofa");

  await key(a.page).click();
  for (const page of [a.page, b.page]) {
    await expect.poll(() => lyingOf(page, aId), { timeout: 15_000 }).toBe(SOFA);
    // The server stood them up from the seat; the lying sheet is lazy, so its frames arrive a moment later.
    expect((await state(page)).room.seats.includes(aId)).toBe(false);
    await expect.poll(() => frame(page, aId), { timeout: 15_000 }).toMatch(/^lie\/\w+\/ne\/[01]$/);
  }
  await expect(key(a.page)).toHaveAccessibleName("Get up from the sofa");
  await expect(key(b.page)).toBeDisabled();

  await key(a.page).click();
  for (const page of [a.page, b.page]) {
    await expect.poll(() => lyingOf(page, aId), { timeout: 15_000 }).toBeNull();
    await expect.poll(() => frame(page, aId), { timeout: 15_000 }).not.toMatch(/^lie\//);
  }
  await expect(key(b.page)).toBeEnabled();
});

test("sitting down while lying gets you up from the sofa", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("lie", "sofa").url, count: 2, nicknamePrefix: "stand" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = (await state(a.page)).self;
  await a.page.locator(`${site.lieKey}[data-lie="${String(SOFA)}"]`).click();
  await expect.poll(() => lyingOf(b.page, aId), { timeout: 15_000 }).toBe(SOFA);
  await a.page.locator(`${site.seat}[data-seat="2"]`).click();
  await expect.poll(() => lyingOf(b.page, aId), { timeout: 15_000 }).toBeNull();
  await expect.poll(async () => (await state(b.page)).room.seats[2], { timeout: 15_000 }).toBe(aId);
});
