// The wall screen (OME-2069, ADR 0058): an owner swaps the TV for it in the editor, from the keyboard. Its sheet (furniture-v8) is a lazy
// chunk; the north view's ghosted back (drawn from the same sheet) is pinned by apps/web/test/wall-screens.test.ts, since only the
// Dank Dungeon's partition turns a view and the editor can't place one.
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import * as v from "valibot";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { site } from "./support/selectors";
import { ownedRoom } from "./support/owned-rooms";

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
  await expect(hit).toBeFocused();
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
