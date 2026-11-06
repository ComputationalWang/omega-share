// OME-2282 (judge round 10 on OME-2061): with nothing on, 1280×800's room band was 366 px, so it looked at the seats: the
// walls' art (the window, the poster) went under the TV's shelf, and from the north the floor and the front furniture went
// under the column's foot. A Pixel 7's window did the same to the art. The empty TV's curtain gives the room the height
// now, and the window looks from the art's top (stage y 113) to the floor's front corner (y 540), 8 px clear. Read off
// the screenshot's pixels. The geometry is apps/web/test/{wide-layout,band-wall,touch-home}.test.ts.
import { devices, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { presetFile, showLayout } from "../perf/show-layout";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

/** The tallest wall art's top and the floor's front corner, stage px (layout.ts BAND_WALL_TOP, FLOOR_FOOT). */
const ART_TOP = 113;
const FLOOR_FOOT = 540;
/** How far inside the room's window its lowest painted row must sit. */
const CLEAR = 8;
const PIXEL_7 = devices["Pixel 7"];

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function open(browser: Browser, name: RoomName<"room-clip">, options: BrowserContextOptions, preset?: string): Promise<Page> {
  const layout = preset === undefined ? undefined : presetFile(preset);
  clients = await joinRoom(browser, { roomUrl: testRoom("room-clip", name).url, count: 1, nicknamePrefix: `rc${name}`, contextOptions: () => options, ...(layout === undefined ? {} : { setup: (c) => showLayout(c, layout) }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.tvEmpty)).toBeVisible();
  // The room's art is in and the window has settled on its home.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(500);
  return page;
}

interface Geometry {
  /** The room's window, page px. */
  readonly clip: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Stage px to page px. */
  readonly at: (x: number, y: number) => { readonly x: number; readonly y: number };
}

async function geometry(page: Page): Promise<Geometry> {
  const g = await page.evaluate(() => {
    const clip = document.querySelector("[data-testid=room-window]")?.getBoundingClientRect();
    const floor = document.querySelector<HTMLElement>("[data-testid=walk-floor]");
    const f = floor?.getBoundingClientRect();
    if (clip === undefined || floor === null || f === undefined) return null;
    return { clip: { x: clip.x, y: clip.y, w: clip.width, h: clip.height }, left: f.left, top: f.top, k: f.width / floor.offsetWidth };
  });
  if (g === null) throw new Error("no room window");
  return { clip: g.clip, at: (x, y) => ({ x: g.left + x * g.k, y: g.top + y * g.k }) };
}

/** The screenshot's pixels (CSS px) in the room's window, decoded on a blank page of the same context. */
async function pixels(page: Page, g: Geometry): Promise<(x: number, y: number) => readonly [number, number, number]> {
  const png = (await page.screenshot({ scale: "css" })).toString("base64");
  const r = { x: Math.floor(g.clip.x), y: Math.floor(g.clip.y), w: Math.ceil(g.clip.w) + 1, h: Math.ceil(g.clip.h) + 1 };
  const blank = await page.context().newPage();
  const raw = await blank.evaluate(async ({ src, r }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d");
    if (g === null) throw new Error("no 2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(r.x, r.y, r.w, r.h).data;
    let s = "";
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return btoa(s);
  }, { src: png, r });
  await blank.close();
  const data = Buffer.from(raw, "base64");
  return (x, y) => {
    const i = ((Math.round(y) - r.y) * r.w + (Math.round(x) - r.x)) * 4;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
  };
}

const near = (a: readonly number[], b: readonly number[]): boolean => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) <= 40;

/** The room's backdrop: the window's top-left corner, left of the walls' ends (stage x 150). */
const backdrop = (g: Geometry, px: (x: number, y: number) => readonly [number, number, number]) => px(g.clip.x + 2, g.clip.y + 2);

/** Where the walls' top edge is at the art's top (stage y 113: the walls slope 1:2 from the corner, x 480 at y 0), the
 * window shows the backdrop just over it and the wall just under it: nothing on the walls is cut at the window's top. */
async function artWhole(page: Page): Promise<void> {
  const g = await geometry(page);
  const px = await pixels(page, g);
  const bg = backdrop(g, px);
  for (const x of [480 - 2 * ART_TOP, 480 + 2 * ART_TOP]) {
    const sky = g.at(x, ART_TOP - 2);
    expect(sky.y, `stage (${String(x)}, ${String(ART_TOP - 2)}) in the window`).toBeGreaterThanOrEqual(g.clip.y);
    expect(near(px(sky.x, sky.y), bg), `the backdrop over the wall at stage x ${String(x)}`).toBe(true);
    const wall = g.at(x, ART_TOP + 4);
    expect(near(px(wall.x, wall.y), bg), `the wall under it at stage x ${String(x)}`).toBe(false);
  }
}

/** The window's last CLEAR rows, across it, are the backdrop: the floor's front corner and every piece end above them. */
async function floorWhole(page: Page): Promise<void> {
  const g = await geometry(page);
  const px = await pixels(page, g);
  const bg = backdrop(g, px);
  const foot = Math.floor(g.clip.y + g.clip.h) - 1;
  for (let y = foot; y > foot - CLEAR; y--) {
    const hit: number[] = [];
    for (let x = Math.ceil(g.clip.x) + 1; x < g.clip.x + g.clip.w - 1; x++) if (!near(px(x, y), bg)) hit.push(x);
    expect(hit, `row ${String(y)}, ${String(foot - y)} px over the window's foot, painted at x ${hit.slice(0, 8).join(",")}`).toEqual([]);
  }
  // And the floor's corner itself is in it: painted just above its foot, the backdrop just below.
  const corner = g.at(480, FLOOR_FOOT);
  expect(near(px(corner.x, corner.y - 4), bg)).toBe(false);
  expect(near(px(corner.x, corner.y + 4), bg)).toBe(true);
  expect(corner.y + CLEAR).toBeLessThanOrEqual(g.clip.y + g.clip.h);
}

for (const [name, preset] of [["idle1280", undefined], ["studio", "studio"], ["penthouse", "penthouse"]] as const) {
  test(`1280×800, nothing on${preset === undefined ? "" : `, ${preset}`}: the walls' art clears the shelf and the floor clears the column's foot`, async ({ browser }) => {
    const page = await open(browser, name, { viewport: { width: 1280, height: 800 } }, preset);
    await artWhole(page);
    await floorWhole(page);
  });
}

test("Pixel 7 upright, nothing on: the walls' art clears the shelf and the floor's corner the window's foot", async ({ browser }) => {
  const page = await open(browser, "idlepixel7", PIXEL_7);
  const g = await geometry(page);
  // Sideways the window crops the room by design (its pan hint says so, OME-2234); upright it holds the art to the floor.
  // From the stage as drawn (the zoom keys and the pan hint float over the window's foot and its corner, OME-2171).
  expect(g.at(480, ART_TOP).y).toBeGreaterThanOrEqual(g.clip.y);
  expect(g.at(480, FLOOR_FOOT).y + CLEAR).toBeLessThanOrEqual(g.clip.y + g.clip.h);
  // The shelf ends over the window: what the window shows from its top row is the room's.
  const shelf = await page.locator(".controls.ui-tv-shelf").boundingBox();
  if (shelf === null) throw new Error("no shelf");
  expect(shelf.y + shelf.height).toBeLessThanOrEqual(g.clip.y + 1);
});

// The curtain's height follows the column's now, so the column must not change as the room comes in: the head row (Leave,
// sound, People) showed only at the first snapshot and took 35 px from it, and the TV, its shelf and the room moved up
// (room.coldCls.desktop 0.005 → 0.016). With the server's messages held, the TV and the room are where they end up from the
// first paint of the reserved room.
test("1280×800, nothing on, loading slowly: the TV and the room's window don't move as the room comes in", async ({ browser }) => {
  const page = await open(browser, "slow1280", { viewport: { width: 1280, height: 800 } });
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => setTimeout(() => { ws.send(m); }, 1500));
  });
  await page.reload();
  const boxes = (): Promise<string> => page.evaluate(() => ["[data-testid=room-window]", ".tv.ui-tv-frame"].map((s) => JSON.stringify(document.querySelector(s)?.getBoundingClientRect())).join(" "));
  await expect(page.locator(".stage-wrap.is-reserved")).toBeAttached();
  const early = await boxes();
  await expect(page.locator(site.tvEmpty)).toBeVisible();
  await expect(page.locator(".stage-wrap.is-reserved")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await boxes()).toBe(early);
});
