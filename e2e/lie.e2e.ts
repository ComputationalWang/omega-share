// Lying down (OME-1691, contract OME-1773): sit on a sofa, lie down on it, and get up. Everyone sees the lier in the
// lying sheet's frames, and the sofa's key is taken while they lie. The room is SET_G (e2e/fixtures/layouts.ts): its
// first sofa is layout piece 2, seats 0 and 1.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RoomLayoutSchema } from "@omega/shared";
import * as v from "valibot";
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, ROOT, available } from "./support/apps";
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
const State = v.object({ self: v.string(), room: v.object({ seats: v.array(v.nullable(v.string())), members: v.array(v.object({ id: v.string(), lying: v.optional(v.number()), sleeper: v.optional(v.number()), cell: v.optional(v.object({ x: v.number(), y: v.number() })), floorSit: v.optional(v.boolean()) })) }) });
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

// QA OME-1785: a lain-on sofa's seats read taken for the others, and a lier who had a floor cell gets up on the same
// spot for everyone: a client that saw them lie down agrees with one that joins afterwards.
test("a lain-on sofa's seats are taken for others, and getting up from a floor sit agrees with a late joiner", async ({ browser }) => {
  const roomUrl = testRoom("lie", "sofa").url;
  clients = await joinRoom(browser, { roomUrl, count: 2, nicknamePrefix: "floor" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = (await state(a.page)).self;
  const key = a.page.locator(`${site.lieKey}[data-lie="${String(SOFA)}"]`);
  const memberOf = async (page: Page) => {
    const m = (await state(page)).room.members.find((x) => x.id === aId);
    return { cell: m?.cell ?? null, floorSit: m?.floorSit ?? null };
  };

  await a.page.locator(site.walkFloor).focus();
  await a.page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await memberOf(b.page)).cell, { timeout: 15_000 }).not.toBeNull();
  await a.page.keyboard.press("s");
  await expect.poll(async () => (await memberOf(b.page)).floorSit, { timeout: 15_000 }).toBe(true);

  await key.click();
  await expect.poll(() => lyingOf(b.page, aId), { timeout: 15_000 }).toBe(SOFA);
  await expect(b.page.locator(`${site.seat}[data-seat="0"]`)).toHaveAccessibleName("Seat 1, taken by floor-1");
  await key.click();
  await expect.poll(() => lyingOf(b.page, aId), { timeout: 15_000 }).toBeNull();

  const [c] = await joinRoom(browser, { roomUrl, count: 1, nicknamePrefix: "late" });
  if (c === undefined) throw new Error("need a late joiner");
  clients.push(c);
  await expect.poll(() => lyingOf(c.page, aId), { timeout: 15_000 }).toBeNull();
  expect(await memberOf(b.page)).toEqual(await memberOf(c.page));
  expect(await memberOf(b.page)).toEqual({ cell: null, floorSit: null });
});

// OME-2009: the Dank Dungeon's first queen bed (facing nw, seats 0-1) sleeps two side by side, each under their
// own cover; a third can't lie down. Draw order at the bed: back, then each sleeper (higher up the screen first) and their cover.
async function drawOrder(page: Page): Promise<string[]> {
  const order = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "scene") : null;
    return typeof get === "function" ? (Reflect.apply(get, room, []) as unknown) : null;
  });
  return v.parse(v.array(v.string()), order);
}

test("two members sleep side by side on the Dank Dungeon bed, each under a cover", async ({ browser }) => {
  // The preset's first bed, by index: OME-1960 put the partitions ahead of it.
  const dungeon = v.parse(RoomLayoutSchema, JSON.parse(readFileSync(join(ROOT, "assets/presets/dank-dungeon.json"), "utf8")));
  const BED = dungeon.furniture.findIndex((f) => f.kind === "bed");
  clients = await joinRoom(browser, { roomUrl: testRoom("lie", "bed").url, count: 2, nicknamePrefix: "sleeper" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = (await state(a.page)).self;
  const bId = (await state(b.page)).self;
  const key = (page: Page) => page.locator(`${site.lieKey}[data-lie="${String(BED)}"]`);
  const sideOf = async (page: Page, id: string): Promise<number | null> => (await state(page)).room.members.find((m) => m.id === id)?.sleeper ?? null;

  await expect(key(a.page)).toHaveAccessibleName("Lie down on the bed");
  await key(a.page).click();
  await expect.poll(() => sideOf(b.page, aId), { timeout: 15_000 }).toBe(0);
  // The bed still has a side free: B's key lies down beside A.
  await expect(key(b.page)).toBeEnabled();
  await key(b.page).click();
  for (const page of [a.page, b.page]) {
    await expect.poll(() => sideOf(page, bId), { timeout: 15_000 }).toBe(1);
    expect(await lyingOf(page, aId)).toBe(BED);
    for (const id of [aId, bId]) await expect.poll(() => frame(page, id), { timeout: 15_000 }).toMatch(/^sleep\/\w+\/nw\/[01]$/);
    // The second nw bed is drawn after this one (further forward), so its back layer comes last: keep this bed's five.
    await expect
      .poll(async () => (await drawOrder(page)).filter((l) => l.startsWith("furniture/bed/velvet/nw/") || l.startsWith("furniture/bed/velvet/cover/nw/") || l === `avatar:${aId}` || l === `avatar:${bId}`).slice(0, 5), { timeout: 15_000 })
      .toEqual(["furniture/bed/velvet/nw/back", `avatar:${aId}`, "furniture/bed/velvet/cover/nw/0", `avatar:${bId}`, "furniture/bed/velvet/cover/nw/1"]);
  }
  await expect(key(a.page)).toHaveAccessibleName("Get up from the bed");

  // A gets up: their cover goes, B keeps their side.
  await key(a.page).click();
  await expect.poll(() => lyingOf(b.page, aId), { timeout: 15_000 }).toBeNull();
  expect(await sideOf(b.page, bId)).toBe(1);
  await expect.poll(async () => (await drawOrder(b.page)).filter((l) => l.startsWith("furniture/bed/velvet/cover/")), { timeout: 15_000 }).toEqual(["furniture/bed/velvet/cover/nw/1"]);
});

// OME-1807: a lie key is 44 px each way to a finger, and it never covers a seat key.
for (const [width, height] of [[390, 844], [844, 390], [1024, 768]] as const) {
  test(`the lie key is a 44 px target on a ${String(width)}x${String(height)} touch screen, clear of the seat keys`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("lie", "sofa").url, count: 1, nicknamePrefix: "touch", contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
    const [a] = clients;
    if (a === undefined) throw new Error("need a client");
    const key = a.page.locator(`${site.lieKey}[data-lie="${String(SOFA)}"]`);
    await key.scrollIntoViewIfNeeded();
    const box = await key.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    const covered = await a.page.locator(site.seat).evaluateAll((seats) =>
      seats.flatMap((s) => {
        const r = s.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.width > 0 && hit?.classList.contains("lie-key") === true ? [s.getAttribute("data-seat")] : [];
      }),
    );
    expect(covered).toEqual([]);
  });
}
