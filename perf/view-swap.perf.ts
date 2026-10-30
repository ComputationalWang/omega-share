// OME-1961: the 180° view swap (a rebuilt scene and one shell bake, on a walk event) must not stall the room. Two clients
// in the Dank Dungeon; A walks into the bedroom (the view turns north) and back (south) while its frames are sampled.
// viewswap.longFrame.desktop: the longest requestAnimationFrame gap across both swaps, ≤ 50 ms (no long task).
import { expect, test, type Page } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { cellCenter } from "../apps/web/src/layout";
import { frameTimes } from "./frames";
import { recordMetric } from "./metrics";

const ID = "viewswap.longFrame.desktop";
const WINDOW_MS = 9000;

/** Clicks the floor point where cell (x, y) is drawn now (the north view is the south view turned 180° about the stage centre). */
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

test("view swap: the longest frame while my view turns north and back", async ({ browser }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    recordMetric({ id: ID, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(120_000);
  const clients = await joinRoom(browser, { roomUrl: testRoom("view-swap-perf", "frames").url, count: 2, nicknamePrefix: "vs" });
  try {
    const a = clients[0]?.page;
    if (a === undefined) throw new Error("no client");
    await expect(a.locator(site.room)).toHaveAttribute("data-view", "south");
    // The back sheet is preloaded with the layout; give it (and the first draw) a moment so only the swap is measured.
    await a.waitForTimeout(2000);
    const frames = frameTimes(a, WINDOW_MS);
    await clickCell(a, 2, 2);
    await expect(a.locator(site.room)).toHaveAttribute("data-view", "north", { timeout: 15_000 });
    await a.waitForTimeout(1500);
    await clickCell(a, 3, 8);
    await expect(a.locator(site.room)).toHaveAttribute("data-view", "south", { timeout: 15_000 });
    const samples = await frames;
    const longest = Math.max(...samples);
    recordMetric({ id: ID, value: longest, note: `${String(samples.length)} frames over ${String(WINDOW_MS)} ms, two swaps` });
    expect(longest).toBeLessThanOrEqual(50);
  } finally {
    await leaveAll(clients);
  }
});
