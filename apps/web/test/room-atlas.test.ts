import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { cellCenter, SEATS, TILE_H, TILE_W, TV } from "../src/layout";

// The room atlas (assets/room/room.json, OME-31 contract) and layout.ts must agree on geometry:
// every room frame is anchored at cellCenter(col,row), and tv.screen is relative to the tv/0 anchor at (0,0).
const Rect = v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() });
const RoomAtlas = v.object({
  frames: v.record(v.string(), v.object({ frame: Rect, anchor: v.object({ x: v.number(), y: v.number() }) })),
  meta: v.object({
    omega: v.object({
      tile: v.object({ w: v.number(), h: v.number() }),
      tv: v.object({ frame: v.string(), screen: Rect }),
    }),
  }),
});

const atlas = v.parse(RoomAtlas, await Bun.file(new URL("../../../assets/room/room.json", import.meta.url)).json());

describe("room atlas vs layout.ts", () => {
  test("tile size matches", () => {
    expect(atlas.meta.omega.tile).toEqual({ w: TILE_W, h: TILE_H });
  });

  test("tv.screen, measured from the tv/0 anchor at cellCenter(0,0), is exactly the TV rect", () => {
    const { frame, screen } = atlas.meta.omega.tv;
    expect(atlas.frames[frame]).toBeDefined();
    const anchor = cellCenter(0, 0);
    expect({ x: anchor.x + screen.x, y: anchor.y + screen.y, w: screen.w, h: screen.h }).toEqual({ ...TV });
  });

  test("the screen rect lies inside the tv/0 frame", () => {
    const { frame, screen } = atlas.meta.omega.tv;
    const f = atlas.frames[frame];
    if (f === undefined) throw new Error(`missing frame ${frame}`);
    const ax = f.anchor.x * f.frame.w;
    const ay = f.anchor.y * f.frame.h;
    expect(ax + screen.x).toBeGreaterThanOrEqual(0);
    expect(ay + screen.y).toBeGreaterThanOrEqual(0);
    expect(ax + screen.x + screen.w).toBeLessThanOrEqual(f.frame.w);
    expect(ay + screen.y + screen.h).toBeLessThanOrEqual(f.frame.h);
  });

  test("no seat sits on the cells the TV console covers (col+row <= 2)", () => {
    for (const s of SEATS) {
      // Invert cellCenter: (col+row) from y.
      const sum = (s.y - cellCenter(0, 0).y) / (TILE_H / 2);
      expect(sum).toBeGreaterThan(2);
    }
  });
});
