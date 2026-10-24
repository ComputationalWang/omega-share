// Responsive polish, audit round 1 (OME-1810, design OME-1809): the directory's create card and its preset grid, no text
// under 12 px in the room page's chrome on a computer, the room's backdrop across the whole room area (the Dank Dungeon's
// night showed as a box), and full screen on a touch tablet: the picture and its bar centred as one group in black.
// Round 2 (OME-1848, design OME-1847): the curtain caption scales with the TV, the room pieces have tray art, the 4-column
// grid shows the picked blurb once, and the plain pages zoom 2× at the room page's 2× step.
// POLISH_SHOTS=<dir> also saves each case's screenshot there (the PR's before/after pictures).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_SECRETS_STORAGE_KEY, RoomLayoutSchema } from "@omega/shared";
import type { BrowserContextOptions, Page } from "@playwright/test";
import * as v from "valibot";
import { shareVideo, waitPlaying } from "../perf/sync";
import { showLayout } from "../perf/show-layout";
import { PENDING, ROOT, available, URLS } from "./support/apps";
import { expect, test, watchCsp } from "./support/csp";
import { openDirectory } from "./support/directory";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const DESKTOP = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height } });
const TOUCH = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["POLISH_SHOTS"];
  if (dir !== undefined && dir !== "") await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** The screenshot's RGB at each [x, y] CSS px, decoded on a blank page of the same context (DPR 1 contexts only). */
async function pixels(page: Page, points: readonly (readonly [number, number])[]): Promise<number[][]> {
  const png = (await page.screenshot()).toString("base64");
  const blank = await page.context().newPage();
  const out = await blank.evaluate(async ({ data, at }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d");
    if (g === null) throw new Error("no 2d");
    g.drawImage(img, 0, 0);
    return at.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3));
  }, { data: png, at: points });
  await blank.close();
  return out;
}

/** Visible elements with their own text whose computed size is under 12 px (font-size 0 is a label hidden behind its art). */
const smallText = (page: Page, root: string): Promise<{ text: string; cls: string; px: number }[]> =>
  page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(`${sel} *`)]
    .filter((e) => [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "") && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .map((e) => ({ text: e.textContent.trim().slice(0, 30), cls: typeof e.className === "string" ? e.className : "", px: Number.parseFloat(getComputedStyle(e).fontSize) }))
    .filter((t) => t.px > 0 && t.px < 12), root);

for (const [w, h] of [[1024, 768], [1280, 800], [1920, 1080], [2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: the create card is ≥ 360 px, its presets a 4×2 grid with no sideways scroll, 12 px blurbs`, async ({ browser }) => {
    const context = await watchCsp(await browser.newContext(DESKTOP(w, h)));
    const page = await context.newPage();
    await page.goto(URLS.web);
    // The landing page, then the directory: no text under 12 px on either.
    await expect(page.locator(site.findRoom)).toBeVisible();
    expect(await smallText(page, "body")).toEqual([]);
    await openDirectory(page, "Polish");
    await shot(page, `1-create-${String(w)}x${String(h)}`);
    const card = page.locator(site.createRoomForm);
    expect((await card.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(360);
    const list = page.locator(".preset-list");
    await expect(list).toHaveCSS("display", "grid");
    expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    const tops = await page.locator(".preset").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops).toHaveLength(8);
    expect(new Set(tops).size).toBe(2);
    expect(tops.filter((t) => t === tops[0])).toHaveLength(4);
    // 12 px (13 from 1600 px, the --text-xs token), line-height 1.45.
    const blurb = await page.locator(".preset-blurb").first().evaluate((el) => { const s = getComputedStyle(el); return { size: Number.parseFloat(s.fontSize), lead: Number.parseFloat(s.lineHeight) / Number.parseFloat(s.fontSize) }; });
    expect(blurb.size).toBeGreaterThanOrEqual(12);
    expect(blurb.lead).toBeCloseTo(1.45, 2);
    expect(await smallText(page, "body")).toEqual([]);
    await context.close();
  });
}

for (const [name, w, h] of [["c1280", 1280, 800], ["c1920", 1920, 1080], ["c2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)} with a video: no visible text in the room page is under 12 px`, async ({ browser, request }) => {
    const room = testRoom("rpolish", name);
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `po${name}`, contextOptions: () => DESKTOP(w, h) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await waitPlaying(clients);
    expect(await smallText(page, "body")).toEqual([]);
    await shot(page, `2-room-${String(w)}x${String(h)}`);
  });
}

const dungeon = v.parse(RoomLayoutSchema, JSON.parse(readFileSync(join(ROOT, "assets/presets/dank-dungeon.json"), "utf8")));

for (const [name, w, h] of [["d1280", 1280, 800], ["d1920", 1920, 1080], ["d2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: the Dank Dungeon's night reaches the room area's edges, no box`, async ({ browser }) => {
    clients = await joinRoom(browser, {
      roomUrl: testRoom("rpolish", name).url,
      count: 1,
      nicknamePrefix: `po${name}`,
      setup: (context) => showLayout(context, dungeon),
      contextOptions: () => DESKTOP(w, h),
    });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await expect(page.locator(".cinema-dim")).toHaveAttribute("data-mood", "night");
    await page.waitForTimeout(300);
    // The room's empty corner inside the stage (the floor is a diamond) and the page just outside the stage's box: one
    // colour, so the stage's edge doesn't show.
    await shot(page, `3-dungeon-${String(w)}x${String(h)}`);
    const area = await page.locator(".stage-clip").boundingBox();
    if (area === null) throw new Error("not laid out");
    const y = Math.floor(area.y + area.height - 4);
    const [inside, outside] = await pixels(page, [[Math.floor(area.x + 4), y], [Math.max(2, Math.floor(area.x - 8)), y]]);
    // Two paths to the same multiply: a rounding step apart at most.
    for (const [i, c] of (outside ?? []).entries()) expect(Math.abs(c - (inside?.[i] ?? -9))).toBeLessThanOrEqual(2);
  });
}

for (const [name, w, h, options] of [["f1024", 1024, 768, TOUCH(1024, 768)], ["f1366", 1024, 1366, TOUCH(1024, 1366)], ["f1280", 1280, 800, DESKTOP(1280, 800)]] as const) {
  test(`${String(w)}×${String(h)}${options.hasTouch === true ? " touch" : ""}: full screen centres the picture and its bar as one group, in black letterbox`, async ({ browser, request }) => {
    const room = testRoom("rpolish", name);
    await shareVideo(request, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `po${name}`, contextOptions: () => options });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await waitPlaying(clients);
    await page.locator(site.fullscreenToggle).click();
    await expect(page.locator(site.fsStrip)).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, `4-fullscreen-${String(w)}x${String(h)}`);
    const tv = await page.locator(site.tv).boundingBox();
    const bar = await page.locator(`${site.fsRoot} .controls, .stage-wrap.is-fs > .controls`).first().boundingBox();
    const wrap = await page.locator(".stage-wrap.is-fs").boundingBox();
    if (tv === null || bar === null || wrap === null) throw new Error("not laid out");
    const strip = await page.locator(site.fsStrip).boundingBox();
    if (strip === null) throw new Error("no strip");
    // The picture and its bar in the middle of the space the strip leaves (under them in portrait): the leftover split
    // evenly, within the 8 px gap and a rounding px.
    const above = tv.y - wrap.y;
    const floor = strip.y > bar.y ? strip.y : wrap.y + wrap.height;
    expect(Math.abs(above - (floor - (bar.y + bar.height)))).toBeLessThanOrEqual(9);
    // The leftover is letterbox: plain black, no page colour and no bezel rule over or under the picture.
    await expect(page.locator(".stage-wrap.is-fs")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator(site.tv)).toHaveCSS("border-image-source", "none");
  });
}

for (const [name, w, h] of [["e1280", 1280, 800], ["e1920", 1920, 1080], ["e2560", 2560, 1440]] as const) {
  test(`${String(w)}×${String(h)}: the empty TV's caption is 2.2 % of the TV's width, between --text-sm and 40 px`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("rpolish", name).url, count: 1, nicknamePrefix: `po${name}`, contextOptions: () => DESKTOP(w, h) });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    const caption = page.locator(".tv-empty");
    await expect(caption).toBeVisible();
    await shot(page, `5-curtain-${String(w)}x${String(h)}`);
    const m = await caption.evaluate((el) => {
      const s = getComputedStyle(el);
      const tv = el.parentElement?.getBoundingClientRect().width ?? 0;
      return { size: Number.parseFloat(s.fontSize), sm: Number.parseFloat(s.getPropertyValue("--text-sm")), tv, width: el.getBoundingClientRect().width };
    });
    expect(m.size).toBeCloseTo(Math.min(40, Math.max(m.sm, 0.022 * m.tv)), 0);
    expect(m.width).toBeLessThanOrEqual(0.8 * m.tv + 1);
  });
}

test("1280×800: the Armchair and TV console tray cubbies show their art, still named for screen readers", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("trayart");
  const context = await watchCsp(await browser.newContext(DESKTOP(1280, 800)));
  await context.addInitScript(([key, value]) => {
    localStorage.setItem(key, value);
  }, [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })] as const);
  const page = await context.newPage();
  await page.goto(`${URLS.web}/r/${id}`);
  await page.locator(site.nicknameInput).fill("trayart");
  await page.locator(site.joinButton).click();
  await page.locator(site.editRoom).click();
  await expect(page.locator(site.editorTray)).toBeVisible();
  await shot(page, "6-tray-1280x800");
  for (const [kind, art, label] of [["armchair", "ui-thumb-armchair-velvet", "Armchair"], ["tv", "ui-thumb-tv-charcoal", "TV console"]] as const) {
    const slot = page.locator(`${site.editorSlot}[data-kind="${kind}"]`);
    await expect(slot).toHaveAttribute("aria-label", label);
    await expect(slot.locator(`.${art}`)).toHaveCount(1);
    await expect(slot.locator(".editor-slot-name")).toHaveCount(0);
  }
  await context.close();
});

for (const [w, h, cols] of [[1024, 768, 4], [1920, 1080, 4], [2560, 1440, 4], [700, 900, 0]] as const) {
  test(`${String(w)}×${String(h)}: ${cols === 4 ? "the 4-column grid shows the picked preset's blurb once, under it" : "the phone strip keeps its blurbs on the cards"}`, async ({ browser }) => {
    const context = await watchCsp(await browser.newContext(DESKTOP(w, h)));
    const page = await context.newPage();
    await page.goto(URLS.web);
    await openDirectory(page, "Polish");
    const note = page.locator(".preset-note");
    if (cols === 4) {
      await expect(page.locator(".preset-blurb").first()).toBeHidden();
      await expect(note).toBeVisible();
      await expect(note).toHaveText("Two rows of armchairs on the big rug.");
      await page.locator(".preset").nth(1).click();
      await expect(note).toHaveText("Rows on risers before the big screen.");
      expect(Number.parseFloat(await note.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);
    } else {
      await expect(page.locator(".preset-blurb").first()).toBeVisible();
      await expect(note).toBeHidden();
    }
    await context.close();
  });
}

for (const [w, h, zoom] of [[1920, 1080, "1"], [2560, 1440, "2"], [2560, 1080, "1"]] as const) {
  test(`${String(w)}×${String(h)}: the landing, directory and legal page columns zoom ${zoom}×`, async ({ browser }) => {
    const context = await watchCsp(await browser.newContext(DESKTOP(w, h)));
    const page = await context.newPage();
    await page.goto(URLS.web);
    await expect(page.locator("main")).toHaveCSS("zoom", zoom);
    await shot(page, `7-landing-${String(w)}x${String(h)}`);
    await openDirectory(page, "Polish");
    await expect(page.locator("main")).toHaveCSS("zoom", zoom);
    await page.goto(`${URLS.web}/privacy.html`);
    await expect(page.locator("main")).toHaveCSS("zoom", zoom);
    await context.close();
  });
}
