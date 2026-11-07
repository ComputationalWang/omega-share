// What the room's window shows at 1280×800 and on a Pixel 7, read off the screenshot's pixels. Nothing on, the curtain
// keeps a player's box (OME-2347), so the room's window is the one a video gets. The geometry is
// apps/web/test/{wide-layout,band-wall,touch-home}.test.ts.
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
 * corner. Its top-left may be the TV's, which takes the free corner over the left wall (OME-2233). */
const backdrop = (g: Geometry, px: (x: number, y: number) => readonly [number, number, number]) => px(g.clip.x + 2, g.clip.y + g.clip.h - 2);

// OME-2347 (audit OME-2344 item 2): a video starting in an empty room moved the TV, its shelf and the room on every
// screen (CLS 0.035–0.068 for the members who pressed nothing). Nothing on, the curtain keeps a player's box: when another
// member's video comes on, the TV, its shelf, the room's window and the fields stay where they were.
for (const [name, label, options] of [["idle1280", "1280×800", { viewport: { width: 1280, height: 800 } }], ["idlepixel7", "Pixel 7 upright", PIXEL_7], ["idleland7", "Pixel 7 sideways", { ...PIXEL_7, viewport: { width: 915, height: 412 } }]] as const) {
  test(`${label}: a video coming on moves neither the TV, its shelf, the room's window nor the fields`, async ({ browser, request }) => {
    const page = await open(browser, name, options);
    const boxes = (): Promise<string[]> => page.evaluate(() => [".tv.ui-tv-frame", ".controls.ui-tv-shelf", "[data-testid=room-window]", "[data-testid=chat-input]", "[data-testid=queue-url]"].map((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      // Where each starts and how wide (a layout shift is a moved start): upright, the chat's first line takes the window's foot.
      return r === undefined || r.width === 0 ? `${sel} none` : `${sel} ${[r.x, r.y, r.width].map(Math.round).join(",")}`;
    }));
    const before = await boxes();
    await shareProvider(request, "https://youtu.be/rckeep00001", testRoom("room-clip", name).id);
    await expect(page.locator(`${site.tv} iframe`)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    expect(await boxes()).toEqual(before);
  });
}

/** Doorstep desk (OME-2306): upright, the room is a strip under the picture, framed on me, with the panel (invite, tabs,
 * composer) under it. It can't also hold the walls' art to the floor (OME-2300) at half the screen (OME-2325): what it
 * keeps whole is me, under the shelf and 8 px clear of the zoom keys' row. */
async function meWhole(page: Page): Promise<void> {
  const g = await geometry(page);
  const shelf = await page.locator(".controls.ui-tv-shelf").boundingBox();
  const keys = await page.locator(".room-zoom").boundingBox();
  const tag = await page.locator(site.nicknameTag).boundingBox();
  if (shelf === null || keys === null || tag === null) throw new Error("no shelf, keys or tag");
  expect(shelf.y + shelf.height, "the shelf ends over the window").toBeLessThanOrEqual(g.clip.y + 1);
  // Whole under the shelf: the camera centres me from my head to my tag's foot (layout.ts touchHome), and a tag on my hair (OME-2252) can sit a few px over that.
  expect(tag.y, "my tag whole under the shelf").toBeGreaterThanOrEqual(Math.max(g.clip.y, shelf.y + shelf.height));
  expect(tag.y + tag.height + CLEAR, "my tag 8 px over the keys' row").toBeLessThanOrEqual(keys.y);
  expect(g.clip.h, "the strip's floor").toBeGreaterThanOrEqual(96);
}

test("Pixel 7 upright, nothing on: the strip is framed on me, whole between the shelf and the keys", async ({ browser }) => {
  await meWhole(await open(browser, "idlepixel7", PIXEL_7));
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

// OME-2300 (judge round 11): 1280×800's window looked from the walls' art (stage y 113), so the walls' corner and its post
// (stage y 0, x 480) started at the shelf's foot, cut. The window holds the corner 8 px under its top, the sky over it.
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
  // OME-2323 (judge round 12): the window was 660×563 right of an empty column, 36 % of the screen.
  const vp = page.viewportSize();
  if (vp === null) throw new Error("no viewport");
  expect(g.clip.w * g.clip.h, "the room's window covers ≥ 45 % of the screen").toBeGreaterThanOrEqual(0.45 * vp.width * vp.height);
}

// Nothing on lays out as a video does (OME-2347, above), so these hold for an empty room too.
for (const [name, preset] of [["play1280", undefined], ["playstudio", "studio"], ["playpenthouse", "penthouse"]] as const) {
  test(`1280×800, a video on${preset === undefined ? "" : `, ${preset}`}: the walls' corner is whole, 8 px under the window's top`, async ({ browser, request }) => {
    await shareProvider(request, "https://youtu.be/rcplay00001", testRoom("room-clip", name).id);
    const page = await open(browser, name, { viewport: { width: 1280, height: 800 } }, preset, true);
    await cornerWhole(page);
  });
}

// OME-2300: a Pixel 7 upright with a video plays looked at the middle of the seats and me, so the back wall's desk went
// under the shelf and the floor's front under the pan hint. The window looks as high as the seats and me stay whole 8 px
// over the zoom keys (the hint is over the walls now, OME-2325): the desk is whole 8 px under the shelf, every seat 8 px
// over the keys' row.
test("Pixel 7 upright, a video on: the strip is framed on me, whole between the shelf and the keys", async ({ browser, request }) => {
  await shareProvider(request, "https://youtu.be/rcplay00002", testRoom("room-clip", "playpixel7").id);
  await meWhole(await open(browser, "playpixel7", PIXEL_7, undefined, true));
});
// OME-2325 (judge round 12): the pan hint sat on the floor's front tip, over seats. The strip is the floor now (OME-2306),
// so the hint sits beside the zoom keys at its foot: inside the window, never on me or the keys.
for (const [name, playing] of [["hint7", false], ["hintplay7", true]] as const) {
  test(`Pixel 7 upright, ${playing ? "a video on" : "nothing on"}: the pan hint is in the window, clear of me and the keys`, async ({ browser, request }) => {
    if (playing) await shareProvider(request, "https://youtu.be/rcplay00003", testRoom("room-clip", name).id);
    const page = await open(browser, name, PIXEL_7, undefined, playing);
    const skip = page.locator(site.hintSkip);
    if (await skip.isVisible()) await skip.tap();
    const hint = page.getByTestId("room-pan-hint");
    await expect(hint).toBeVisible();
    const g = await geometry(page);
    const [box, tag, keys] = await Promise.all([hint.boundingBox(), page.locator(site.nicknameTag).boundingBox(), page.locator(".room-zoom").boundingBox()]);
    if (box === null || tag === null || keys === null) throw new Error("no hint, tag or keys");
    expect(box.y, "the hint in the window").toBeGreaterThanOrEqual(g.clip.y);
    expect(box.y + box.height, "the hint in the window").toBeLessThanOrEqual(g.clip.y + g.clip.h);
    expect(box.y >= tag.y + tag.height || box.y + box.height <= tag.y || box.x + box.width <= tag.x || box.x >= tag.x + tag.width, "the hint clear of my tag").toBe(true);
    expect(box.x + box.width, "the hint left of the keys").toBeLessThanOrEqual(keys.x);
  });
}
