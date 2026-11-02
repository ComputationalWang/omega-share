// Room view (OME-2170, CEO decision C on the layout card): at 1280×800 a hero TV leaves the band too little height for
// readable avatars (~25 px). Room view puts the TV at its ADR 0012 floor (356×200) at the column's left, its shelf flush
// under it (OME-2195), and gives the room the rest of the column, so avatars (41 to 47 px at 1×) are at least 40 px. The
// shelf hangs over the band's top-left corner, above the left wall, where only the backdrop is (as the moments strip does).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { BAND_WALL_TOP, STAGE_W, TILE_H, TILE_W, bandFit, bandHome, cellCenter, setNorth, wideLayout, type Point, type Rect } from "../src/layout";

const PRESETS = ["bar", "cafe", "cinema", "classic", "dank-dungeon", "empty", "living", "lounge", "penthouse", "studio"] as const;
const preset = (name: string) => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../../../assets/presets/${name}.json`, import.meta.url), "utf8")));
/** 1280×800's left column as QA measured it on OME-2168 (the studio shot). */
const COLUMN = { w: 905, h: 655 };
/** The shortest avatar sprite at 1× (seated, assets/avatars). */
const AVATAR_H = 41;

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

/** 1100×800's left column: the narrowest window that opens in Room view. */
const NARROW = { w: 725, h: 655 };

/** A point of the column (wrap px) in stage px, as room-layout.ts boxes the band and room-window.ts centres it. */
function toStage(l: ReturnType<typeof wideLayout>, w: number, k: number, seats: readonly Point[], standing: readonly Point[], me: Point | null, p: Point): Point {
  const sw = Math.min(l.stage.w, STAGE_W * k);
  const view = { w: sw / k, h: l.stage.h / k };
  const c = bandHome(seats, standing, view, me);
  return { x: c.x - view.w / 2 + (p.x - Math.floor((w - sw) / 2)) / k, y: c.y - view.h / 2 + (p.y - l.stage.y) / k };
}
/** The back wall's art falls from BAND_WALL_TOP at the back corner along the left wall, a tile's slope. */
const wallTop = (x: number): number => BAND_WALL_TOP + Math.max(0, STAGE_W / 2 - x) * (TILE_H / TILE_W);

afterEach(() => {
  setNorth(false);
});

describe("Room view at 1280×800 (OME-2170)", () => {
  // QA OME-2174 § 6 item 2: the shelf sat beside the TV at the far right, dark above it. It's docked under the TV now.
  test("the TV is at its 356×200 floor at the column's left, the shelf flush under it, the band right under the TV", () => {
    const l = wideLayout(COLUMN.w, COLUMN.h, "youtube", 1, 1, true);
    expect(l.tv).toEqual({ x: 6, y: 6, w: 356, h: 200 });
    expect(l.controls).toEqual({ x: l.tv.x, y: l.tv.y + l.tv.h + 8, w: l.tv.w, h: 44 });
    expect(l.stage.y).toBe(l.controls.y);
    for (const r of [l.tv, l.controls, l.stage]) expect(inside(r, COLUMN.w, COLUMN.h)).toBe(true);
    expect(intersects(l.tv, l.stage)).toBe(false);
  });

  test("the shelf over the band's corner hides none of the back wall's art, in any preset from either side", () => {
    for (const name of PRESETS) {
      for (const north of [false, true]) {
        setNorth(north);
        const room = preset(name);
        const l = wideLayout(COLUMN.w, COLUMN.h, "youtube", 1, 1, true);
        for (const me of [null, cellCenter(0, 0), cellCenter(9, 9)]) {
          const seats = seatPoints(room);
          const standing = standingPoints(room);
          const k = bandFit(l.scale, l.stage.h, [...seats, ...standing], me);
          const foot = toStage(l, COLUMN.w, k, seats, standing, me, { x: l.controls.x + l.controls.w, y: l.controls.y + l.controls.h });
          expect(foot.y).toBeLessThanOrEqual(wallTop(foot.x));
        }
      }
    }
  });

  test("at 1100×800 the shelf would hide the back wall's top: the band starts under it", () => {
    const l = wideLayout(NARROW.w, NARROW.h, "youtube", 1, 1, true);
    expect(l.tv.w).toBe(356);
    expect(l.controls.y).toBe(l.tv.y + l.tv.h + 8);
    expect(intersects(l.controls, l.stage)).toBe(false);
    expect(l.stage.y + l.stage.h).toBeLessThanOrEqual(NARROW.h);
  });

  test("off, the TV is the hero as before", () => {
    expect(wideLayout(COLUMN.w, COLUMN.h, "youtube", 1, 1, false)).toEqual(wideLayout(COLUMN.w, COLUMN.h, "youtube"));
    expect(wideLayout(COLUMN.w, COLUMN.h, "youtube").tv.w).toBeGreaterThan(356);
  });

  // busy-desktop-1280x800, cinema/penthouse-desktop-south, penthouse/studio-desktop-north (QA OME-2168).
  const cases = [...PRESETS.map((p) => [p, "south"] as const), ["penthouse", "north"] as const, ["studio", "north"] as const];
  test.each(cases)("%s from the %s: the whole room fits with avatars at least 40 px tall", (name, side) => {
    setNorth(side === "north");
    const room = preset(name);
    const l = wideLayout(COLUMN.w, COLUMN.h, "youtube", 1, 1, true);
    for (const me of [null, cellCenter(0, 0), cellCenter(9, 9)]) {
      const k = bandFit(l.scale, l.stage.h, [...seatPoints(room), ...standingPoints(room)], me);
      expect(AVATAR_H * k).toBeGreaterThanOrEqual(40);
    }
  });

  test("Twitch keeps its 534×300 floor, its shelf under it and the band under the shelf", () => {
    const l = wideLayout(COLUMN.w, COLUMN.h, "twitch", 1, 1, true);
    expect(l.tv.w).toBe(534);
    expect(l.tv.h).toBe(300);
    expect(l.controls).toMatchObject({ x: l.tv.x, y: l.tv.y + l.tv.h + 8 });
    for (const r of [l.tv, l.controls, l.stage]) expect(inside(r, COLUMN.w, COLUMN.h)).toBe(true);
    expect(intersects(l.tv, l.controls)).toBe(false);
    expect(intersects(l.controls, l.stage)).toBe(false);
  });

  test("with no video there's no hero to give way: the same room-first split", () => {
    expect(wideLayout(COLUMN.w, COLUMN.h, null, 1, 1, true)).toEqual(wideLayout(COLUMN.w, COLUMN.h, null));
  });
});
