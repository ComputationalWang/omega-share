// The owner's layout editor (OME-410, ADR 0028): a lazy chunk only the owner ever loads. The owner moves and places furniture,
// saves once, renames and deletes; a guest sees each change live, and its static furniture is rebuilt once per change.
// One room per test: the creation bucket is 2 per key (ROOM_CREATE_KEY_BURST).
import { DEFAULT_LAYOUT, type RoomLayout } from "@omega/shared";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";
import { cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

/** The editor chunk (Vite dev: /src/editor/…; a build: editor-<hash>.js) and the set (h) edit kit. */
const EDITOR_URL = /\/editor[/-]|edit(-[\w-]+)?\.png/;

async function newPage(browser: Browser, requests: string[]): Promise<Page> {
  const context = await watchCsp(await browser.newContext());
  contexts.push(context);
  await stubExternalNetwork(context);
  const page = await context.newPage();
  page.on("request", (r) => requests.push(r.url()));
  return page;
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
}

/** The dev handle (apps/web/src/main.ts `window.__omega.room`). */
async function handle(page: Page, what: "layout" | "builds"): Promise<unknown> {
  return page.evaluate((what) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    if (typeof room !== "object" || room === null) return null;
    if (what === "builds") {
      const f: unknown = Reflect.get(room, "layoutBuilds");
      return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
    }
    const state: unknown = Reflect.get(room, "state");
    const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
    const r: unknown = typeof s === "object" && s !== null ? Reflect.get(s, "room") : null;
    return typeof r === "object" && r !== null ? (Reflect.get(r, "layout") as unknown) : null;
  }, what);
}
const layoutOf = async (page: Page): Promise<RoomLayout["furniture"]> =>
  v.parse(v.object({ furniture: v.array(v.object({ kind: v.string(), col: v.number(), row: v.number() })) }), await handle(page, "layout")).furniture as RoomLayout["furniture"];
const builds = async (page: Page): Promise<number> => v.parse(v.number(), await handle(page, "builds"));

/** Click floor cell (col, row) through the editor's hit layer (the stage is CSS-scaled from 960×600). */
async function clickCell(page: Page, col: number, row: number): Promise<void> {
  const hit = page.locator(site.editorHit);
  const box = await hit.boundingBox();
  if (box === null) throw new Error("editor hit layer not laid out");
  const p = cellCenter(col, row);
  const scale = box.width / 960;
  await hit.click({ position: { x: p.x * scale, y: p.y * scale } });
}

test("only the owner loads the editor; a guest sees the saved layout and the new title live, then the delete", async ({ browser }) => {
  const ownerReq: string[] = [];
  const guestReq: string[] = [];
  const owner = await newPage(browser, ownerReq);
  const titleSets: string[] = [];
  owner.on("websocket", (ws) => ws.on("framesent", (f) => {
    if (typeof f.payload === "string" && f.payload.includes('"title-set"')) titleSets.push(f.payload);
  }));
  await owner.goto(`${URLS.web}/`);
  await owner.locator(site.createRoomTitle).fill("Edit me");
  await owner.locator(site.createRoomSubmit).click();
  await owner.waitForURL(/\/r\/[a-z2-7]{26}$/);
  await enter(owner, "owner");
  const guest = await newPage(browser, guestReq);
  await guest.goto(owner.url());
  await enter(guest, "guest");

  // Only the owner gets the key, and nothing of the editor loads before it's pressed.
  await expect(guest.locator(site.editRoom)).toHaveCount(0);
  await expect(owner.locator(site.editRoom)).toBeVisible();
  expect(ownerReq.filter((u) => EDITOR_URL.test(u))).toEqual([]);
  await owner.locator(site.editRoom).click();
  await expect(owner.locator(site.editRoom)).toHaveAttribute("aria-pressed", "true");
  await expect(owner.locator(site.editorTray)).toBeVisible();
  // The name field starts with the room's name (the snapshot carries it, OME-473).
  await expect(owner.locator(site.editorTitle)).toHaveValue("Edit me");
  expect(ownerReq.some((u) => EDITOR_URL.test(u))).toBe(true);

  // Move the lamp from (9,0) to (8,1) and put a popcorn cart at (9,9): one save, one layout-changed.
  const before = await builds(guest);
  await clickCell(owner, 9, 0);
  await clickCell(owner, 8, 1);
  await owner.locator(site.editorTab).filter({ hasText: "Decor" }).click();
  await owner.locator(`${site.editorSlot}[data-kind="popcorn"]`).click();
  await clickCell(owner, 9, 9);
  // The owner sees the draft; the guest doesn't until it's saved.
  expect(await layoutOf(guest)).toHaveLength(DEFAULT_LAYOUT.furniture.length);
  await expect(owner.locator(site.editorProblems)).toBeEmpty();
  await owner.locator(site.editorSave).click();
  await expect.poll(async () => (await layoutOf(guest)).find((f) => f.kind === "popcorn")).toMatchObject({ col: 9, row: 9 });
  expect((await layoutOf(guest)).find((f) => f.kind === "lamp")).toMatchObject({ col: 8, row: 1 });
  // The static furniture was rebuilt once for that change, and not again while the room just runs.
  expect(await builds(guest)).toBe(before + 1);
  await guest.locator(site.chatInput).fill("nice");
  await guest.locator(site.chatSend).click();
  await guest.waitForTimeout(500);
  expect(await builds(guest)).toBe(before + 1);

  // An invalid draft (a seat removed) can't be saved, and says why.
  await clickCell(owner, 1, 5);
  await owner.locator(site.editorRemove).click();
  await expect(owner.locator(site.editorProblems)).toContainText("7 of 8 seats");
  await expect(owner.locator(site.editorSave)).toBeDisabled();

  // Rename: everyone's title follows.
  await owner.locator(site.editorTitle).fill("Friday films");
  await owner.locator(site.editorRename).click();
  for (const p of [owner, guest]) await expect(p.locator(site.roomTitle)).toHaveText("Friday films");
  await expect(owner.locator(site.editorRoomMessage)).toHaveText("Renamed.");
  // Renaming to the name it already has settles at once without a title-set: the server would answer an unchanged
  // title with nothing, so "Renaming…" would wait on an unrelated update (OME-482).
  titleSets.length = 0;
  await owner.locator(site.editorRoomMessage).evaluate((el) => (el.textContent = ""));
  await owner.locator(site.editorRename).click();
  await expect(owner.locator(site.editorRoomMessage)).toHaveText("Renamed.", { timeout: 200 });
  await owner.waitForTimeout(300);
  expect(titleSets).toEqual([]);

  // Delete: a second press confirms, then everyone sees the room closed.
  await owner.locator(site.editorDelete).click();
  await owner.locator(site.editorDeleteConfirm).click();
  for (const p of [owner, guest]) await expect(p.locator(site.roomClosed)).toBeVisible();

  // The guest never fetched the editor chunk or the edit kit.
  expect(guestReq.filter((u) => EDITOR_URL.test(u))).toEqual([]);
});
