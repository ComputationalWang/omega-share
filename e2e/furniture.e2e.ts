// Furniture from snapshot.room.layout (OME-278, ADR 0021). The server doesn't hand out custom layouts yet, so the room
// socket is routed and its snapshots rewritten: no layout (a pre-M4 server), DEFAULT_LAYOUT, or a test layout with set (g) pieces.
import type { Page, Request } from "@playwright/test";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, type RoomLayout } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { clickSettled } from "./support/room";
import { site } from "./support/selectors";
import { WALK_SETTLE_MS, scene, seatedBetween, selfId } from "./support/scene";
import { testRoomId } from "./support/test-rooms";
import { SET_G, SET_G_SEAT_PIECE, V2_BENCHES, V2_BENCHES_PIECE, V2_SEATS, V2_SEATS_PIECE } from "./fixtures/layouts";

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
  // Seeded rooms of their own: this test sits on given seats, so another spec's sitter in the lobby can't take one.
  for (const [name, room, layout, pieces, sits] of [
    ["cushions in all four facings, benches ne and nw", "v2seats", V2_SEATS, V2_SEATS_PIECE, [0, 1, 2, 3, 4, 7]],
    ["benches se and sw", "v2benches", V2_BENCHES, V2_BENCHES_PIECE, [0, 3]],
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
