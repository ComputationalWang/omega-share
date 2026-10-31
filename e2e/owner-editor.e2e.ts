// The owner's layout editor (OME-410, ADR 0028): a lazy chunk only the owner ever loads. The owner moves and places furniture,
// saves once, renames and deletes; a guest sees each change live, and its static furniture is rebuilt once per change.
// One room per test, and at most one UI create in this file: the creation bucket is 2 per key (ROOM_CREATE_KEY_BURST)
// and rooms-web.e2e.ts may share the shard.
import { DEFAULT_LAYOUT, ROOM_SECRETS_STORAGE_KEY, type RoomLayout } from "@omega/shared";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";
import { openDirectory } from "./support/directory";
import { ownedRoom } from "./support/owned-rooms";
import { cellCenter } from "../apps/web/src/layout";
import { defaultFacing } from "../apps/web/src/editor/draft";

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
const savedOf = async (page: Page): Promise<RoomLayout["furniture"]> =>
  v.parse(v.object({ furniture: v.array(v.object({ kind: v.string(), col: v.number(), row: v.number(), facing: v.string() })) }), await handle(page, "layout")).furniture as RoomLayout["furniture"];
const builds = async (page: Page): Promise<number> => v.parse(v.number(), await handle(page, "builds"));

/**
 * Click floor cell (col, row) through the editor's hit layer (the stage is CSS-scaled from 960×600). At 1× the room's band
 * can crop the cell (OME-1811): the mouse drags the band to bring it to the middle first, as an owner would.
 */
async function clickCell(page: Page, col: number, row: number): Promise<void> {
  const hit = page.locator(site.editorHit);
  const p = cellCenter(col, row);
  const at = async (): Promise<{ x: number; y: number; scale: number }> => {
    const box = await hit.boundingBox();
    if (box === null) throw new Error("editor hit layer not laid out");
    const scale = box.width / 960;
    return { x: box.x + p.x * scale, y: box.y + p.y * scale, scale };
  };
  const band = await page.locator(site.roomWindow).boundingBox();
  if (band === null) throw new Error("room window not laid out");
  const a = await at();
  const margin = 24;
  if (a.x < band.x + margin || a.x > band.x + band.width - margin || a.y < band.y + margin || a.y > band.y + band.height - margin) {
    const cx = band.x + band.width / 2;
    const cy = band.y + band.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(2 * cx - a.x, 2 * cy - a.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await at()).y).not.toBe(a.y);
  }
  const b = await at();
  const box = await hit.boundingBox();
  if (box === null) throw new Error("editor hit layer not laid out");
  await hit.click({ position: { x: b.x - box.x, y: b.y - box.y } });
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
  await openDirectory(owner, "Owner");
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

  // Move the lamp from (9,0) to (8,1), put a popcorn cart at (9,9) and an aquarium at (9,8): one save, one layout-changed.
  const before = await builds(guest);
  await clickCell(owner, 9, 0);
  await clickCell(owner, 8, 1);
  await owner.locator(site.editorTab).filter({ hasText: "Decor" }).click();
  await owner.locator(`${site.editorSlot}[data-kind="popcorn"]`).click();
  await clickCell(owner, 9, 9);
  // A catalogue v3 piece (OME-1351) comes from the same tray.
  await owner.locator(`${site.editorSlot}[data-kind="aquarium"]`).click();
  await clickCell(owner, 9, 8);
  // So does a batch 6 piece (OME-1439): a fireplace backs onto the left wall.
  await owner.locator(`${site.editorSlot}[data-kind="fireplace"]`).click();
  await clickCell(owner, 0, 7);
  // The room mood (OME-1502) is saved with the same layout-set, and only tints the one dim layer.
  await owner.locator(`${site.editorMood}[data-mood="night"]`).click();
  await expect(owner.locator(`${site.editorMood}[data-mood="night"]`)).toHaveAttribute("aria-checked", "true");
  await expect(owner.locator(site.roomTint)).toHaveAttribute("data-mood", "night");
  await expect(guest.locator(site.roomTint)).not.toHaveAttribute("data-mood", /./);
  // The owner sees the draft; the guest doesn't until it's saved.
  expect(await layoutOf(guest)).toHaveLength(DEFAULT_LAYOUT.furniture.length);
  await expect(owner.locator(site.editorProblems)).toBeEmpty();
  await owner.locator(site.editorSave).click();
  await expect.poll(async () => (await layoutOf(guest)).find((f) => f.kind === "popcorn")).toMatchObject({ col: 9, row: 9 });
  expect((await layoutOf(guest)).find((f) => f.kind === "lamp")).toMatchObject({ col: 8, row: 1 });
  expect((await layoutOf(guest)).find((f) => f.kind === "aquarium")).toMatchObject({ col: 9, row: 8 });
  expect((await savedOf(guest)).find((f) => f.kind === "fireplace")).toMatchObject({ col: 0, row: 7, facing: "se" });
  await expect(guest.locator(site.roomTint)).toHaveAttribute("data-mood", "night");
  await expect(guest.locator(site.roomTint)).toHaveCount(1);
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
  // The saved record follows, so Your rooms shows the new name (OME-1284).
  const roomId = new URL(owner.url()).pathname.split("/")[2] ?? "";
  await expect.poll(() => owner.evaluate(([k, id]) => (JSON.parse(localStorage.getItem(k) ?? "{}") as { rooms?: Record<string, { title?: string }> }).rooms?.[id]?.title, [ROOM_SECRETS_STORAGE_KEY, roomId] as const)).toBe("Friday films");
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

test("keyboard only: a cell cursor places, selects, moves, turns and puts back furniture, and Save keeps it (OME-1245)", async ({ browser }) => {
  // A seeded owned room, not a UI create: with the test above and rooms-web.e2e.ts in one shard, a third create from
  // the same key is rate limited (OME-1294).
  const { id, ownerToken, inviteKey } = ownedRoom("editorkbd");
  const owner = await newPage(browser, []);
  await owner.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })] as const,
  );
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "owner");
  const keys = async (...pressed: string[]): Promise<void> => {
    for (const k of pressed) await owner.keyboard.press(k);
  };
  const press = async (selector: string): Promise<void> => {
    await owner.locator(selector).first().focus();
    await keys("Enter");
  };
  const hit = owner.locator(site.editorHit);
  const cursor = owner.locator(site.editorCursor);
  await press(site.editRoom);
  await expect(owner.locator(site.editorTray)).toBeVisible();
  // The room is a keyboard target, and the prompt names its keys.
  await expect(hit).toHaveAttribute("tabindex", "0");
  // The walk floor under it is out of the way: one "Room floor" stop, and arrows don't also walk (OME-1364).
  await expect(owner.locator(site.walkFloor)).toHaveJSProperty("inert", true);
  await expect(owner.locator(site.editorPicked)).toContainText("arrow keys");

  // A tray piece picked with the keyboard hands focus to the room; arrows walk the cursor, Enter puts it down.
  await press(`${site.editorTab}:has-text("Decor")`);
  await press(`${site.editorSlot}[data-kind="popcorn"]`);
  await expect(hit).toBeFocused();
  await expect(owner.locator(site.editorPicked)).toContainText("arrow keys");
  // The TV stands on (0,0), so the cursor says the cart can't go there.
  await expect(cursor).toHaveText("Popcorn cart, column 1 row 1, can't go here");
  await keys(...Array<string>(9).fill("ArrowRight"), ...Array<string>(9).fill("ArrowDown"));
  await expect(cursor).toHaveText("Popcorn cart, column 10 row 10");
  await keys("Enter");
  await expect(owner.locator(site.editorRotate)).toBeEnabled();
  await press(site.editorRotate);

  // Select the lamp at (9,0) from the room, and move it to (8,1).
  await hit.focus();
  await keys(...Array<string>(9).fill("ArrowUp"));
  await expect(cursor).toHaveText("Lamp, column 10 row 1");
  await keys("Enter", "ArrowDown", "ArrowLeft", "Enter");

  // Put back the plant at (0,9).
  await keys(...Array<string>(8).fill("ArrowLeft"), ...Array<string>(8).fill("ArrowDown"));
  await expect(cursor).toHaveText("Plant, column 1 row 10");
  await keys("Enter");
  await press(site.editorRemove);

  // A print on the right wall: the cursor stays where it was, and up from the back row is the wall.
  await press(`${site.editorTab}:has-text("Floor & wall")`);
  await press(`${site.editorSlot}[data-kind="frame"]`);
  await expect(hit).toBeFocused();
  await keys("ArrowRight", "ArrowRight", ...Array<string>(10).fill("ArrowUp"));
  await expect(cursor).toHaveText("Print, right wall 3");
  await keys("Enter");

  await press(site.editorSave);
  await expect(owner.locator(site.editorMessage)).toHaveText("Saved.");
  const saved = await savedOf(owner);
  expect(saved.find((f) => f.kind === "popcorn")).toMatchObject({ col: 9, row: 9 });
  expect(saved.find((f) => f.kind === "popcorn")?.facing).not.toBe(defaultFacing("popcorn", 9, 9));
  expect(saved.find((f) => f.kind === "lamp")).toMatchObject({ col: 8, row: 1 });
  expect(saved.find((f) => f.kind === "plant")).toBeUndefined();
  expect(saved.find((f) => f.kind === "frame")).toMatchObject({ col: 2, row: 0, facing: "sw" });
  expect(saved).toHaveLength(DEFAULT_LAYOUT.furniture.length + 1);
  // Done: the walk floor is a keyboard stop again.
  await press(site.editRoom);
  await expect(owner.locator(site.walkFloor)).toHaveJSProperty("inert", false);
  await expect(owner.locator(site.walkFloor)).toHaveAttribute("tabindex", "0");
});

// OME-1425: a door asks where it goes before it is placed; a link of another site (or this room's own) is refused inline.
test("placing a door asks for its room: a bad link is refused inline, a saved room or a pasted link is placed and saved, two at most", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("doored");
  const film = "e2e-furniture-doortarget";
  const owner = await newPage(browser, []);
  await owner.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey }, [film]: { title: "Film night" } } })] as const,
  );
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "owner");
  await owner.locator(site.editRoom).click();
  await expect(owner.locator(site.editorTray)).toBeVisible();
  await owner.locator(site.editorTab).filter({ hasText: "Decor" }).click();
  const doorSlot = owner.locator(`${site.editorSlot}[data-kind="door"]`);
  await expect(owner.locator(site.editorDoors)).toHaveText("Doors 0/2");

  await doorSlot.click();
  await expect(owner.locator(site.doorPicker)).toBeVisible();
  // The saved rooms (this room left out) by title, and a place to paste a link.
  await expect(owner.locator(site.doorTargetRoom)).toHaveText(["Film night"]);
  for (const bad of ["https://evil.test/r/e2e-furniture-doortarget", `${URLS.web}/about`, "not a link", `${URLS.web}/r/${id}`]) {
    await owner.locator(site.doorTargetInput).fill(bad);
    await owner.locator(site.doorTargetUse).click();
    await expect(owner.locator(site.doorTargetError)).toBeVisible();
    await expect(owner.locator(site.doorTargetError)).toHaveAttribute("role", "alert");
    await expect(owner.locator(site.doorPicker)).toBeVisible();
  }
  // Nothing was held, so nothing is placed.
  await clickCell(owner, 0, 3);
  expect((await layoutOf(owner)).some((f) => f.kind === "door")).toBe(false);
  await expect(owner.locator(site.editorDoors)).toHaveText("Doors 0/2");

  await owner.locator(site.doorTargetInput).fill(`${URLS.web}/r/${film}`);
  await owner.locator(site.doorTargetUse).click();
  await expect(owner.locator(site.doorPicker)).toBeHidden();
  await clickCell(owner, 0, 3);
  await expect(owner.locator(site.editorDoors)).toHaveText("Doors 1/2");

  await doorSlot.click();
  await owner.locator(site.doorTargetRoom).filter({ hasText: "Film night" }).click();
  await clickCell(owner, 0, 5);
  await expect(owner.locator(site.editorDoors)).toHaveText("Doors 2/2");
  await expect(doorSlot).toHaveAttribute("aria-disabled", "true");
  await expect(doorSlot).toHaveAttribute("title", /2 doors/);

  await owner.locator(site.editorSave).click();
  await expect(owner.locator(site.editorMessage)).toHaveText("Saved.");
  const doors = v.parse(v.object({ furniture: v.array(v.object({ kind: v.string(), col: v.number(), target: v.optional(v.string()) })) }), await handle(owner, "layout")).furniture.filter((f) => f.kind === "door");
  expect(doors.map((d) => d.target)).toEqual([film, film]);
});

test("the new colours (OME-1463): the editor offers them, they save, and a guest draws them, after a reload too", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("recolour");
  const owner = await newPage(browser, []);
  await owner.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })] as const,
  );
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "owner");
  await owner.locator(site.editRoom).click();
  await expect(owner.locator(site.editorTray)).toBeVisible();
  const swatch = (name: string) => owner.locator(`${site.editorSwatch}[aria-label="${name}"]`);

  // The classic rug: its shipped navy and the two new ones.
  await clickCell(owner, 3, 3);
  await expect(owner.locator(site.editorSwatch)).toHaveCount(3);
  await swatch("rust").click();
  await expect(swatch("rust")).toHaveAttribute("aria-checked", "true");
  // Two armchairs out, a teal sofa (2 seats) in: still 8 seats.
  for (const [c, r] of [[1, 5], [2, 4]] as const) {
    await clickCell(owner, c, r);
    await owner.locator(site.editorRemove).click();
  }
  await owner.locator(site.editorTab).filter({ hasText: "Seats" }).click();
  await owner.locator(`${site.editorSlot}[data-kind="sofa"]`).click();
  await expect(owner.locator(site.editorSwatch)).toHaveCount(4);
  await swatch("teal").click();
  await clickCell(owner, 8, 8);
  await expect(owner.locator(site.editorProblems)).toBeEmpty();
  await owner.locator(site.editorSave).click();
  await expect(owner.locator(site.editorMessage)).toHaveText("Saved.");

  const saved = v.object({ furniture: v.array(v.object({ kind: v.string(), variant: v.optional(v.number()) })) });
  const drawn = (p: Page): Promise<string[]> => p.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "scene") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as string[]) : [];
  });
  const guest = await newPage(browser, []);
  for (const reload of [false, true]) {
    // A reload resumes the session: no nickname step.
    if (reload) {
      await guest.reload();
      await expect(guest.locator(site.room)).toBeVisible();
    } else {
      await guest.goto(`${URLS.web}/r/${id}#k=${inviteKey}`);
      await enter(guest, "guest");
    }
    const variants = async (): Promise<(number | undefined)[]> => {
      const furniture = v.parse(v.nullable(saved), await handle(guest, "layout"))?.furniture ?? [];
      return ["rug", "sofa"].map((k) => furniture.find((f) => f.kind === k)?.variant);
    };
    await expect.poll(variants).toEqual([1, 2]);
    // Both kinds draw from their recoloured copies: two copies loading at once once lost one of them (OME-1494).
    const kinds = async (): Promise<boolean[]> => {
      const keys = await drawn(guest);
      return ["recolour/rug/1/rug/", "recolour/sofa/2/furniture/sofa/velvet/"].map((prefix) => keys.some((k) => k.startsWith(prefix)));
    };
    await expect.poll(kinds).toEqual([true, true]);
  }
});

test("the wall pieces' new colours (OME-1503): a meadow print and peach lights save, and a guest draws them, after a reload too", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("wallhue");
  const owner = await newPage(browser, []);
  await owner.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })] as const,
  );
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "owner");
  const keys = async (...pressed: string[]): Promise<void> => {
    for (const k of pressed) await owner.keyboard.press(k);
  };
  const hit = owner.locator(site.editorHit);
  const cursor = owner.locator(site.editorCursor);
  const swatch = (name: string) => owner.locator(`${site.editorSwatch}[aria-label="${name}"]`);
  await owner.locator(site.editRoom).click();
  await expect(owner.locator(site.editorTray)).toBeVisible();
  await owner.locator(site.editorTab).filter({ hasText: "Floor & wall" }).click();

  // A print in its first new colour on the right wall, string lights in their second on the left wall.
  await owner.locator(`${site.editorSlot}[data-kind="frame"]`).click();
  await expect(owner.locator(site.editorSwatch)).toHaveCount(4);
  await swatch("meadow").click();
  await hit.focus();
  // Onto the floor from wherever the cursor is, up onto the right wall, then along it.
  await keys("ArrowRight", "ArrowDown", ...Array<string>(11).fill("ArrowUp"), ...Array<string>(10).fill("ArrowLeft"), "ArrowRight", "ArrowRight");
  await expect(cursor).toHaveText("Print, right wall 3");
  await keys("Enter");
  await owner.locator(`${site.editorSlot}[data-kind="garland"]`).click();
  await expect(owner.locator(site.editorSwatch)).toHaveCount(4);
  await swatch("peach").click();
  await hit.focus();
  // Off the right wall, left onto the left wall at its first slot, then down it.
  await keys("ArrowDown", ...Array<string>(11).fill("ArrowLeft"), "ArrowDown", "ArrowDown");
  await expect(cursor).toHaveText("String lights, left wall 3");
  await keys("Enter");
  await expect(owner.locator(site.editorProblems)).toBeEmpty();
  await owner.locator(site.editorSave).click();
  await expect(owner.locator(site.editorMessage)).toHaveText("Saved.");

  const saved = v.object({ furniture: v.array(v.object({ kind: v.string(), variant: v.optional(v.number()) })) });
  const drawn = (p: Page): Promise<string[]> => p.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "scene") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as string[]) : [];
  });
  const guest = await newPage(browser, []);
  for (const reload of [false, true]) {
    if (reload) {
      await guest.reload();
      await expect(guest.locator(site.room)).toBeVisible();
    } else {
      await guest.goto(`${URLS.web}/r/${id}#k=${inviteKey}`);
      await enter(guest, "guest");
    }
    const variants = async (): Promise<(number | undefined)[]> => {
      const furniture = v.parse(v.nullable(saved), await handle(guest, "layout"))?.furniture ?? [];
      return ["frame", "garland"].map((k) => furniture.find((f) => f.kind === k)?.variant);
    };
    await expect.poll(variants).toEqual([2, 3]);
    const kinds = async (): Promise<boolean[]> => {
      const keys = await drawn(guest);
      return ["recolour/frame/2/furniture/frame/dusk/", "recolour/garland/3/furniture/garland/warm/"].map((prefix) => keys.some((k) => k.startsWith(prefix)));
    };
    await expect.poll(kinds).toEqual([true, true]);
  }
});

// OME-2074: Done or Escape with unsaved changes used to drop them silently. Now Done asks (Save / Discard / Keep editing)
// and Escape never discards.
test("leaving the editor with unsaved changes asks first: Escape keeps editing, Discard drops them, Save keeps them", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("editorleave");
  const owner = await newPage(browser, []);
  await owner.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })] as const,
  );
  await owner.goto(`${URLS.web}/r/${id}`);
  await enter(owner, "owner");
  const n = DEFAULT_LAYOUT.furniture.length;
  const count = owner.locator(site.editorCount);
  const leave = owner.locator(site.editorLeave);
  const place = async (): Promise<void> => {
    await owner.locator(site.editRoom).click();
    await expect(count).toContainText(`${String(n)} /`);
    await owner.locator(site.editorTab).filter({ hasText: "Decor" }).click();
    await owner.locator(`${site.editorSlot}[data-kind="popcorn"]`).click();
    await clickCell(owner, 9, 9);
    await expect(count).toContainText(`${String(n + 1)} /`);
  };

  await place();
  // Escape asks rather than discards; Escape again keeps editing.
  await owner.locator(site.editorHit).focus();
  await owner.keyboard.press("Escape");
  await expect(leave).toBeVisible();
  await expect(owner.locator(site.editorLeaveKeep)).toBeFocused();
  await owner.keyboard.press("Escape");
  await expect(leave).toBeHidden();
  await expect(count).toContainText(`${String(n + 1)} /`);

  // Done asks too; Discard closes the editor and drops the piece.
  await owner.locator(site.editRoom).click();
  await expect(leave).toBeVisible();
  await owner.locator(site.editorLeaveDiscard).click();
  await expect(owner.locator(site.editorTray)).toBeHidden();
  await expect(owner.locator(site.editRoom)).toHaveAttribute("aria-pressed", "false");
  expect(await savedOf(owner)).toHaveLength(n);

  // Save from the prompt keeps it, after a reload too.
  await place();
  await owner.locator(site.editRoom).click();
  await owner.locator(site.editorLeaveSave).click();
  await expect(owner.locator(site.editorTray)).toBeHidden();
  await expect.poll(async () => (await savedOf(owner)).length).toBe(n + 1);
  await owner.reload();
  await expect(owner.locator(site.room)).toBeVisible();
  await expect.poll(async () => (await savedOf(owner)).length).toBe(n + 1);

  // Nothing changed: Done closes at once, no prompt.
  await owner.locator(site.editRoom).click();
  await expect(count).toBeVisible();
  await owner.locator(site.editRoom).click();
  await expect(owner.locator(site.editorTray)).toBeHidden();
});
