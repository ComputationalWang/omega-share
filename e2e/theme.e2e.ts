// Holiday themes (OME-1186, ADR 0052): `localStorage["omega.theme"]` forces one. The classic room gets the theme's wall
// decor, every avatar wears its hat, and the background effect runs, except under prefers-reduced-motion. The dates,
// override parsing, decor placement and particle pool are apps/web/test/theme.test.ts; the frame cost is QA's perf rows.
import * as v from "valibot";
import { devices, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const ThemeInfo = v.object({ id: v.nullable(v.string()), decor: v.number(), hats: v.number(), effect: v.number(), ticks: v.number() });

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
  await expect.poll(async () => (await theme(page))?.decor ?? 0).toBeGreaterThan(0);
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
}

const cases: [name: "desk" | "phone", options: BrowserContextOptions | undefined][] = [
  ["desk", undefined],
  ["phone", devices["Pixel 7"]],
];
for (const [name, options] of cases) {
  test(`${name}: a forced theme dresses the classic room, hats every avatar and runs its effect`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("theme", name).url, count: 1, nicknamePrefix: `th${name}`, setup: christmas, ...(options === undefined ? {} : { contextOptions: () => options }) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await expectThemed(page);
    await expectEffectRuns(page);
  });
}

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
  expect(await theme(page)).toEqual({ id: null, decor: 0, hats: 0, effect: 0, ticks: 0 });
});
