// OME-2117 (design judge on OME-2116, QA OME-2107 finding 1): at 1280×800 the band was 240 px of the 532 px room, so the
// back wall and its art sat above it, and in a swap room my own avatar stood under its foot. The band holds at least half
// the room, it looks as high as keeps the audience whole (the back wall gets every row left over), and it keeps me whole
// wherever I stand, from either side of the room. The TV stays the hero (OME-1803).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { FLOOR_CELLS, RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { AVATAR_TOP, BAND_WALL_TOP, FLOOR_FOOT, ROOM_VIEW, TAG_FOOT, TAG_OFFSET_Y, bandFit, bandHome, cellCenter, setNorth, wheelView, wideLayout, type Point } from "../src/layout";

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

// OME-2148 (design judge round 2 on OME-2122, QA OME-2146 finding 1): at 1× the 266 px band can't hold the back wall's
// art and the audience (377 to 442 stage px), so the cinema's empty standing spots by the door put the back row's heads
// under the TV. The band fits the room instead: the largest whole scale that holds the back wall's art to the lowest
// name tag (and mine), else the fraction that does.
describe("1280×800 with a video: the room fits the band (OME-2148)", () => {
  /** The band's view as room-layout.ts opens it: fitted, its box no wider than the room at that fit, centred on bandHome. */
  function fittedView(name: string, me: Point | null) {
    const l = wideLayout(COLUMN.w, COLUMN.h, "youtube");
    const room = preset(name);
    const fit = bandFit(l.scale, l.stage.h, [...seatPoints(room), ...standingPoints(room)], me);
    const box = { w: Math.min(l.stage.w, ROOM_VIEW.w * fit), h: l.stage.h };
    const shown = { w: box.w / fit, h: box.h / fit };
    const c = bandHome(seatPoints(room), standingPoints(room), shown, me);
    const view = wheelView(fit, { zoom: 1, pan: { x: c.x - shown.w / 2, y: c.y - shown.h / 2 } }, { x: 0, y: 0 }, 1, box);
    return { room, fit, pan: view.pan, shown };
  }

  test.each(PRESETS.flatMap((p) => SIDES.map((s) => [p, s] as const)))("%s from the %s: the back wall's art, every seated head and every name tag, and me wherever I stand", (name, side) => {
    setNorth(side === "north");
    for (const me of [null, ...Array.from({ length: FLOOR_CELLS * FLOOR_CELLS }, (_, i) => cellCenter(i % FLOOR_CELLS, Math.floor(i / FLOOR_CELLS)))]) {
      const { room, fit, pan, shown } = fittedView(name, me);
      const at = me === null ? "seated" : `me at ${String(me.x)},${String(me.y)}`;
      expect(fit, at).toBeLessThanOrEqual(1);
      expect(fit, at).toBeGreaterThanOrEqual(0.5);
      expect(pan.y, at).toBeLessThanOrEqual(BAND_WALL_TOP);
      for (const p of [...seatPoints(room), ...standingPoints(room), ...(me === null ? [] : [me])]) {
        expect(p.y - AVATAR_TOP, at).toBeGreaterThanOrEqual(pan.y);
        expect(p.y + TAG_FOOT, at).toBeLessThanOrEqual(pan.y + shown.h);
        expect(p.x, at).toBeGreaterThanOrEqual(pan.x);
        expect(p.x, at).toBeLessThanOrEqual(pan.x + shown.w);
      }
    }
  });

  // penthouse-desktop-north, studio-desktop-north (OME-2170, QA OME-2168 § 8 item 1): from the north the lowest name tag
  // sits above the floor's front corner, so fitting to the tags cut the front rows' furniture (the studio's bookshelf).
  test.each(PRESETS.flatMap((p) => SIDES.map((s) => [p, s] as const)))("%s from the %s: the floor's front corner shows too", (name, side) => {
    setNorth(side === "north");
    for (const me of [null, cellCenter(0, 0), cellCenter(9, 9)]) {
      const { pan, shown } = fittedView(name, me);
      expect(pan.y).toBeLessThanOrEqual(BAND_WALL_TOP);
      expect(pan.y + shown.h).toBeGreaterThanOrEqual(FLOOR_FOOT);
    }
  });

  test("the wall's art is the tallest wall art's top, the floor's front corner the room's foot", () => {
    expect(BAND_WALL_TOP).toBe(113);
    expect(FLOOR_FOOT).toBe(540);
  });

  test("a band that holds it all keeps its whole scale, 2× included; the fraction is only for a band 1× can't fill", () => {
    const audience = [cellCenter(9, 9)];
    // The back wall's art (y 113) to the front cell's name tag foot (524 + 30) is 442 stage px.
    expect(bandFit(1, 442, audience, null)).toBe(1);
    expect(bandFit(2, 884, audience, null)).toBe(2);
    expect(bandFit(2, 600, audience, null)).toBe(1);
    expect(bandFit(1, 221, audience, null)).toBe(0.5);
    // Never under half: a band that short keeps the seats whole as before (OME-1864), at half size.
    expect(bandFit(1, 150, audience, null)).toBe(0.5);
    // No audience yet (the layout hasn't come): the whole scale.
    expect(bandFit(1, 266, [], null)).toBe(1);
  });
});

describe("a band fitted below 1× keeps its seats clickable (room.css, OME-2148)", () => {
  test("a seat grows back to a 24 px target (WCAG 2.5.8) at any fit down to half size", async () => {
    const css = await Bun.file(new URL("../src/room.css", import.meta.url)).text();
    const rule = /\.stage-clip\.is-fit \.seat \{ scale: max\(1, calc\(([\d.]+) \/ var\(--stage-scale\)\)\); \}/.exec(css);
    expect(rule).not.toBeNull();
    // The seat's diamond is 52×26 at 1×; on screen it is 26 × fit × scale tall.
    const k = Number(rule?.[1]);
    for (const fit of [0.5, 0.6, 0.75, 0.9, 0.99]) expect(26 * fit * Math.max(1, k / fit)).toBeGreaterThanOrEqual(24);
  });
});
