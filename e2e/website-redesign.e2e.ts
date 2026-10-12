// OME-935: the Dusk doorstep landing and room directory (design OME-933 53e938b, handoff OME-934). Entry: Enter lobby
// joins the lobby (or Enter room, the addressed room), and a separate "Find or create a room" opens the directory
// without a room socket or warming the room renderer. A returning profile lands on the directory; Edit profile goes
// back. Layout at 360/412/1280/1920 and the 701–1103 px tablet range (one column, phone vignette).
import type { Page, Request } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { openDirectory } from "./support/directory";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

/** The room chunk (dev: /src/room.ts) or Pixi: what Enter warms, and what browsing must never fetch. */
const ROOM_CODE = /\/src\/room\.ts(?:\?|$)|\/assets\/room-[^/]*\.js$|pixi/i;

function watch(page: Page): { roomCode: string[]; sockets: string[] } {
  const seen = { roomCode: [] as string[], sockets: [] as string[] };
  page.on("request", (r: Request) => {
    if (ROOM_CODE.test(r.url())) seen.roomCode.push(r.url());
  });
  page.on("websocket", (ws) => seen.sockets.push(ws.url()));
  return seen;
}

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).boundingBox();
  if (b === null) throw new Error(`no box for ${sel}`);
  return b;
};

test("Find or create a room opens the directory: no room socket, no room code, focus on its heading", async ({ page }) => {
  const seen = watch(page);
  await page.goto(URLS.web);
  await expect(page.locator(site.joinButton)).toHaveText("Enter lobby");
  await page.locator(site.findRoom).hover();
  await page.locator(site.findRoom).focus();
  await openDirectory(page, "Juno");
  await expect(page.locator("#directory-title")).toBeFocused();
  await expect(page.locator("#home-root")).toContainText("Juno");
  await expect(page.locator("#landing")).toBeHidden();
  await expect(page.locator(site.publicRoomLink).first()).toBeVisible();
  expect(seen.sockets).toEqual([]);
  expect(seen.roomCode).toEqual([]);
});

test("Find or create a room with no nickname says why and stays put, still without warming the room", async ({ page }) => {
  const seen = watch(page);
  await page.goto(URLS.web);
  await page.locator(site.findRoom).click();
  await expect(page.locator("#nickname-error")).toHaveText("Pick a nickname.");
  await expect(page.locator("#nickname")).toBeFocused();
  await expect(page.locator("#nickname")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#home-root")).toBeHidden();
  expect(seen.roomCode).toEqual([]);
});

test("a returning profile lands on the directory; Edit profile goes back to the filled form; Enter in it joins the lobby", async ({ page }) => {
  await page.goto(URLS.web);
  await openDirectory(page, "Pip");
  await page.reload();
  await expect(page.locator(site.createRoomForm)).toBeVisible();
  await expect(page.locator("#landing")).toBeHidden();
  await page.locator(site.editProfile).click();
  await expect(page.locator("#nickname")).toBeFocused();
  await expect(page.locator("#nickname")).toHaveValue("Pip");
  await page.locator("#nickname").press("Enter");
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator("#home-root")).toBeHidden();
});

test("a room link with a fresh profile shows Enter room and no directory action; Enter joins that room", async ({ page }) => {
  await page.goto(`${URLS.web}/r/lobby`);
  await expect(page.locator(site.joinButton)).toHaveText("Enter room");
  await expect(page.locator(site.findRoom)).toBeHidden();
  await page.locator(site.nicknameInput).fill("Mo");
  await page.locator(site.nicknameInput).press("Enter");
  await expect(page.locator(site.room)).toBeVisible();
});

test("the public list can't be reached: it says so with a Retry key, and Retry lists the rooms", async ({ page }) => {
  let fail = true;
  await page.route(/\/rooms$/, (route) => (fail && route.request().method() === "GET" ? route.abort() : route.fallback()));
  await page.goto(URLS.web);
  await openDirectory(page);
  await expect(page.locator(site.publicRoomsStatus)).toHaveText("Could not reach the server. Try again.");
  fail = false;
  await page.locator(site.publicRoomsRetry).click();
  await expect(page.locator(site.publicRoomLink).first()).toBeVisible();
  await expect(page.locator(site.publicRoomsRetry)).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("Open rooms ↓ reaches the list and focuses its heading", async ({ page }) => {
    await page.goto(URLS.web);
    await openDirectory(page);
    await page.getByRole("link", { name: /Open rooms/ }).click();
    const heading = page.locator("#open-rooms");
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await page.getByRole("link", { name: /Make a room/ }).scrollIntoViewIfNeeded();
    await page.getByRole("link", { name: /Make a room/ }).click();
    await expect(page.locator(site.createRoomTitle)).toBeFocused();
  });
});

for (const [width, height] of [[360, 740], [412, 915], [1280, 800], [1920, 1080]] as const) {
  test(`${String(width)} px: entry and directory fit the screen, and the hero is one file at native size`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(URLS.web);
    const hero = page.locator(".entry-art img");
    await expect.poll(() => hero.evaluate((e) => e instanceof HTMLImageElement && e.complete && e.naturalWidth > 0)).toBe(true);
    const src = await hero.evaluate((e) => (e instanceof HTMLImageElement ? e.currentSrc : ""));
    const wide = width >= 1104;
    expect(src).toContain(wide ? "website-room" : "how-3-watch");
    const img = await box(page, ".entry-art img");
    expect([img.width, img.height]).toEqual(wide ? [656, 536] : [368, 224]);
    const form = await box(page, "#landing");
    const art = await box(page, ".entry-art");
    if (wide) expect(art.x).toBeGreaterThanOrEqual(form.x + form.width);
    else expect(art.y + art.height).toBeLessThanOrEqual(form.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await openDirectory(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const create = await box(page, ".create-room");
    const open = await box(page, ".rooms-public");
    if (wide) expect(open.x).toBeGreaterThanOrEqual(create.x + create.width);
    else expect(open.y).toBeGreaterThanOrEqual(create.y + create.height);
  });
}

test("tablet (800 px): one column with the phone vignette, never the wide crop", async ({ page }) => {
  const heroes: string[] = [];
  page.on("request", (r) => {
    if (/website-room|how-3-watch/.test(r.url())) heroes.push(r.url());
  });
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto(URLS.web);
  const form = await box(page, "#landing");
  const art = await box(page, ".entry-art");
  expect(art.y + art.height).toBeLessThanOrEqual(form.y);
  expect(heroes.some((u) => u.includes("website-room"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
});

test("the footer's own pages answer, and the source links point at the repository", async ({ page, request }) => {
  await page.goto(URLS.web);
  const footer = page.locator(".site-footer");
  for (const name of ["Privacy", "Terms", "Contact", "Licences"]) {
    const href = await footer.getByRole("link", { name, exact: true }).getAttribute("href");
    expect((await request.get(new URL(href ?? "", URLS.web).href)).status()).toBe(200);
  }
  const source = await footer.getByRole("link", { name: "Source", exact: true }).getAttribute("href");
  expect(source).toMatch(/^https:\/\//);
  await expect(footer.getByRole("link", { name: "Feedback", exact: true })).toHaveAttribute("href", `${source ?? ""}/issues`);
  await expect(footer).toContainText("Original art · CC BY-SA 4.0");
});
