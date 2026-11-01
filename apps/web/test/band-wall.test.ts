// OME-2117 (design judge on OME-2116, QA OME-2107 finding 1): at 1280×800 the band was 240 px of the 532 px room, so the
// back wall and its art sat above it, and in a swap room my own avatar stood under its foot. The band holds at least half
// the room, it looks as high as keeps the audience whole (the back wall gets every row left over), and it keeps me whole
// wherever I stand, from either side of the room. The TV stays the hero (OME-1803).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { FLOOR_CELLS, RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { AVATAR_TOP, ROOM_VIEW, TAG_FOOT, TAG_OFFSET_Y, bandHome, cellCenter, setNorth, wheelView, wideLayout, type Point } from "../src/layout";

const PRESETS = ["bar", "cafe", "cinema", "classic", "dank-dungeon", "empty", "living", "lounge", "penthouse", "studio"] as const;
const SIDES = ["south", "north"] as const;
const preset = (name: string) => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../../../assets/presets/${name}.json`, import.meta.url), "utf8")));
/** 1280×800's left column as QA measured it (OME-2107: the band at y 487, 888 px wide, 240 tall). */
const COLUMN = { w: 888, h: 727 };

afterEach(() => {
  setNorth(false);
});

/** The band's view as the room window opens it (room-window.ts deskHome): centred on bandHome, kept on the room. */
function bandView(name: string, me: Point | null = null) {
  const l = wideLayout(COLUMN.w, COLUMN.h, "youtube");
  const room = preset(name);
  const shown = { w: l.stage.w / l.scale, h: l.stage.h / l.scale };
  const c = bandHome(seatPoints(room), standingPoints(room), shown, me);
  const view = wheelView(l.scale, { zoom: 1, pan: { x: c.x - shown.w / 2, y: c.y - shown.h / 2 } }, { x: 0, y: 0 }, 1, l.stage);
  return { room, pan: view.pan, shown };
}

describe("1280×800 with a video (OME-2117)", () => {
  test("the band holds at least half the room, and the TV stays the hero: at least 45 % of the window wide", () => {
    const l = wideLayout(COLUMN.w, COLUMN.h, "youtube");
    expect(l.stage.h).toBeGreaterThanOrEqual(ROOM_VIEW.h / 2);
    expect(l.tv.w).toBeGreaterThanOrEqual(0.45 * 1280);
  });

  test.each(PRESETS.flatMap((p) => SIDES.map((s) => [p, s] as const)))("%s from the %s: the audience whole, its front row's tags at the band's foot, so the back wall gets the rest", (name, side) => {
    setNorth(side === "north");
    const { room, pan, shown } = bandView(name);
    const audience = [...seatPoints(room), ...standingPoints(room)];
    const front = Math.max(...audience.map((p) => p.y)) + TAG_FOOT;
    const seatTop = Math.min(...seatPoints(room).map((p) => p.y)) - 22;
    // Where the back seats' tops and the front row's tags don't both fit, the seats stay whole (OME-1864) and the
    // front row's tags give way: that's the Dank Dungeon and the Penthouse from the south.
    if (front - seatTop > shown.h) {
      expect(pan.y).toBe(seatTop);
      return;
    }
    for (const p of audience) {
      expect(p.y + TAG_OFFSET_Y).toBeGreaterThanOrEqual(pan.y);
      expect(p.y + TAG_FOOT).toBeLessThanOrEqual(pan.y + shown.h);
    }
    // Any higher and the front row's tags would be cut: nothing more of the wall could show.
    expect(pan.y + shown.h).toBe(Math.min(ROOM_VIEW.y + ROOM_VIEW.h, front + 1));
  });

  // dank-dungeon-desktop-north (OME-2107): the owner stood where the band's foot cut them.
  test.each(["dank-dungeon", "penthouse", "studio"].flatMap((p) => SIDES.map((s) => [p, s] as const)))("%s from the %s: standing on any floor cell, I'm whole in the band, head to name tag where the seats leave room", (name, side) => {
    setNorth(side === "north");
    for (let col = 0; col < FLOOR_CELLS; col++) {
      for (let row = 0; row < FLOOR_CELLS; row++) {
        const me = cellCenter(col, row);
        const { room, pan, shown } = bandView(name, me);
        expect(me.y - AVATAR_TOP).toBeGreaterThanOrEqual(pan.y);
        expect(me.y).toBeLessThanOrEqual(pan.y + shown.h);
        // My tag gives way only to the back seats' tops (OME-1864): a few front cells of the Dank Dungeon, the Penthouse and the Studio.
        const seatTop = Math.min(...seatPoints(room).map((p) => p.y)) - 22;
        if (me.y + TAG_FOOT - seatTop > shown.h) expect(pan.y).toBe(seatTop);
        else expect(me.y + TAG_FOOT).toBeLessThanOrEqual(pan.y + shown.h);
        expect(me.x).toBeGreaterThanOrEqual(pan.x);
        expect(me.x).toBeLessThanOrEqual(pan.x + shown.w);
      }
    }
  });
});

// OME-2117 CI (e2e/provider-shelf.e2e.ts, OME-1864): looking down to the front row's tags put Twitch's 1280×720 band
// under the back seats' tops. Where the seats fit whole, they stay whole; the front row's tags give way first.
describe("the seats stay whole while the band looks down (OME-1864)", () => {
  const SEAT_HIT_TOP = 22;
  test.each(PRESETS.flatMap((n) => SIDES.map((s) => [n, s] as const)))("%p from the %p: every seat's top in the band, for any band the seats fit", (name, side) => {
    setNorth(side === "north");
    const room = preset(name);
    const seats = seatPoints(room);
    if (seats.length === 0) return;
    const ys = seats.map((p) => p.y);
    const need = Math.max(...ys) + TAG_FOOT - (Math.min(...ys) - SEAT_HIT_TOP);
    for (let h = 200; h <= ROOM_VIEW.h; h += 4) {
      if (need > h) continue;
      const c = bandHome(seats, standingPoints(room), { w: ROOM_VIEW.w, h });
      expect(Math.min(...ys) - SEAT_HIT_TOP, `${String(h)} px band`).toBeGreaterThanOrEqual(c.y - h / 2);
    }
  });

  // CI again: the e2e viewer joins standing, and keeping me whole pulled the band back under the seats' tops.
  test.each(PRESETS.flatMap((n) => SIDES.map((s) => [n, s] as const)))("%p from the %p: standing on any floor cell, every seat's top still in the band", (name, side) => {
    setNorth(side === "north");
    const room = preset(name);
    const seats = seatPoints(room);
    if (seats.length === 0) return;
    const ys = seats.map((p) => p.y);
    const need = Math.max(...ys) + TAG_FOOT - (Math.min(...ys) - SEAT_HIT_TOP);
    for (let h = 200; h <= ROOM_VIEW.h; h += 4) {
      if (need > h) continue;
      for (let col = 0; col < FLOOR_CELLS; col++) {
        for (let row = 0; row < FLOOR_CELLS; row++) {
          const c = bandHome(seats, standingPoints(room), { w: ROOM_VIEW.w, h }, cellCenter(col, row));
          expect(Math.min(...ys) - SEAT_HIT_TOP, `${String(h)} px band, me at ${String(col)},${String(row)}`).toBeGreaterThanOrEqual(c.y - h / 2);
        }
      }
    }
  });
});
