// Furniture from snapshot.room.layout (OME-278, ADR 0021). The server doesn't hand out custom layouts yet, so the room
// socket is routed and its snapshots rewritten: no layout (a pre-M4 server), DEFAULT_LAYOUT, or a test layout with set (g) pieces.
import type { Page, Request } from "@playwright/test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, type RoomLayout } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;

/** Two sofas and a couch take seats 0–5, then a wingback and a beanbag; plus a runner, a print, a bookcase and props. */
const SET_G: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "runner", col: 4, row: 4, facing: "ne", variant: 1 },
    { kind: "sofa", col: 2, row: 5, facing: "ne" },
    { kind: "sofa", col: 5, row: 2, facing: "nw", variant: 1 },
    { kind: "couch", col: 3, row: 7, facing: "nw" },
    { kind: "wingback", col: 1, row: 6, facing: "ne" },
    { kind: "beanbag", col: 7, row: 3, facing: "nw" },
    { kind: "frame", col: 3, row: 0, facing: "sw" },
    { kind: "bookshelf", col: 6, row: 0, facing: "sw" },
    { kind: "arclamp", col: 8, row: 8, facing: "sw" },
    { kind: "popcorn", col: 0, row: 9, facing: "se" },
  ],
};
/** Seat i of SET_G → the piece it sits on (its back/front frames). */
const SEAT_PIECE = ["sofa/velvet/ne", "sofa/velvet/ne", "sofa/navy/nw", "sofa/navy/nw", "couch/cream/nw", "couch/cream/nw", "wingback/ginger/ne", "beanbag/blush/nw"];

type Rewrite = { readonly layout: RoomLayout } | "none";

/** Routes the room socket and sets (or strips) the layout of every snapshot the server sends. */
async function withLayout(page: Page, rewrite: Rewrite): Promise<void> {
  await page.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== "string") return ws.send(m);
      const msg: unknown = JSON.parse(m);
      if (typeof msg !== "object" || msg === null || Reflect.get(msg, "type") !== "snapshot") return ws.send(m);
      const room: unknown = Reflect.get(msg, "room");
      if (typeof room !== "object" || room === null) return ws.send(m);
      if (rewrite === "none") Reflect.deleteProperty(room, "layout");
      else Reflect.set(room, "layout", rewrite.layout);
      ws.send(JSON.stringify(msg));
    });
  });
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.goto(ROOM_URL);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.connectionStatus)).toHaveText("");
}

/** The room handle's dev-build hooks (main.ts `window.__omega`). */
async function debugCall(page: Page, path: "scene" | "self"): Promise<unknown> {
  return page.evaluate((path) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    if (typeof room !== "object" || room === null) return null;
    if (path === "scene") {
      const scene: unknown = Reflect.get(room, "scene");
      return typeof scene === "function" ? (Reflect.apply(scene, room, []) as unknown) : null;
    }
    const state: unknown = Reflect.get(room, "state");
    const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
    return typeof s === "object" && s !== null ? (Reflect.get(s, "self") as unknown) : null;
  }, path);
}
const scene = async (page: Page): Promise<string[]> => v.parse(v.array(v.string()), await debugCall(page, "scene"));
const furnitureOnly = (s: readonly string[]): string[] => s.filter((x) => !x.startsWith("avatar:"));
const isAtlas = (r: Request): boolean => /furniture[^/]*\.(png|json|js)(\?|$)/.test(r.url()) && !r.url().includes("/src/furniture.ts");

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
        draws.push(furnitureOnly(await scene(page)));
        seatBoxes.push(await page.locator(site.seat).evaluateAll((els) => els.map((e) => (e instanceof HTMLElement ? e.style.transform : ""))));
        await test.info().attach(`room-${i === 0 ? "no-layout" : "default-layout"}.png`, { body: await page.locator(site.room).screenshot(), contentType: "image/png" });
        expect(atlas).toEqual([]);
      } finally {
        await context.close();
      }
    }
    expect(draws[0]).toEqual(draws[1]);
    expect(seatBoxes[0]).toEqual(seatBoxes[1]);
    // Today's room: the placeholder floor and eight seat markers, no furniture sprites.
    expect(draws[0]).toEqual(["floor", ...Array.from({ length: 8 }, (_, i) => `seat:${String(i)}`)]);
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

      // A free seat on a two-seater; the far and near seats of one sofa both count.
      const seats = page.locator(site.seat);
      let seat = -1;
      for (let i = 0; i < 6 && seat < 0; i++) if ((await seats.nth(i).getAttribute("data-occupied")) === "false") seat = i;
      expect(seat).toBeGreaterThanOrEqual(0);
      await seats.nth(seat).click();
      await expect(seats.nth(seat)).toHaveClass(/mine/);

      const self = v.parse(v.string(), await debugCall(page, "self"));
      const piece = SEAT_PIECE[seat] ?? "";
      await expect
        .poll(async () => {
          const order = await scene(page);
          const back = order.indexOf(`furniture/${piece}/back`);
          const me = order.indexOf(`avatar:${self}`);
          const front = order.indexOf(`furniture/${piece}/front`);
          return back >= 0 && back < me && me < front;
        })
        .toBe(true);
      await test.info().attach("room-set-g-seated.png", { body: await page.locator(site.room).screenshot(), contentType: "image/png" });
    } finally {
      await context.close();
    }
  });
});
