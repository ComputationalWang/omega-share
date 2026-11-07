// The 180° view swap (OME-1961): in the Dank Dungeon (two rooms split by a partition with a doorway) a viewer whose
// avatar is on the bedroom side sees the room from the north; everyone else's view is untouched.
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { TAG_OFFSET_Y, cellCenter } from "../apps/web/src/layout";
import { cellAt, colOf, rowOf } from "../apps/web/src/walk/path";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Clicks the floor point where cell (x, y) is drawn now: the north view is the south view turned 180° (stage 960×760 about its centre). */
async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const north = (await page.locator(site.room).getAttribute("data-view")) === "north";
  const floor = page.locator(site.walkFloor);
  const box = await floor.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const c = cellCenter(x, y);
  const p = north ? { x: 960 - c.x, y: 760 - c.y } : c;
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

const stage = (page: Page) => page.locator(site.room);

test("walking into the bedroom turns my view north, and only mine; walking back turns it south", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("view-swap", "main").url, count: 2, nicknamePrefix: "turner" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await expect(stage(a.page)).toHaveAttribute("data-view", "south");
  await expect(stage(b.page)).toHaveAttribute("data-view", "south");

  await clickCell(a.page, 2, 2);
  await expect(stage(a.page)).toHaveAttribute("data-view", "north", { timeout: 15_000 });
  await expect(stage(b.page)).toHaveAttribute("data-view", "south");

  await clickCell(a.page, 3, 8);
  await expect(stage(a.page)).toHaveAttribute("data-view", "south", { timeout: 15_000 });
  await expect(stage(b.page)).toHaveAttribute("data-view", "south");
});

/** Where my drawn avatar stood (its cell) the frame before my view turned (OME-2346): sampled every frame from my tag's anchor. */
async function cellAtTurn(page: Page, to: "north" | "south", click: () => Promise<void>): Promise<{ col: number; row: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { turnLog?: [string, string][] };
    const log: [string, string][] = [];
    w.turnLog = log;
    const tick = (): void => {
      const view = document.querySelector<HTMLElement>("[data-view='north'], [data-view='south']")?.dataset["view"] ?? "";
      log.push([view, document.querySelector<HTMLElement>(".tag.self")?.style.translate ?? ""]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await click();
  await expect(stage(page)).toHaveAttribute("data-view", to, { timeout: 15_000 });
  const log = await page.evaluate(() => (window as unknown as { turnLog: [string, string][] }).turnLog);
  const turn = log.findIndex(([v]) => v === to);
  const before = log[turn - 1]?.[1] ?? "";
  const [x, y] = before.split(" ").map((s) => Number.parseFloat(s));
  if (x === undefined || y === undefined) throw new Error(`no tag before the turn: "${before}" at frame ${String(turn)} of ${String(log.length)}, ${String(log.filter(([, t]) => t === "").length)} without a tag`);
  // The frame before the turn is drawn in the old projection; north is south turned 180° about the stage centre.
  const p = to === "north" ? { x, y: y - TAG_OFFSET_Y } : { x: 960 - x, y: 760 - (y - TAG_OFFSET_Y) };
  const c = cellAt(p);
  return { col: colOf(c), row: rowOf(c) };
}

test("my view turns when my drawn avatar passes the doorway, not on the click (OME-2346)", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("view-swap", "drawn").url, count: 1, nicknamePrefix: "walker" });
  const [a] = clients;
  if (a === undefined) throw new Error("need a client");
  await expect(stage(a.page)).toHaveAttribute("data-view", "south");
  // The doorway is col 1, row 4: the turn may come a step either side of it.
  const near = (c: { col: number; row: number }): boolean => Math.abs(c.col - 1) <= 1 && Math.abs(c.row - 4) <= 1;
  const north = await cellAtTurn(a.page, "north", () => clickCell(a.page, 2, 2));
  expect(near(north), `turned north at ${JSON.stringify(north)}`).toBe(true);
  // Walking north, past the doorway's middle my avatar is drawn behind the partition piece at (2,4) in the south view (QA OME-2352): turn before it leaves the doorway.
  expect(north.row, `turned north at ${JSON.stringify(north)}, past the doorway`).toBeGreaterThanOrEqual(4);
  const south = await cellAtTurn(a.page, "south", () => clickCell(a.page, 3, 8));
  expect(near(south), `turned south at ${JSON.stringify(south)}`).toBe(true);
});
