// Furniture from snapshot.room.layout (OME-278, ADR 0021). The server doesn't hand out custom layouts yet, so the room
// socket is routed and its snapshots rewritten: no layout (a pre-M4 server), DEFAULT_LAYOUT, or a test layout with set (g) pieces.
import type { Browser, Page, Request } from "@playwright/test";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, ROOM_SECRETS_STORAGE_KEY, type RoomLayout } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { clickSettled } from "./support/room";
import { site } from "./support/selectors";
import { cellCenter } from "../apps/web/src/layout";
import { WALK_SETTLE_MS, scene, seatedBetween, selfId } from "./support/scene";
import { testRoomId } from "./support/test-rooms";
import { BAR, BAR_PIECE, IN_USE, doorRoom, SET_G, SET_G_SEAT_PIECE, V2_BENCHES, V2_BENCHES_PIECE, V2_SEATS, V2_SEATS_PIECE, V3_POUFS, V3_POUFS_PIECE } from "./fixtures/layouts";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;

type Rewrite = { readonly layout: RoomLayout } | "none";

/** Routes the room socket and sets (or strips) the layout of every snapshot the server sends. */
async function withLayout(page: Page, rewrite: Rewrite): Promise<void> {
  await page.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg: unknown = typeof m === "string" ? JSON.parse(m) : null;
      const room: unknown = typeof msg === "object" && msg !== null && Reflect.get(msg, "type") === "snapshot" ? Reflect.get(msg, "room") : null;
      if (typeof room !== "object" || room === null) {
        ws.send(m);
        return;
      }
      if (rewrite === "none") Reflect.deleteProperty(room, "layout");
      else Reflect.set(room, "layout", rewrite.layout);
      ws.send(JSON.stringify(msg));
    });
  });
}

async function enter(page: Page, nickname: string, url = ROOM_URL): Promise<void> {
  await page.goto(url);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.connectionStatus)).toHaveText("");
}

const furnitureOnly = (s: readonly string[]): string[] => s.filter((x) => !x.startsWith("avatar:"));
const isAtlas = (r: Request): boolean => /furniture[^/]*\.(png|json|js)(\?|$)/.test(r.url()) && !r.url().includes("/src/furniture.ts");
/** Catalogue v2's sheet, manifest or chunk (OME-1113). */
const isV2 = (u: string): boolean => /furniture-v2[^/]*\.(png|json|js|ts)(\?|$)/.test(u);
/** Batch 6's sheet, manifest or chunk (OME-1439). */
const isV4 = (u: string): boolean => /furniture-v4[^/]*\.(png|json|js|ts)(\?|$)/.test(u);

/** True once `avatar:<self>` draws over `piece`'s back and, if it has one, under its front (a cushion facing the camera has none). */
async function seatedOn(page: Page, self: string, piece: string): Promise<boolean> {
  const order = await scene(page);
  const back = order.indexOf(`furniture/${piece}/back`);
  const me = order.indexOf(`avatar:${self}`);
  const front = order.indexOf(`furniture/${piece}/front`);
  return back >= 0 && back < me && (front < 0 || me < front);
}

test.describe("furniture from the room layout", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  test("no layout falls back to DEFAULT_LAYOUT: the same room as today, and the furniture atlas never loads", async ({ browser }) => {
    const draws: string[][] = [];
    const seatBoxes: unknown[] = [];
    for (const [i, rewrite] of (["none", { layout: DEFAULT_LAYOUT }] as const).entries()) {
      const context = await watchCsp(await browser.newContext());
      try {
        await stubExternalNetwork(context);
        const page = await context.newPage();
        const atlas: string[] = [];
        page.on("request", (r) => {
          if (isAtlas(r)) atlas.push(r.url());
        });
        await withLayout(page, rewrite);
        await enter(page, `fallback-${String(i)}`);
        await expect(page.locator(site.seat)).toHaveCount(8);
        // The room atlas (OME-1062) arrives after the first layout: wait for its shell before reading the scene.
        await expect.poll(async () => (await scene(page)).includes("wall/corner")).toBe(true);
        draws.push(furnitureOnly(await scene(page)));
        seatBoxes.push(await page.locator(site.seat).evaluateAll((els) => els.map((e) => (e instanceof HTMLElement ? e.style.translate : ""))));
        await test.info().attach(`room-${i === 0 ? "no-layout" : "default-layout"}.png`, { body: await page.locator(site.room).screenshot(), contentType: "image/png" });
        expect(atlas).toEqual([]);
      } finally {
        await context.close();
      }
    }
    expect(draws[0]).toEqual(draws[1]);
    expect(seatBoxes[0]).toEqual(seatBoxes[1]);
    // The room atlas's room (OME-1062): planks, both back walls, the console, eight armchairs, no placeholder markers.
    const drawn = draws[0] ?? [];
    expect(drawn.filter((k) => k.startsWith("floor/") || k.startsWith("rug/"))).toHaveLength(100);
    expect(drawn.filter((k) => k.startsWith("wall/l/") || k.startsWith("wall/r/"))).toHaveLength(22);
    expect(drawn.filter((k) => /^armchair\/\w+\/back$/.test(k))).toHaveLength(8);
    expect(drawn).toContain("tv/0");
    expect(drawn.some((k) => k.startsWith("seat:"))).toBe(false);
  });

  test("a set (g) layout loads the atlas and draws a seated avatar between its seat's back and front", async ({ browser }) => {
    const context = await watchCsp(await browser.newContext());
    try {
      await stubExternalNetwork(context);
      const page = await context.newPage();
      const atlas: string[] = [];
      page.on("request", (r) => {
        if (isAtlas(r)) atlas.push(r.url());
      });
      await withLayout(page, { layout: SET_G });
      await enter(page, "sofa-sitter");
      await expect.poll(async () => (await scene(page)).some((k) => k.startsWith("furniture/"))).toBe(true);
      expect(atlas.some((u) => u.includes(".png"))).toBe(true);
      // A v1-only room never fetches catalogue v2 (OME-1113).
      expect(atlas.filter(isV2)).toEqual([]);

      // A free seat on a two-seater; the far and near seats of one sofa both count.
      const seats = page.locator(site.seat);
      let seat = -1;
      for (let i = 0; i < 6 && seat < 0; i++) if ((await seats.nth(i).getAttribute("data-occupied")) === "false") seat = i;
      expect(seat).toBeGreaterThanOrEqual(0);
      await clickSettled(page, seats.nth(seat));
      await expect(seats.nth(seat)).toHaveClass(/mine/);

      const self = await selfId(page);
      const piece = SET_G_SEAT_PIECE[seat] ?? "";
      await expect
        .poll(() => seatedBetween(page, self, piece), { timeout: WALK_SETTLE_MS })
        .toBe(true);
      await test.info().attach("room-set-g-seated.png", { body: await page.locator(site.room).screenshot(), contentType: "image/png" });
    } finally {
      await context.close();
    }
  });

  // OME-1113: catalogue v2 is its own lazy sheet; a v2 room fetches it (and not set (g)), and every v2 seat seats in every facing.
  // OME-1351: catalogue v3's pieces share that sheet; the pouf seats in every facing and every v3 piece draws.
  // Seeded rooms of their own: this test sits on given seats, so another spec's sitter in the lobby can't take one.
  for (const [name, room, layout, pieces, sits] of [
    ["cushions in all four facings, benches ne and nw", "v2seats", V2_SEATS, V2_SEATS_PIECE, [0, 1, 2, 3, 4, 7]],
    ["benches se and sw", "v2benches", V2_BENCHES, V2_BENCHES_PIECE, [0, 3]],
    ["poufs in all four facings, beside every v3 piece", "v3poufs", V3_POUFS, V3_POUFS_PIECE, [0, 1, 2, 3]],
  ] as const) {
    test(`a catalogue v2 room loads only the v2 sheet and seats sitters on ${name}`, async ({ browser }) => {
      const context = await watchCsp(await browser.newContext());
      try {
        await stubExternalNetwork(context);
        const page = await context.newPage();
        const atlas: string[] = [];
        page.on("request", (r) => {
          if (isAtlas(r)) atlas.push(r.url());
        });
        await withLayout(page, { layout });
        await enter(page, "v2-sitter", `${URLS.web}/r/${testRoomId("furniture", room)}`);
        await expect.poll(async () => (await scene(page)).some((k) => k.startsWith("furniture/"))).toBe(true);
        expect(atlas.some((u) => isV2(u) && u.includes(".png"))).toBe(true);
        expect(atlas.filter((u) => !isV2(u))).toEqual([]);
        const kinds = layout.furniture.map((f) => f.kind).filter((k) => k !== "tv");
        await expect.poll(async () => {
          const drawn = new Set((await scene(page)).map((k) => k.split("/")[1]));
          return kinds.filter((k) => !drawn.has(k));
        }).toEqual([]);

        const self = await selfId(page);
        const seats = page.locator(site.seat);
        for (const i of sits) {
          await clickSettled(page, seats.nth(i));
          await expect(seats.nth(i)).toHaveClass(/mine/);
          await expect.poll(() => seatedOn(page, self, pieces[i] ?? ""), { timeout: WALK_SETTLE_MS }).toBe(true);
        }
        await test.info().attach(`room-v2-${String(sits.length)}.png`, { body: await page.locator(site.room).screenshot(), contentType: "image/png" });
      } finally {
        await context.close();
      }
    });
  }
});

// OME-1407: a piece plays its "in use" loop while someone stands at its front, worked out on every client from where people stand.
test.describe("furniture in use", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  /** The furniture loops running now (room-view.ts `loops`): idle key and frame shown. */
  const loops = (page: Page): Promise<unknown> =>
    page.evaluate(() => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      const fn: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "furnitureLoops") : null;
      return typeof fn === "function" ? (Reflect.apply(fn, room, []) as unknown) : null;
    });

  /** Clicks stage point `cellCenter(col, row)` on the floor layer, wherever the stage is scaled to. */
  async function clickCell(page: Page, col: number, row: number): Promise<void> {
    const box = await page.locator(site.walkFloor).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
    });
    const p = cellCenter(col, row);
    await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
  }

  test("standing at the arcade's front plays its loop; walking away stops it", async ({ browser }) => {
    const context = await watchCsp(await browser.newContext());
    try {
      await stubExternalNetwork(context);
      const page = await context.newPage();
      await withLayout(page, { layout: IN_USE });
      await enter(page, "player-1", `${URLS.web}/r/${testRoomId("furniture", "inuse")}`);
      await expect.poll(async () => (await scene(page)).includes("furniture/arcade/night/se/back")).toBe(true);
      await expect.poll(() => loops(page), { timeout: WALK_SETTLE_MS }).toEqual([]);
      await clickCell(page, 3, 2);
      await expect.poll(async () => JSON.stringify(await loops(page)), { timeout: WALK_SETTLE_MS }).toMatch(/^\[\{"key":"furniture\/arcade\/night\/se\/back","frame":[0-2]\}\]$/);
      // The loop steps: more than one frame shows over a second.
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        seen.add(JSON.stringify(await loops(page)));
        await page.waitForTimeout(100);
      }
      expect(seen.size).toBeGreaterThan(1);
      await clickCell(page, 7, 8);
      await expect.poll(() => loops(page), { timeout: WALK_SETTLE_MS }).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // OME-1439: batch 6 is its own lazy sheet; the hammock sways while someone sits in it, the piano plays while someone stands at its front.
  test("a bar room loads only the batch 6 sheet; the hammock sways while I sit in it, the piano plays while I stand at it", async ({ browser }) => {
    const context = await watchCsp(await browser.newContext());
    try {
      await stubExternalNetwork(context);
      const page = await context.newPage();
      const atlas: string[] = [];
      page.on("request", (r) => {
        if (isAtlas(r)) atlas.push(r.url());
      });
      await withLayout(page, { layout: BAR });
      await enter(page, "bar-1", `${URLS.web}/r/${testRoomId("furniture", "bar")}`);
      const kinds = BAR.furniture.map((f) => f.kind).filter((k) => k !== "tv");
      await expect.poll(async () => {
        const drawn = new Set((await scene(page)).map((k) => k.split("/")[1]));
        return kinds.filter((k) => !drawn.has(k));
      }).toEqual([]);
      expect(atlas.some((u) => isV4(u) && u.includes(".png"))).toBe(true);
      expect(atlas.filter((u) => !isV4(u))).toEqual([]);
      await expect.poll(() => loops(page)).toEqual([]);

      const self = await selfId(page);
      const seats = page.locator(site.seat);
      await clickSettled(page, seats.nth(0));
      await expect.poll(() => seatedOn(page, self, BAR_PIECE[0] ?? ""), { timeout: WALK_SETTLE_MS }).toBe(true);
      expect(await loops(page)).toEqual([]);
      await clickSettled(page, seats.nth(5));
      await expect.poll(() => seatedOn(page, self, BAR_PIECE[5] ?? ""), { timeout: WALK_SETTLE_MS }).toBe(true);
      await expect.poll(async () => JSON.stringify(await loops(page)), { timeout: WALK_SETTLE_MS }).toMatch(/^\[\{"key":"furniture\/hammock\/rust\/ne\/back","frame":[0-3]\}\]$/);
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        seen.add(JSON.stringify(await loops(page)));
        await page.waitForTimeout(150);
      }
      expect(seen.size).toBeGreaterThan(1);
      await test.info().attach("room-bar-hammock.png", { body: await page.locator(site.room).screenshot(), contentType: "image/png" });

      await clickCell(page, 2, 1);
      await expect.poll(async () => JSON.stringify(await loops(page)), { timeout: WALK_SETTLE_MS }).toMatch(/^\[\{"key":"furniture\/piano\/wood\/sw\/back","frame":[01]\}\]$/);
      await clickCell(page, 7, 8);
      await expect.poll(() => loops(page), { timeout: WALK_SETTLE_MS }).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("under reduced motion the hammock someone sits in shows its still frame", async ({ browser }) => {
    const context = await watchCsp(await browser.newContext({ reducedMotion: "reduce" }));
    try {
      await stubExternalNetwork(context);
      const page = await context.newPage();
      await withLayout(page, { layout: BAR });
      await enter(page, "bar-still", `${URLS.web}/r/${testRoomId("furniture", "barstill")}`);
      await expect.poll(async () => (await scene(page)).includes("furniture/hammock/rust/nw/back")).toBe(true);
      const self = await selfId(page);
      await clickSettled(page, page.locator(site.seat).nth(6));
      await expect.poll(() => seatedOn(page, self, BAR_PIECE[6] ?? ""), { timeout: WALK_SETTLE_MS }).toBe(true);
      await expect.poll(async () => JSON.stringify(await loops(page))).toBe('[{"key":"furniture/hammock/rust/nw/back","frame":-1}]');
      await page.waitForTimeout(600);
      expect(JSON.stringify(await loops(page))).toBe('[{"key":"furniture/hammock/rust/nw/back","frame":-1}]');
    } finally {
      await context.close();
    }
  });

  // OME-1425: a door opens while anyone stands in front of it; my arrival there offers "Go to <room> · Stay".
  const DOOR_FRONT = [1, 3] as const;
  const DOOR_OPEN = '[{"key":"furniture/door/wood/se/back","frame":0}]';

  /** A fresh page in `room` (its snapshots carrying a door to `target`), a saved title for `target` when given. */
  async function inDoorRoom(browser: Browser, room: string, target: string, title?: string): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await watchCsp(await browser.newContext());
    await stubExternalNetwork(context);
    const page = await context.newPage();
    if (title !== undefined) {
      await page.addInitScript(
        ([key, value]) => {
          localStorage.setItem(key, value);
        },
        [ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [target]: { title } } })] as const,
      );
    }
    await withLayout(page, { layout: doorRoom(target) });
    // One nickname per attempt: the last attempt's member holds its name for the resume grace (RESUME_GRACE_MS).
    await enter(page, `door-${String(test.info().retry)}-${String(test.info().repeatEachIndex)}`, `${URLS.web}/r/${room}`);
    await expect.poll(async () => (await scene(page)).includes("furniture/door/wood/se/back")).toBe(true);
    return { page, close: () => context.close() };
  }

  test("standing in front of a door opens it and offers Go or Stay; Stay hides the chip until I arrive again", async ({ browser }) => {
    const target = testRoomId("furniture", "doortarget");
    const { page, close } = await inDoorRoom(browser, testRoomId("furniture", "doorstay"), target, "Film night");
    try {
      await expect(page.locator(site.doorChip)).toBeHidden();
      await expect.poll(() => loops(page)).toEqual([]);
      await clickCell(page, ...DOOR_FRONT);
      await expect(page.locator(site.doorChip)).toBeVisible({ timeout: WALK_SETTLE_MS });
      await expect(page.locator(site.doorChip)).toHaveText("Go to Film night · Stay");
      await expect.poll(async () => JSON.stringify(await loops(page))).toBe(DOOR_OPEN);
      // Nothing happens by itself.
      await page.waitForTimeout(1000);
      expect(new URL(page.url()).pathname).toBe(`/r/${testRoomId("furniture", "doorstay")}`);
      await page.locator(site.doorStay).click();
      await expect(page.locator(site.doorChip)).toBeHidden();
      // Still standing there: the door stays open, the chip stays away.
      expect(JSON.stringify(await loops(page))).toBe(DOOR_OPEN);
      await clickCell(page, 7, 8);
      await expect.poll(() => loops(page), { timeout: WALK_SETTLE_MS }).toEqual([]);
      await clickCell(page, ...DOOR_FRONT);
      await expect(page.locator(site.doorChip)).toBeVisible({ timeout: WALK_SETTLE_MS });
    } finally {
      await close();
    }
  });

  test("Go lands in the door's room", async ({ browser }) => {
    const target = testRoomId("furniture", "doortarget");
    const { page, close } = await inDoorRoom(browser, testRoomId("furniture", "doorgo"), target);
    try {
      await clickCell(page, ...DOOR_FRONT);
      await expect(page.locator(site.doorChip)).toHaveText("Go to another room · Stay", { timeout: WALK_SETTLE_MS });
      await page.locator(site.doorGo).click();
      await expect(page).toHaveURL(new RegExp(`/r/${target}$`));
    } finally {
      await close();
    }
  });

  test("a door to a room that is gone lands on Room not found, with a Back link to the room I came from", async ({ browser }) => {
    const from = testRoomId("furniture", "doorgone");
    const { page, close } = await inDoorRoom(browser, from, "e2e-furniture-nowhere");
    try {
      await clickCell(page, ...DOOR_FRONT);
      await expect(page.locator(site.doorGo)).toBeVisible({ timeout: WALK_SETTLE_MS });
      await page.locator(site.doorGo).click();
      await page.locator(site.nicknameInput).fill("player-1");
      await page.locator(site.joinButton).click();
      await expect(page.locator(site.notFound)).toBeVisible();
      await expect(page.locator(site.notFoundBack)).toHaveAttribute("href", `/r/${from}`);
    } finally {
      await close();
    }
  });
});

// OME-1520: the cat wanders with no wire. Every client works out its walk from the room id, the piece's index and the
// 20 s slot of server time, so two clients draw it on the same cell at every slot boundary; reduced motion keeps it home.
test.describe("the wandering cat", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);

  const SLOT_MS = 20_000;
  /** A valid room (eight seats) with two cats. */
  const CATS: RoomLayout = {
    furniture: [...V2_BENCHES.furniture, { kind: "cat", col: 3, row: 3, facing: "sw" }, { kind: "cat", col: 7, row: 7, facing: "se", variant: 1 }],
  };
  const HOMES = ["3,3", "7,7"];

  interface Cat { readonly cell: string; readonly walking: boolean; readonly slot: number }
  /** Each cat as drawn now (room-view.ts `cats`): its cell "col,row", whether it walks, and the slot it is in. */
  const cats = (page: Page): Promise<Cat[]> =>
    page.evaluate(() => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      const fn: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "cats") : null;
      return typeof fn === "function" ? (Reflect.apply(fn, room, []) as Cat[]) : [];
    });
  const cells = (cs: readonly Cat[]): string[] => cs.map((c) => c.cell);

  test("two clients draw each cat on the same cell at every slot boundary; reduced motion keeps it on its placed cell", async ({ browser }) => {
    test.setTimeout(2 * SLOT_MS + 60_000);
    const roomUrl = `${URLS.web}/r/${testRoomId("furniture", "cat")}`;
    const open = async (nickname: string, reduced: boolean): Promise<{ page: Page; close: () => Promise<void> }> => {
      const context = await watchCsp(await browser.newContext(reduced ? { reducedMotion: "reduce" } : {}));
      await stubExternalNetwork(context);
      await context.addInitScript(() => {
        localStorage.setItem("omega.motion", "smooth");
      });
      const page = await context.newPage();
      await withLayout(page, { layout: CATS });
      await enter(page, nickname, roomUrl);
      return { page, close: () => context.close() };
    };
    const a = await open("cat-a", false);
    const b = await open("cat-b", false);
    const still = await open("cat-still", true);
    try {
      await expect.poll(async () => (await cats(a.page)).length).toBe(2);
      await expect.poll(async () => (await cats(b.page)).length).toBe(2);
      const seen = new Set<string>();
      for (let boundary = 0; boundary < 2; boundary++) {
        const slot = (await cats(a.page))[0]?.slot ?? 0;
        await expect.poll(async () => (await cats(a.page))[0]?.slot, { timeout: SLOT_MS + 5000, intervals: [250] }).toBe(slot + 1);
        // Arrived (a walk within 3 cells takes a few seconds), still in the same slot on both clients.
        const settled = async (page: Page): Promise<Cat[]> => {
          let now: Cat[] = [];
          await expect.poll(async () => {
            now = await cats(page);
            return now.every((c) => !c.walking && c.slot === slot + 1);
          }, { timeout: 10_000 }).toBe(true);
          return now;
        };
        const onA = await settled(a.page);
        const onB = await settled(b.page);
        expect(cells(onB)).toEqual(cells(onA));
        for (const c of onA) seen.add(c.cell);
        expect(cells(await cats(still.page))).toEqual(HOMES);
      }
      // Over two slots, two cats leave their placed cells at least once (each slot's target is one of up to 49 cells).
      expect([...seen].some((c) => !HOMES.includes(c))).toBe(true);
    } finally {
      await Promise.all([a.close(), b.close(), still.close()]);
    }
  });
});
