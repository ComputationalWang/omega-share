// OME-2282 (judge round 10 on OME-2061): with nothing on, 1280×800's room band was 366 px, so it looked at the seats: the
// walls' art (the window, the poster) went under the TV's shelf, and from the north the floor and the front furniture went
// under the column's foot. A Pixel 7's window did the same to the art. The empty TV's curtain gives the room the height
// now, and the window looks from the art's top (stage y 113) to the floor's front corner (y 540), 8 px clear. Read off
// the screenshot's pixels. The geometry is apps/web/test/{wide-layout,band-wall,touch-home}.test.ts.
import { devices, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { presetFile, showLayout } from "../perf/show-layout";
import { shareProvider } from "../perf/providers";
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

async function open(browser: Browser, name: RoomName<"room-clip">, options: BrowserContextOptions, preset?: string, playing = false): Promise<Page> {
  const layout = preset === undefined ? undefined : presetFile(preset);
  clients = await joinRoom(browser, { roomUrl: testRoom("room-clip", name).url, count: 1, nicknamePrefix: `rc${name}`, contextOptions: () => options, ...(layout === undefined ? {} : { setup: (c) => showLayout(c, layout) }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(playing ? page.locator(`${site.tv} iframe`) : page.locator(site.tvEmpty)).toBeVisible({ timeout: 10_000 });
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

/** The room's backdrop: the window's bottom-left corner, left of the walls' ends (stage x 150) and under the floor's left
 * corner. Its top-left may be the curtain's, which takes the free corner over the left wall (OME-2300). */
const backdrop = (g: Geometry, px: (x: number, y: number) => readonly [number, number, number]) => px(g.clip.x + 2, g.clip.y + g.clip.h - 2);

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

// OME-2329: a reload can paint the page's markup before main.ts runs. That frame is the entry view, the footer under the
// fold; once the room view opens, it's at the window's foot (room.coldCls.desktop 0.014 on its own, 0.060 with a late TV).
// Until main.ts has picked the view, the footer isn't drawn.
test("1280×800, the entry script held: the footer isn't drawn until the room view opens", async ({ browser }) => {
  const page = await open(browser, "boot1280", { viewport: { width: 1280, height: 800 } });
  let release = (): void => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/(src\/main\.ts|assets\/index-[^/]*\.js)$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: "commit" });
  const footer = page.locator("footer.site-footer");
  await expect(footer).toBeAttached();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await footer.evaluate((f) => f.checkVisibility({ visibilityProperty: true }))).toBe(false);
  release();
  await expect(page.locator(site.tvEmpty)).toBeVisible();
  await expect(footer).toBeVisible();
});

// OME-2300 (judge round 11): with nothing on, 1280×800's window looked from the walls' art (stage y 113), so the walls'
// corner and its post (stage y 0, x 480) started at the shelf's foot, cut. The curtain takes the free corner over the left
// wall now, as Room view's TV does (OME-2233), and the window holds the corner 8 px under its top, the sky over it.
async function cornerWhole(page: Page): Promise<void> {
  const g = await geometry(page);
  const px = await pixels(page, g);
  const bg = backdrop(g, px);
  const corner = g.at(480, 0);
  expect(corner.y, "the walls' corner 8 px under the window's top").toBeGreaterThanOrEqual(g.clip.y + CLEAR);
  expect(near(px(corner.x, corner.y - 4), bg), "the sky over the walls' corner").toBe(true);
  expect(near(px(corner.x, corner.y + 4), bg), "the walls' corner").toBe(false);
  const shelf = await page.locator(".controls.ui-tv-shelf").boundingBox();
  if (shelf === null) throw new Error("no shelf");
  expect(shelf.y + shelf.height).toBeLessThanOrEqual(g.clip.y);
  // OME-2323 (judge round 12): the window was 660×563 right of an empty column under the curtain, 36 % of the screen.
  const vp = page.viewportSize();
  if (vp === null) throw new Error("no viewport");
  expect(g.clip.w * g.clip.h, "the room's window covers ≥ 45 % of the screen").toBeGreaterThanOrEqual(0.45 * vp.width * vp.height);
  // Nothing on, the curtain's frame (6 px bezel) ends over the left wall's top, from the walls' corner (480, 0) to its end (150, 165).
  if (!(await page.locator(site.tvEmpty).isVisible())) return;
  const tv = await page.locator(site.tv).boundingBox();
  if (tv === null) throw new Error("no TV");
  for (let x = 150; x <= 480; x += 2) {
    const p = g.at(x, (480 - x) / 2);
    if (p.x <= tv.x + tv.width + 6) expect(p.y, `the left wall's top at stage x ${String(x)}`).toBeGreaterThanOrEqual(tv.y + tv.height + 6);
  }
}

for (const [name, preset, playing] of [["idle1280", undefined, false], ["studio", "studio", false], ["penthouse", "penthouse", false], ["play1280", undefined, true], ["playstudio", "studio", true], ["playpenthouse", "penthouse", true]] as const) {
  test(`1280×800, ${playing ? "a video on" : "nothing on"}${preset === undefined ? "" : `, ${preset}`}: the walls' corner is whole, 8 px under the window's top`, async ({ browser, request }) => {
    if (playing) await shareProvider(request, "https://youtu.be/rcplay00001", testRoom("room-clip", name).id);
    const page = await open(browser, name, { viewport: { width: 1280, height: 800 } }, preset, playing);
    await cornerWhole(page);
  });
}

/** The default room's back-wall desk's top (its projector), stage px (ROOM_VIEW). */
const DESK_TOP = 198;

// OME-2300: a Pixel 7 upright with a video plays looked at the middle of the seats and me, so the back wall's desk went
// under the shelf and the floor's front under the pan hint. The window looks as high as the seats and me stay whole 8 px
// over the zoom keys and the hint: the desk is whole 8 px under the shelf, every seat 8 px over the keys' row.
test("Pixel 7 upright, a video on: the back wall's desk and both seat rows are whole, 8 px clear of the shelf and the hint", async ({ browser, request }) => {
  await shareProvider(request, "https://youtu.be/rcplay00002", testRoom("room-clip", "playpixel7").id);
  const page = await open(browser, "playpixel7", PIXEL_7, undefined, true);
  const g = await geometry(page);
  const shelf = await page.locator(".controls.ui-tv-shelf").boundingBox();
  const keys = await page.locator(".room-zoom").boundingBox();
  if (shelf === null || keys === null) throw new Error("no shelf or keys");
  const hint = await page.locator(".room-pan-hint").boundingBox();
  const floor = Math.min(keys.y, hint?.y ?? Infinity);
  expect(g.at(480, DESK_TOP).y, "the desk's top under the shelf").toBeGreaterThanOrEqual(Math.max(g.clip.y, shelf.y + shelf.height) + CLEAR);
  const seats = await page.locator(site.seat).evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.bottom] as const; }));
  expect(seats.length).toBeGreaterThanOrEqual(8);
  for (const [top, bottom] of seats) {
    expect(top).toBeGreaterThanOrEqual(g.clip.y + CLEAR);
    expect(bottom + CLEAR).toBeLessThanOrEqual(floor);
  }
});

/** The drawn floor, a diamond, stage px (layout.ts: its top corner at (480, 220), 10 tiles of 64×32 each way). */
const FLOOR = { x: 480, y: 380, rx: 320, ry: 160 } as const;

// OME-2325 (judge round 12): a Pixel 7 upright kept the cropped 1× window (OME-2234), and its pan hint sat on the floor's
// front tip. The hint is clear of the drawn floor now, idle and playing, and the room keeps half the viewport.
for (const [name, playing] of [["hint7", false], ["hintplay7", true]] as const) {
  test(`Pixel 7 upright, ${playing ? "a video on" : "nothing on"}: the pan hint is clear of the drawn floor`, async ({ browser, request }) => {
    if (playing) await shareProvider(request, "https://youtu.be/rcplay00003", testRoom("room-clip", name).id);
    const page = await open(browser, name, PIXEL_7, undefined, playing);
    const skip = page.locator(site.hintSkip);
    if (await skip.isVisible()) await skip.tap();
    const hint = page.getByTestId("room-pan-hint");
    await expect(hint).toBeVisible();
    const box = await hint.boundingBox();
    if (box === null) throw new Error("no hint");
    const g = await geometry(page);
    const o = g.at(0, 0);
    const k = g.at(1, 0).x - o.x;
    const [x0, x1, y0, y1] = [(box.x - o.x) / k, (box.x + box.width - o.x) / k, (box.y - o.y) / k, (box.y + box.height - o.y) / k];
    // The box's nearest point to the diamond's centre, in the diamond's own norm: over 1 is outside it.
    const dx = Math.max(0, x0 - FLOOR.x, FLOOR.x - x1);
    const dy = Math.max(0, y0 - FLOOR.y, FLOOR.y - y1);
    expect(dx / FLOOR.rx + dy / FLOOR.ry, "the hint's box against the floor").toBeGreaterThan(1);
    if (!playing) expect(g.clip.h / (PIXEL_7.viewport.height), "the room window's share of the viewport height").toBeGreaterThanOrEqual(0.5);
  });
}
