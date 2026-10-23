// Holiday themes (OME-1186, ADR 0052): `localStorage["omega.theme"]` forces one. The classic room gets the theme's wall
// decor, every avatar wears its hat, and the background effect runs, except under prefers-reduced-motion. The dates,
// override parsing, decor placement and particle pool are apps/web/test/theme.test.ts; the frame cost is QA's perf rows.
import * as v from "valibot";
import { devices, type BrowserContext, type Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { DEFAULT_LAYOUT } from "@omega/shared";
import { showLayout } from "../perf/show-layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const ThemeInfo = v.object({ id: v.nullable(v.string()), decor: v.number(), hats: v.number(), effect: v.number(), ticks: v.number(), worstTickMs: v.number() });

/** The dev handle (apps/web/src/main.ts `window.__omega.room.theme`): what the room view draws of the theme now. */
async function theme(page: Page): Promise<v.InferOutput<typeof ThemeInfo> | null> {
  const t = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "theme") : null;
    return typeof get === "function" ? (Reflect.apply(get, room, []) as unknown) : null;
  });
  return t === null ? null : v.parse(ThemeInfo, t);
}

/** Christmas (the heaviest effect) on any date; Smooth so a slow runner's probe can't settle Basic and stop the effect. */
const christmas = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    localStorage.setItem("omega.theme", "christmas");
    localStorage.setItem("omega.motion", "smooth");
  });
};

async function expectThemed(page: Page): Promise<void> {
  await expect.poll(async () => (await theme(page))?.id ?? null).toBe("christmas");
  // The real Christmas sheet (OME-1189): 2 window views, a garland on each of the 10 segments of both walls, 3 stockings.
  await expect.poll(async () => (await theme(page))?.decor ?? 0).toBe(25);
  await expect.poll(async () => (await theme(page))?.hats ?? 0).toBeGreaterThan(0);
}

/** How many times the room canvas has drawn (`window.__omega.room.roomRenders`). */
async function roomRenders(page: Page): Promise<number> {
  const n = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "roomRenders") : null;
    return typeof get === "function" ? (Reflect.apply(get, room, []) as unknown) : null;
  });
  return v.parse(v.number(), n);
}

async function expectEffectRuns(page: Page): Promise<void> {
  await expect.poll(async () => (await theme(page))?.effect ?? 0).toBeGreaterThan(0);
  const first = (await theme(page))?.ticks ?? 0;
  await expect.poll(async () => (await theme(page))?.ticks ?? 0).toBeGreaterThan(first);
  // The effect draws on its own canvas (QA OME-1206): over a second of ~30 ticks, the idle room itself only breathes.
  const ticks0 = (await theme(page))?.ticks ?? 0;
  const renders0 = await roomRenders(page);
  await page.waitForTimeout(1000);
  expect(((await theme(page))?.ticks ?? 0) - ticks0).toBeGreaterThan(10);
  expect((await roomRenders(page)) - renders0).toBeLessThanOrEqual(6);
  // Its own layer is small: a full-size one cost a phone ~2.5 ms a frame even when empty (QA OME-1211).
  const stage = await page.locator("canvas.scene").boundingBox();
  const fx = await page.locator("canvas.scene-fx").boundingBox();
  expect(stage !== null && fx !== null && fx.width * fx.height <= (stage.width * stage.height) / 3).toBe(true);
  // And a tick is cheap: reading the room canvas back once made it ~250 ms on a phone (QA OME-1212).
  expect((await theme(page))?.worstTickMs ?? Infinity).toBeLessThan(4);
}

test("desk: a forced theme dresses the classic room, hats every avatar and runs its effect", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("theme", "desk").url, count: 1, nicknamePrefix: "thdesk", setup: christmas });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expectThemed(page);
  await expectEffectRuns(page);
});

test("phone: decor and hats; the effect sleeps while the room window crops its band, and runs once the room is fitted", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("theme", "phone").url, count: 1, nicknamePrefix: "thphone", setup: christmas, contextOptions: () => devices["Pixel 7"] });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expectThemed(page);
  // The watch layout shows the floor around me, not the back walls: an effect there costs frames for little to see (QA OME-1216).
  await page.waitForTimeout(1000);
  expect((await theme(page))?.effect).toBe(0);
  expect((await theme(page))?.ticks).toBe(0);
  await page.getByTestId("room-zoom-fit").tap();
  await expectEffectRuns(page);
});

test("reduced motion: decor and hats stay, no effect", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("theme", "reduced").url, count: 1, nicknamePrefix: "thrm", setup: christmas, contextOptions: () => ({ reducedMotion: "reduce" }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expectThemed(page);
  const t = await theme(page);
  expect(t?.effect).toBe(0);
  expect(t?.ticks).toBe(0);
});

test("off: no theme at all", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("theme", "off").url,
    count: 1,
    nicknamePrefix: "thoff",
    setup: async (context) => {
      await context.addInitScript(() => {
        localStorage.setItem("omega.theme", "off");
      });
    },
  });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  // Wait until I'm drawn in the room, so a theme would have shown by now.
  await expect.poll(async () => (await theme(page)) !== null).toBe(true);
  await page.waitForTimeout(500);
  expect(await theme(page)).toEqual({ id: null, decor: 0, hats: 0, effect: 0, ticks: 0, worstTickMs: 0 });
});

/** No holiday theme, Smooth, and the room shown in the night mood (OME-1689: its ambience snows on the theme effect's pool). */
const nightNoTheme = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    localStorage.setItem("omega.theme", "off");
    localStorage.setItem("omega.motion", "smooth");
  });
  await showLayout(context, { ...DEFAULT_LAYOUT, mood: "night" });
};

test("mood ambience: the night mood snows on the effect's own small layer, with no theme", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("theme", "ambience").url, count: 1, nicknamePrefix: "thamb", setup: nightNoTheme });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expectEffectRuns(page);
  expect((await theme(page))?.id).toBeNull();
});

test("mood ambience: reduced motion, no snow", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("theme", "ambience-rm").url, count: 1, nicknamePrefix: "thambrm", setup: nightNoTheme, contextOptions: () => ({ reducedMotion: "reduce" }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect.poll(async () => (await theme(page)) !== null).toBe(true);
  await page.waitForTimeout(500);
  const t = await theme(page);
  expect(t?.effect).toBe(0);
  expect(t?.ticks).toBe(0);
});
