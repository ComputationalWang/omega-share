// Teleport pads (OME-1548, ADR 0053 amendment): walk onto one pad, and 400 ms later everyone sees me on the other.
// The room is seeded with a pad pair at (8, 1) and (8, 8) (fixtures/seed-rooms.ts).
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { TAG_OFFSET_Y, cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Where a nickname tag hangs when its avatar rests on cell (x, y). */
const restOn = (x: number, y: number): string => {
  const p = cellCenter(x, y);
  return `${String(Math.round(p.x))}px ${String(Math.round(p.y + TAG_OFFSET_Y))}px`;
};
const tagAt = (page: Page, nickname: string): Promise<string> => page.locator(site.nicknameTag).filter({ hasText: nickname }).evaluate((el) => (el as HTMLElement).style.translate);

async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator(site.walkFloor).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const p = cellCenter(x, y);
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

test("walking onto a pad takes me to the other pad, for everyone, and I stay there", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("teleport", "pads").url, count: 2, nicknamePrefix: "hop" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.waitForTimeout(6000); // b walked in from the door
  await clickCell(b.page, 8, 8);
  for (const page of [a.page, b.page]) await expect.poll(() => tagAt(page, "hop-2"), { timeout: 20_000 }).toBe(restOn(8, 1));
  // Arriving by teleport does not trigger the pad again: still there a while later.
  await b.page.waitForTimeout(1500);
  for (const page of [a.page, b.page]) expect(await tagAt(page, "hop-2")).toBe(restOn(8, 1));
});
