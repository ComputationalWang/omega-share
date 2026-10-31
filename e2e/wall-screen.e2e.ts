// The wall screen (OME-2069, ADR 0058). First test: an owner swaps the TV for it in the editor, from the keyboard. Second: in a seeded
// Dank Dungeon with the screen where its TV hangs, a viewer who walks into the bedroom sees the room from the north, where the screen
// is a ghosted back on the near wall (drawn from the same lazy sheet, furniture-v8). The editor can't place the partition that turns a view.
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import * as v from "valibot";
import type { Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { site } from "./support/selectors";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

test("the owner swaps the TV for a wall screen: the tray offers it, its span is marked, Save keeps it, and its sheet loads", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("wallscr");
  const context = await watchCsp(await browser.newContext());
  await context.addInitScript(([key, value]) => {
    localStorage.setItem(key, value);
  }, [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })] as const);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`${URLS.web}/r/${id}`);
  await page.locator(site.nicknameInput).fill("screens");
  await page.locator(site.joinButton).click();
  expect(requests.some((u) => u.includes("furniture-v8"))).toBe(false);

  await page.locator(site.editRoom).click();
  await expect(page.locator(site.editorTray)).toBeVisible();
  const hit = page.locator(site.editorHit);
  const cursor = page.locator(site.editorCursor);
  // The TV stands on (0,0): select it and take it away, or the room would hold two screens.
  await hit.focus();
  await page.keyboard.press("Enter");
  await page.locator(site.editorRemove).click();
  await expect(page.locator(site.editorProblems)).toContainText("exactly one TV");

  await page.locator(site.editorTab).filter({ hasText: "Floor & wall" }).click();
  const slot = page.locator(`${site.editorSlot}[data-kind="wallscreen"]`);
  await expect(slot).toHaveAttribute("aria-label", "Wall screen");
  await slot.click();
  await hit.focus();
  // Left from the first column is the left wall; Down walks its segments. Segments 3-4 are free (5, 6 and 8 are fixtures).
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(cursor).toHaveText(/Wall screen, left wall 3/);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.editorProblems)).toBeEmpty();

  await page.locator(site.editorSave).click();
  await expect(page.locator(site.editorMessage)).toHaveText("Saved.");
  const saved = v.parse(
    v.object({ furniture: v.array(v.object({ kind: v.string(), col: v.number(), row: v.number(), facing: v.string() })) }),
    await page.evaluate(() => {
      const room: unknown = Reflect.get(Reflect.get(window, "__omega") as object, "room");
      const state: unknown = Reflect.apply(Reflect.get(room as object, "state") as () => unknown, room, []);
      return Reflect.get(Reflect.get(state as object, "room") as object, "layout") as unknown;
    }),
  );
  expect(saved.furniture.find((f) => f.kind === "wallscreen")).toMatchObject({ col: 0, row: 2, facing: "se" });
  expect(saved.furniture.some((f) => f.kind === "tv")).toBe(false);
  // The scene needed v8 for it: the chunk was fetched once the layout asked.
  await expect.poll(() => requests.some((u) => u.includes("furniture-v8"))).toBe(true);
  await context.close();
});

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Clicks the floor point where cell (x, y) is drawn now (as view-swap.e2e.ts): the north view is the south view turned 180°. */
async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const north = (await page.locator(site.room).getAttribute("data-view")) === "north";
  const box = await page.locator(site.walkFloor).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const c = cellCenter(x, y);
  const p = north ? { x: 960 - c.x, y: 760 - c.y } : c;
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

test("walking into the bedroom turns the view north, where the wall screen shows as a ghosted back on the near wall", async ({ browser }, testInfo) => {
  const requests: string[] = [];
  clients = await joinRoom(browser, { roomUrl: testRoom("wall-screen", "north").url,
    count: 1,
    nicknamePrefix: "ghost",
    setup: (context) => {
      context.on("request", (r) => requests.push(r.url()));
      return Promise.resolve();
    },
  });
  const [a] = clients;
  if (a === undefined) throw new Error("need a client");
  await expect(a.page.locator(site.room)).toHaveAttribute("data-view", "south");
  // The room's pieces asked for the v8 sheet while joining.
  await expect.poll(() => requests.some((u) => u.includes("furniture-v8"))).toBe(true);

  await clickCell(a.page, 2, 2);
  await expect(a.page.locator(site.room)).toHaveAttribute("data-view", "north", { timeout: 15_000 });
  // Let the swapped scene settle, then keep the picture for the anchor review against assets/preview/w2-screen-wallscreen-north@2x.png.
  await a.page.waitForTimeout(500);
  const dir = process.env["PAPERCLIP_RUN_SCRATCH_DIR"] ?? testInfo.outputDir;
  await a.page.locator(site.room).screenshot({ path: `${dir}/wall-screen-north.png` });
});
