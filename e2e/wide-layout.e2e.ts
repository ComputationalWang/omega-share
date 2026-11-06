// The desktop wide layout (OME-642, M7 W7). At ≥ 1024 px wide (landscape) the room page is two columns: the TV, its
// shelf and the room on the left, the chat (log, field) and Up next in a full-height column on the right, so at
// 1280×720 and up nothing you need while watching is below the fold. The volume pod sits in the TV's shelf, right under
// the picture, on every layout. Enter (nothing that takes Enter focused) jumps to the chat field; Esc hands the keys
// back. The pure geometry is apps/web/test/wide-layout.test.ts; the key decision is apps/web/test/chat-enter.test.ts.
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { providerCase, shareProvider, waitProviderPlaying } from "../perf/providers";
import { presetFile, showLayout } from "../perf/show-layout";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const DESKTOP = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height } });
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** The viewer chose the video-first layout on an earlier visit (OME-2195): Room view is the default from 1100 px. */
const videoFirst = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    localStorage.setItem("omega.roomView", "off");
  });
};

async function one(browser: Browser, name: RoomName<"wide">, options: BrowserContextOptions, setup?: (context: BrowserContext) => Promise<void>): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("wide", name).url, count: 1, nicknamePrefix: `wd${name}`, contextOptions: () => options, ...(setup === undefined ? {} : { setup }) });
  const c = clients[0];
  if (c === undefined) throw new Error("no client");
  await expect(c.page.locator(site.chatInput)).toBeVisible();
  return c.page;
}

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}

/** Wholly inside the viewport, with the page not scrolled. */
async function inView(page: Page, l: Locator): Promise<void> {
  const b = await box(l);
  const vp = page.viewportSize();
  if (vp === null) throw new Error("no viewport");
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
}

async function volumeUnderPicture(page: Page): Promise<void> {
  const tv = await box(page.locator(site.tv));
  const pod = await box(page.locator(".ui-volume"));
  if (await page.locator(site.tvEmpty).isVisible() && await page.locator(".stage-wrap.is-tv-corner").count() > 0) {
    // Nothing on (OME-2300): the curtain takes the corner over the left wall, its shelf beside it, as Room view's TV (OME-2233).
    expect(pod.x).toBeGreaterThanOrEqual(tv.x + tv.width);
    expect(pod.y + pod.height).toBeLessThanOrEqual(tv.y + tv.height);
  } else {
    // The pod's top edge within 16 px of the video's bottom edge, and not over the picture (ADR 0012).
    expect(pod.y).toBeGreaterThanOrEqual(tv.y + tv.height);
    expect(pod.y - (tv.y + tv.height)).toBeLessThanOrEqual(16);
  }
  // In the same bar as the shared transport.
  const play = await box(page.locator(site.playToggle));
  expect(Math.abs(play.y + play.height / 2 - (pod.y + pod.height / 2))).toBeLessThanOrEqual(8);
}

for (const [name, w, h] of [["w1280", 1280, 720], ["w1920", 1920, 1080], ["w2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: the chat is a full-height column beside the room; everything you need is in view, unscrolled`, async ({ browser }) => {
    const page = await one(browser, name, DESKTOP(w, h));
    await page.locator(site.chatInput).fill("hello from the side");
    await page.locator(site.chatInput).press("Enter");
    const latest = page.locator(site.chatLogLine).last();
    await expect(latest).toContainText("hello from the side");

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    for (const l of [site.tv, site.playToggle, site.muteToggle, site.roomWindow, site.chatInput, site.chatSend, site.queuePanel]) await inView(page, page.locator(l));
    await inView(page, latest);
    // The page itself doesn't scroll.
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(h);

    // Two columns: the chat right of the room, running (nearly) the window's height.
    const room = await box(page.locator(site.roomWindow));
    const log = await box(page.locator(site.chatLog));
    const input = await box(page.locator(site.chatInput));
    expect(log.x).toBeGreaterThanOrEqual(room.x + room.width);
    expect(input.x).toBeGreaterThanOrEqual(room.x + room.width);
    expect(input.y + input.height).toBeGreaterThan(h - 120);
    // The chat log is still the polite live region.
    await expect(page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
    // The room is a fair size: the canvas isn't squeezed to a sliver.
    expect(room.width).toBeGreaterThanOrEqual(430);

    await volumeUnderPicture(page);
    await expect(page.locator(site.chatInput)).toHaveAttribute("placeholder", "Press Enter to chat");
  });
}

// OME-1803 (design OME-1799 §2): with a video playing the TV was a small island, 25–30 % of a big monitor's width. It's
// the hero now: at least 45 % of the window (43 % at 1920×1080, where the band holds half the room, ADR 0059) and as wide as its shelf, with the room and the transport still in view and
// the page unscrolled. At 1280×800 it's no smaller than before (360 px). Room view opens first from 1100 px (OME-2195):
// these viewers chose video first.
for (const [name, w, h, share] of [["hero1280", 1280, 800, 0], ["hero1440", 1440, 900, 0.45], ["hero1920", 1920, 1080, 0.43], ["hero2560", 2560, 1440, 0.45]] as const) {
  test(`${String(w)}×${String(h)} with a video: the TV is the hero, the room and the transport stay in view`, async ({ browser, request }) => {
    const room = testRoom("wide", name);
    await shareVideo(request, room.id);
    const page = await one(browser, name, DESKTOP(w, h), videoFirst);
    await waitPlaying(clients);
    await expect(page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "false");
    const tv = await box(page.locator(site.tv));
    const shelf = await box(page.locator(".ui-tv-shelf"));
    expect(tv.width).toBeGreaterThanOrEqual(Math.max(360, share * w));
    if (share > 0) expect(tv.width).toBeGreaterThanOrEqual(shelf.width - 1);
    for (const l of [site.tv, site.playToggle, site.muteToggle, site.roomWindow]) await inView(page, page.locator(l));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(h);
  });
}

// OME-2195 (judge round 4, ADR 0060 amendment 3): at 1280×800 video first left avatars ~27 px. From 1100 px wide the room
// opens in Room view: the TV at its floor, avatars at least 39 px. The viewer's choice is kept: off stays off next visit.
test("1280×800 with a video: a fresh visit opens in Room view; turned off, it stays off", async ({ browser, request }) => {
  const room = testRoom("wide", "rv1280");
  await shareVideo(request, room.id);
  const page = await one(browser, "rv1280", DESKTOP(1280, 800));
  await waitPlaying(clients);
  const key = page.locator(site.roomViewKey);
  await expect(key).toHaveAttribute("aria-pressed", "true");
  expect((await box(page.locator(site.tv))).width).toBeLessThanOrEqual(357);
  // I stand (just joined): a standing avatar is 47 px at 1× (ADR 0060 amendment 2: 41 seated to 47), as the judge measured it.
  const k = await page.locator(site.walkFloor).evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
  expect(47 * k).toBeGreaterThanOrEqual(40);
  for (const l of [site.tv, site.playToggle, site.muteToggle, site.roomWindow]) await inView(page, page.locator(l));
  // OME-2233 (judge round 5): no empty strip between the TV and its shelf; the shelf tops the TV's side.
  const tv = await box(page.locator(site.tv));
  const shelf = await box(page.locator(".controls.ui-tv-shelf"));
  expect(Math.abs(shelf.y - tv.y)).toBeLessThanOrEqual(2);
  // The room shows from its walls' tops (stage y 60) to the floor's front corner (540): the band isn't cut at the top.
  const win = await box(page.locator(site.roomWindow));
  expect(win.height).toBeGreaterThanOrEqual((541 - 60) * k - 1);
  expect(win.y).toBeGreaterThanOrEqual(shelf.y + shelf.height);
  const top = await page.locator(`${site.roomWindow} .stage`).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).f);
  expect(top).toBeGreaterThanOrEqual(-60 * k - 1);

  await key.click();
  await expect(key).toHaveAttribute("aria-pressed", "false");
  // The next visit, same browser: video first, as chosen.
  const c = clients[0];
  if (c === undefined) throw new Error("no client");
  const again = await c.context.newPage();
  await again.goto(room.url);
  await again.locator(site.nicknameInput).fill("wdrv-again");
  await again.locator(site.joinButton).click();
  await again.locator(site.room).waitFor();
  await expect(again.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "false");
  expect((await box(again.locator(site.tv))).width).toBeGreaterThan(360);
});

test("1024×768 with a video: below 1100 px a fresh visit stays video first", async ({ browser, request }) => {
  const room = testRoom("wide", "rv1024");
  await shareVideo(request, room.id);
  const page = await one(browser, "rv1024", DESKTOP(1024, 768));
  await waitPlaying(clients);
  await expect(page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "false");
});

/**
 * The screenshot's rows and columns (DPR 1 contexts): `rows[i]` counts the pixels in [x0, x1) of row y0 + i that differ
 * from `bg` (by more than 40 over the three channels); `white[j]` counts the near-white pixels (every channel ≥ 200) of
 * column wx0 + j over [y0, y1). Decoded on a blank page of the same context.
 */
async function scan(page: Page, a: { x0: number; x1: number; y0: number; y1: number; bg: readonly [number, number]; wx0: number; wx1: number }): Promise<{ rows: number[]; white: number[] }> {
  const png = (await page.screenshot()).toString("base64");
  const blank = await page.context().newPage();
  const out = await blank.evaluate(async ({ data, a }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d");
    if (g === null) throw new Error("no 2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const at = (x: number, y: number): number[] => [...d.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
    const bg = at(a.bg[0], a.bg[1]);
    const rows: number[] = [];
    for (let y = a.y0; y < a.y1; y++) {
      let n = 0;
      for (let x = a.x0; x < a.x1; x++) if (at(x, y).reduce((s, v, i) => s + Math.abs(v - (bg[i] ?? 0)), 0) > 40) n++;
      rows.push(n);
    }
    const white: number[] = [];
    for (let x = a.wx0; x < a.wx1; x++) {
      let n = 0;
      for (let y = a.y0; y < a.y1; y++) if (at(x, y).every((v) => v >= 200)) n++;
      white.push(n);
    }
    return { rows, white };
  }, { data: png, a });
  await blank.close();
  return out;
}

// OME-2241 (judge round 6 on OME-2061): Room view at 1280×800 left a ~520×100 px empty band between the shelf and the
// room (the box sank to the column's foot so the TV cleared the left wall), and the walls' tops were cut flat at the box's
// top. The room sits right under the shelf now, with sky over its walls. The player over the left wall's top is by design
// (ADR 0058), not checked here.
for (const preset of ["classic", "penthouse", "studio", "dank-dungeon"] as const) {
  test(`1280×800 Room view, ${preset}: the walls' tops show with sky over them, no empty band between the shelf and the room`, async ({ browser, request }) => {
    const name = `rv${preset}` as const;
    const room = testRoom("wide", name);
    await shareVideo(request, room.id);
    const layout = presetFile(preset);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `wd${name}`, setup: (context) => showLayout(context, layout), contextOptions: () => DESKTOP(1280, 800) });
    await waitPlaying(clients);
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await expect(page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "true");
    const tv = await box(page.locator(site.tv));
    const shelf = await box(page.locator(".controls.ui-tv-shelf"));
    const win = await box(page.locator(site.roomWindow));
    // The box is centred on the walls' corner (stage x 480), its tip the room's highest pixel; the sky's colour at the
    // box's top beside it. The canvas ends at the stage's top, so no star is over the tip.
    const shelfFoot = Math.ceil(shelf.y + shelf.height);
    const top = Math.round(win.y);
    const mid = Math.round(win.x + win.width / 2);
    const { rows } = await scan(page, { x0: mid - 40, x1: mid + 40, y0: shelfFoot, y1: top + 120, bg: [Math.ceil(tv.x + tv.width + 8), top + 1], wx0: 0, wx1: 0 });
    // Past the shelf's frame, the sky; then the room's first row.
    const sky = rows.findIndex((n) => n === 0);
    const first = shelfFoot + sky + rows.slice(sky).findIndex((n) => n > 0);
    expect(sky).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThanOrEqual(top + 8);
    // Nothing but sky from the shelf to it, the width of the column right of the TV (the walls slope away from the tip): at
    // most 60 px tall.
    expect(first - (shelfFoot + sky)).toBeLessThanOrEqual(60);
    // OME-2246 (judge round 7): ~35 px of nothing between the shelf and the room's window. At most the layout's 8 px
    // GAP; the walls' tip is the window's top plus its sky (the room's first painted row, 8 px under it).
    expect(top - shelfFoot).toBeLessThanOrEqual(8);
    expect(first - shelfFoot).toBeLessThanOrEqual(20);
    // The Room view key stays on top of the room: its centre is the key.
    const key = await box(page.locator(site.roomViewKey));
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid]")?.getAttribute("data-testid") ?? null, [key.x + key.width / 2, key.y + key.height / 2] as const)).toBe(await page.locator(site.roomViewKey).getAttribute("data-testid"));
  });
}

// OME-2241 (judge r6): the walk floor's focus ring is the stage's size (960×600), so in a band only its left edge showed, a
// 4 px white bar down the band. The ring is the room window's now, whole.
test("1280×800 Room view, a busy room: the floor's focus ring outlines the room's window, no stray bar at the column's edge", async ({ browser, request }) => {
  const room = testRoom("wide", "rvbusy");
  await shareVideo(request, room.id);
  const layout = presetFile("classic");
  clients = await joinRoom(browser, { roomUrl: room.url, count: 4, nicknamePrefix: "wdrvbusy", setup: (context) => showLayout(context, layout), contextOptions: () => DESKTOP(1280, 800) });
  await waitPlaying(clients);
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "true");
  // Keyboard modality, then the floor's focus (as walking with the arrow keys leaves it).
  await page.keyboard.press("Shift");
  const floor = page.locator(site.walkFloor);
  await floor.focus();
  expect(await floor.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  const win = await box(page.locator(site.roomWindow));
  const column = await box(page.locator(".stage-wrap"));
  const y0 = Math.ceil(win.y);
  const y1 = Math.floor(win.y + win.height);
  // Anywhere across the column: the bar was the stage's left edge, wherever the box puts it.
  const { white } = await scan(page, { x0: 0, x1: 0, y0, y1, bg: [0, 0], wx0: Math.max(0, Math.round(column.x) - 2), wx1: Math.round(column.x + column.width) });
  // The judge measured 437 px; the TV covers its top here, so any column of white over 200 px (no art is) counts, but
  // the ring's own sides at the window's edges.
  const tall = white.flatMap((n, i) => (n >= 200 ? [Math.max(0, Math.round(column.x) - 2) + i] : []));
  for (const x of tall) expect(Math.min(Math.abs(x - win.x), Math.abs(x - (win.x + win.width)))).toBeLessThanOrEqual(5);
  // Still a visible ring: on the room's window.
  expect(await page.locator(site.roomWindow).evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
});

// OME-1811 (design OME-1799 §2, F2; OME-1809 item 3): the room was drawn at fractional scales (0.87× at 2560, 1.17× at
// 1920), so its pixel rows doubled unevenly. On every large screen it's 1× or 2× now, nearest-neighbour, at DPR 1 and 2.
for (const [name, w, h] of [["int1280", 1280, 800], ["int1920", 1920, 1080], ["int2560", 2560, 1440]] as const) {
  for (const dpr of [1, 2]) {
    test(`${String(w)}×${String(h)} DPR ${String(dpr)}: the room is drawn at a whole number of device px per art px, nearest-neighbour`, async ({ browser }) => {
      const page = await one(browser, name, { ...DESKTOP(w, h), deviceScaleFactor: dpr });
      const k = await page.locator(site.walkFloor).evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
      expect([1, 2]).toContain(k);
      expect(Number.isInteger(k * dpr)).toBe(true);
      await expect(page.locator("canvas.scene")).toHaveCSS("image-rendering", "pixelated");
      // The band keeps the room on the page: in view, unscrolled.
      await inView(page, page.locator(site.roomWindow));
      expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(h);
    });
  }
}

// OME-1843 (design OME-1799 §2 m1/m2): with a video the room's band was a 960 px island in a wider column (the dim stopped
// at the room's box), and it looked at the room's middle, so the front row's name tags showed 1–5 px of 20. Its backdrop
// spans the column now and it looks at the audience: in the Theatre with four people standing, every name tag is whole.
for (const [name, w, h] of [["aud1280", 1280, 800], ["aud1920", 1920, 1080], ["aud2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)} Theatre with a video and 4 people: the band spans the column, every name tag whole in it`, async ({ browser, request }) => {
    const room = testRoom("wide", name);
    await shareVideo(request, room.id);
    const theatre = presetFile("cinema");
    clients = await joinRoom(browser, { roomUrl: room.url, count: 4, nicknamePrefix: `wd${name}`, setup: (context) => showLayout(context, theatre), contextOptions: () => DESKTOP(w, h) });
    await waitPlaying(clients);
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    const tags = page.locator(site.nicknameTag);
    await expect(tags).toHaveCount(4);
    const band = await box(page.locator(site.roomWindow));
    const column = await box(page.locator(".stage-wrap"));
    // The band's backdrop and dim bleed past the room's box to the column's edges.
    // Each side bleeds its own width (OME-2233: Room view's box can sit right of centre).
    const bleed = (side: "l" | "r"): Promise<number> => page.locator(site.roomWindow).evaluate((el, v) => (el.classList.contains("is-bleed") ? Number.parseFloat(getComputedStyle(el).getPropertyValue(v)) : 0), `--bleed-${side}`);
    expect(band.x - (await bleed("l"))).toBeLessThanOrEqual(column.x + 1);
    expect(band.x + band.width + (await bleed("r"))).toBeGreaterThanOrEqual(column.x + column.width - 1);
    // Once everyone has walked to their spot (a joiner walks in from the room's edge).
    await expect(async () => {
      for (const tag of await tags.all()) {
        const t = await box(tag);
        expect(t.y).toBeGreaterThanOrEqual(band.y);
        expect(t.y + t.height).toBeLessThanOrEqual(band.y + band.height);
        expect(t.x).toBeGreaterThanOrEqual(band.x);
        expect(t.x + t.width).toBeLessThanOrEqual(band.x + band.width);
      }
    }).toPass({ timeout: 10_000 });
  });
}

// OME-1811 (design OME-1799 §3, OME-1809 item 4): no text in the room page under 12 px on a computer.
test("1280×800 with a video: no visible text in the room page is under 12 px", async ({ browser, request }) => {
  const room = testRoom("wide", "type1280");
  await shareVideo(request, room.id);
  const page = await one(browser, "type1280", DESKTOP(1280, 800));
  await waitPlaying(clients);
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
    .filter((e) => [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "") && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .map((e) => ({ text: e.textContent.trim().slice(0, 30), cls: e.className, px: Number.parseFloat(getComputedStyle(e).fontSize) }))
    // font-size 0 is a label's text hidden behind its art (the share chip's), not small text.
    .filter((t) => t.px > 0 && t.px < 12));
  expect(small).toEqual([]);
});

/** Every visible key in the room's chrome (not the stage's seats and tags, not the site footer), with its size. */
const keys = (page: Page): Promise<{ name: string; w: number; h: number }[]> =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main summary, main [role=button]")]
    .filter((e) => e.closest(".stage-clip") === null && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 1 && r.height > 1)
    .map(({ e, r }) => ({ name: e.getAttribute("data-testid") ?? e.getAttribute("aria-label") ?? e.textContent.trim(), w: r.width, h: r.height })));

// OME-1667 (board): "Scalings on 2k and buttons need to be bigger." From 1920 px wide every key is at least 40×40, and
// at 2560×1440 the chrome is twice 1280's: the chat column, the shelf and the room fill the screen.
for (const [name, w, h] of [["w1920", 1920, 1080], ["w2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: every key in the room's chrome is at least 40×40`, async ({ browser }) => {
    const page = await one(browser, name, DESKTOP(w, h));
    const found = await keys(page);
    expect(found.map((k) => k.name)).toEqual(expect.arrayContaining(["play-toggle", "mute-toggle", "fullscreen-toggle", "chat-send", "chat-popout", "emote-key", "room-popout", "help-key"]));
    expect(found.filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// OME-1748: the moments strip's markers (OME-1628) are keys too: 16×14 zoomed, they were 24×21 at 1920 and 32×28 at
// 2560. At least 40×40 from 1920, 44×44 to the finger, and clear of the shelf above them.
for (const [name, opts, min] of [["mo1920", DESKTOP(1920, 1080), 40], ["mo2560", DESKTOP(2560, 1440), 40], ["mophone", PHONE, 44]] as const) {
  test(`${name}: a moments marker is at least ${String(min)}×${String(min)} and below the shelf`, async ({ browser, request }) => {
    const room = testRoom("wide", name);
    await shareVideo(request, room.id);
    const page = await one(browser, name, opts);
    await waitPlaying(clients);
    await page.getByTestId("reaction-bar").getByRole("button", { name: "Heart" }).click();
    const pip = page.getByTestId("moments-pip").first();
    await expect(pip).toBeVisible();
    const p = await box(pip);
    expect(p.width).toBeGreaterThanOrEqual(min - 0.5);
    expect(p.height).toBeGreaterThanOrEqual(min - 0.5);
    const play = await box(page.locator(site.playToggle));
    expect(p.y).toBeGreaterThanOrEqual(play.y + play.height);
    // OME-1756: a reaction in the first second sits at the strip's left end; the whole key stays on screen.
    expect(p.x).toBeGreaterThanOrEqual(-0.5);
    expect(p.x + p.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    if (min === 40) expect((await keys(page)).filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// QA OME-1696: People open narrowed the TV and the shelf stepped down to 27 px keys at 1920×1080; the People panel's
// own keys were 25 px tall.
for (const [name, w, h] of [["people1920", 1920, 1080], ["people2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)} with People open: every key in the room's chrome is still at least 40×40`, async ({ browser }) => {
    const page = await one(browser, name, DESKTOP(w, h));
    await page.locator(site.peopleKey).click();
    await expect(page.locator(site.peoplePanel)).toBeVisible();
    const found = await keys(page);
    expect(found.map((k) => k.name)).toEqual(expect.arrayContaining(["play-toggle", "mute-toggle", "fullscreen-toggle", "people-key"]));
    expect(found.filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// QA OME-1696: a Twitch VOD's shelf (the quality key, a 1:00:00 time) left its seek bar 12–16 px wide at 1920 and 2560;
// it was 177 px at 1280×720. Its quality list's options stayed 25 px tall.
for (const [name, w, h, z] of [["tw1920", 1920, 1080, 1.5], ["tw2560", 2560, 1440, 2]] as const) {
  test(`${String(w)}×${String(h)} Twitch VOD: the seek bar keeps its 1280 width, zoomed; the quality list's keys are at least 40 px`, async ({ browser, request }) => {
    const room = testRoom("wide", name);
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    const page = await one(browser, name, DESKTOP(w, h));
    await waitProviderPlaying(clients, "twitch");
    expect((await box(page.getByTestId("seek"))).width).toBeGreaterThanOrEqual(160 * z);
    await page.locator('[data-testid="quality-key"]').click();
    await expect(page.locator('[data-testid="quality-menu"]')).toBeVisible();
    const found = await keys(page);
    expect(found.map((k) => k.name)).toEqual(expect.arrayContaining(["quality-option"]));
    expect(found.filter((k) => k.w < 39.5 || k.h < 39.5)).toEqual([]);
  });
}

// QA OME-1696: the help dialog stayed 1×, a 520 px box of 12 px text in the middle of a 2560 screen.
test("2560×1440: the help dialog scales with the chrome and still fits the screen", async ({ browser }) => {
  const page = await one(browser, "help2560", DESKTOP(2560, 1440));
  await page.locator(site.helpKey).click();
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  expect((await box(dialog)).width).toBeGreaterThanOrEqual(1000);
  await inView(page, dialog);
});

test("2560×1440: the chrome scales up with the screen, no 1280 page floating in it", async ({ browser }) => {
  const page = await one(browser, "w2560", DESKTOP(2560, 1440));
  const side = await box(page.locator(site.chatLog));
  const shelf = await box(page.locator(".controls"));
  const room = await box(page.locator(site.roomWindow));
  const say = await box(page.locator(site.chatSend));
  expect(side.width).toBeGreaterThanOrEqual(560);
  expect(shelf.height).toBeGreaterThanOrEqual(80);
  expect(say.height).toBeGreaterThanOrEqual(70);
  // The room is height-bound at 16:9: the taller shelf and top row cost it a little width (1389 → 1225 px), not its fill.
  expect(room.width).toBeGreaterThanOrEqual(1200);
  // The field grows with its keys.
  expect((await box(page.locator(site.chatInput))).height).toBeGreaterThanOrEqual(70);
});

test("390×844 phone: the stacked layout stays, with the volume in the shelf under the picture", async ({ browser }) => {
  const page = await one(browser, "phone", PHONE);
  const tv = await box(page.locator(site.tv));
  const room = await box(page.locator(site.roomWindow));
  // No chat yet, so the empty log is folded (OME-2171): the chat row comes next.
  const chat = await box(page.locator(site.chatInput));
  // Stacked: TV, room window, chat row, top to bottom, all full width.
  expect(room.y).toBeGreaterThan(tv.y + tv.height);
  expect(chat.y).toBeGreaterThan(room.y + room.height);
  await volumeUnderPicture(page);
  // No sideways scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The desktop hint isn't a phone's (no Enter key to press).
  await expect(page.locator(site.chatInput)).not.toHaveAttribute("placeholder", "Press Enter to chat");
});

test("keyboard only: Enter → type → Enter sends and stays; Esc hands the keys back; Enter on a focused key keeps its meaning", async ({ browser }) => {
  const page = await one(browser, "keys", DESKTOP(1280, 720));
  const input = page.locator(site.chatInput);
  const focusedIs = (l: Locator): Promise<boolean> => l.evaluate((e) => e === document.activeElement);

  // Nothing focused.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Enter");
  expect(await focusedIs(input)).toBe(true);
  await page.keyboard.type("typed with keys only");
  await page.keyboard.press("Enter");
  await expect(page.locator(site.chatLogLine).last()).toContainText("typed with keys only");
  expect(await focusedIs(input)).toBe(true);
  await expect(input).toHaveValue("");
  // The field's ring shows.
  expect(await input.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe("none");

  await page.keyboard.press("Escape");
  expect(await focusedIs(input)).toBe(false);
  // A second Enter brings it back.
  await page.keyboard.press("Enter");
  expect(await focusedIs(input)).toBe(true);
  await page.keyboard.press("Escape");

  // A focused key keeps Enter: the mute key toggles and keeps focus.
  const mute = page.locator(site.muteToggle);
  await mute.focus();
  const pressed = await mute.getAttribute("aria-pressed");
  await page.keyboard.press("Enter");
  expect(await focusedIs(mute)).toBe(true);
  await expect(mute).not.toHaveAttribute("aria-pressed", pressed ?? "");
  expect(await focusedIs(input)).toBe(false);
  // A seat keeps it too (Enter sits; the chat field isn't focused).
  const seat = page.locator(site.seat).first();
  await seat.focus();
  await page.keyboard.press("Enter");
  expect(await focusedIs(input)).toBe(false);

  // Typing while the window crosses 1024 px (the chat moves column): the field keeps focus and the draft.
  await input.focus();
  await page.keyboard.type("half a line");
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") === null)).toBe(true);
  expect(await focusedIs(input)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") !== null)).toBe(true);
  expect(await focusedIs(input)).toBe(true);
  await expect(input).toHaveValue("half a line");
});

test("full screen: Enter jumps to the strip's chat field and it sends from there", async ({ browser }) => {
  const page = await one(browser, "fs", DESKTOP(1280, 720));
  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => page.evaluate((sel) => document.fullscreenElement?.matches(sel) === true, site.fsRoot)).toBe(true);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Enter");
  const input = page.locator(site.fsStrip).locator(site.chatInput);
  expect(await input.evaluate((e) => e === document.activeElement)).toBe(true);
  await page.keyboard.type("from the strip");
  await page.keyboard.press("Enter");
  await expect(page.locator(site.fsStrip).locator(site.chatLogLine).last()).toContainText("from the strip");
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  // Back on the page, the volume is under the picture again.
  await volumeUnderPicture(page);
});

test("a long log stays at its foot when the chat changes column (1024 px) and in and out of full screen; new lines stay in view", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("wide", "scroll").url, count: 4, nicknamePrefix: "wdscroll", contextOptions: () => DESKTOP(1280, 720) });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  const page = a.page;
  // 4 × 5 lines (the server's chat burst): taller than the column's log.
  await Promise.all(clients.map(async (c, i) => {
    for (let n = 0; n < 5; n++) {
      await c.page.locator(site.chatInput).fill(`line ${String(i)}-${String(n)}`);
      await c.page.locator(site.chatInput).press("Enter");
    }
  }));
  const log = page.locator(site.chatLog);
  await expect(log.locator(site.chatLogLine).filter({ hasText: "line " })).toHaveCount(20);
  const atFoot = (): Promise<boolean> => log.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 2);
  // It overflows the column's log, and the reader is at its foot.
  expect(await log.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await expect.poll(atFoot).toBe(true);

  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") === null)).toBe(true);
  expect(await log.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 2)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.locator(site.room).evaluate((r) => r.closest(".room-wide") !== null)).toBe(true);
  expect(await atFoot()).toBe(true);

  await page.locator(site.fullscreenToggle).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  expect(await atFoot()).toBe(true);
  await expect(log.locator(site.chatLogLine).last()).toBeInViewport();
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(await atFoot()).toBe(true);

  // And it still follows: a new line lands in view.
  const b = clients[1];
  if (b === undefined) throw new Error("no second client");
  await b.page.waitForTimeout(1100);
  await b.page.locator(site.chatInput).fill("after the moves");
  await b.page.locator(site.chatInput).press("Enter");
  const latest = log.locator(site.chatLogLine).last();
  await expect(latest).toContainText("after the moves");
  await expect(latest).toBeInViewport();
  expect(await atFoot()).toBe(true);
});
