// Room view (OME-2170, CEO decision C on the layout card): at 1280×800 a hero TV leaves the band too little height for
// readable avatars (~25 px). One click puts the TV at its ADR 0012 floor (356×200) with its shelf beside it, and gives
// the room the rest of the column, so avatars (41 to 47 px at 1×) are at least 40 px. The default stays video first.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { bandFit, cellCenter, setNorth, wideLayout, type Rect } from "../src/layout";

const PRESETS = ["bar", "cafe", "cinema", "classic", "dank-dungeon", "empty", "living", "lounge", "penthouse", "studio"] as const;
const preset = (name: string) => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../../../assets/presets/${name}.json`, import.meta.url), "utf8")));
/** 1280×800's left column as QA measured it on OME-2168 (the studio shot). */
const COLUMN = { w: 905, h: 655 };
/** The shortest avatar sprite at 1× (seated, assets/avatars). */
const AVATAR_H = 41;

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

afterEach(() => {
  setNorth(false);
});

describe("Room view at 1280×800 (OME-2170)", () => {
  test("the TV is at its 356×200 floor, the shelf beside it, nothing overlapping and all in the column", () => {
    const l = wideLayout(COLUMN.w, COLUMN.h, "youtube", 1, 1, true);
    expect(l.tv.w).toBe(356);
    expect(l.tv.h).toBe(200);
    expect(l.controls.x).toBeGreaterThanOrEqual(l.tv.x + l.tv.w);
    expect(l.controls.y + l.controls.h).toBeLessThanOrEqual(l.tv.y + l.tv.h);
    for (const r of [l.tv, l.controls, l.stage]) expect(inside(r, COLUMN.w, COLUMN.h)).toBe(true);
    expect(intersects(l.tv, l.stage)).toBe(false);
    expect(intersects(l.controls, l.stage)).toBe(false);
  });

  // OME-2195 (CEO decision B): the shelf sits flush beside the TV at its keys' width, not stretched to the far right.
  test.each([[COLUMN.w, 1], [1100, 1.25]] as const)("at %i px (zoom %d) the shelf hugs the TV and holds just its keys", (w, chrome) => {
    const l = wideLayout(w, COLUMN.h, "youtube", chrome, 1, true);
    expect(l.controls.x).toBe(l.tv.x + l.tv.w + 6 + 8 + 38);
    expect(l.controls.w).toBe(420 * chrome);
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

  test("Twitch keeps its 534×300 floor: its shelf goes under it where it can't sit beside", () => {
    const l = wideLayout(COLUMN.w, COLUMN.h, "twitch", 1, 1, true);
    expect(l.tv.w).toBe(534);
    expect(l.tv.h).toBe(300);
    for (const r of [l.tv, l.controls, l.stage]) expect(inside(r, COLUMN.w, COLUMN.h)).toBe(true);
    expect(intersects(l.tv, l.controls)).toBe(false);
    expect(intersects(l.controls, l.stage)).toBe(false);
  });

  test("with no video there's no hero to give way: the same room-first split", () => {
    expect(wideLayout(COLUMN.w, COLUMN.h, null, 1, 1, true)).toEqual(wideLayout(COLUMN.w, COLUMN.h, null));
  });
});
