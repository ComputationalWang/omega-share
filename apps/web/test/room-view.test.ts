// Room view (OME-2170, CEO decision C on the layout card): at 1280×800 a hero TV leaves the band too little height for
// readable avatars (~25 px). One click puts the TV at its ADR 0012 floor (356×200) with its shelf beside it, and gives
// the room the rest of the column, so avatars (41 to 47 px at 1×) are at least 40 px. The default stays video first.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { ROOM_HEAD, bandFit, bandHome, cellCenter, setNorth, wheelView, wideLayout, type Rect } from "../src/layout";

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
    expect(intersects(l.controls, l.stage)).toBe(false);
  });

  // OME-2233 (judge round 5, OME-2061 requests 1 and 2): the shelf sat at the TV's foot, leaving an empty strip above it
  // right of the TV, and the band started under both, so the walls' tops were cut. The walls are a ^ (corner at stage
  // (480, 60), left end at (160, 220)): the TV fits in the free corner above the left wall, and the room gets the column.
  // 905×655: QA OME-2168's column; 888×618: the real one with the reaction bar and footer (ADR 0060 amendment 3).
  // OME-2241 (judge round 6): the walls' art reaches the stage's top (the corner cap, y 0), so from ROOM_VIEW's top (60)
  // they were cut flat; and the box sank to the column's foot, leaving a 100 px empty band under the shelf. `sky`: what of
  // the 8 px over the corner the column holds (888×618, QA OME-2168's column with Report room on the bar's row: 5).
  test.each([[905, 655, 8], [888, 618, 5], [1400, 900, 8]] as const)("at %i×%i the shelf tops the TV's side and the whole room shows right under it, walls whole", (w, h, sky) => {
    const l = wideLayout(w, h, "youtube", 1, 1, true);
    // No strip between the TV's top and the shelf.
    expect(l.controls.y).toBe(l.tv.y);
    expect(l.stage.y).toBeGreaterThanOrEqual(l.controls.y + l.controls.h);
    expect(inside(l.stage, w, h)).toBe(true);
    // The walls' tops with the sky over them (stage y 0 - sky) to the lowest name tag the floor can hold (stage y 555), at 1×.
    expect(l.scale).toBe(1);
    expect(l.stage.h).toBe(555 + sky);
    // The box shows the walls' ends (stage x 150 to 810), centred on the corner (bandHome's x).
    const left = 480 - l.stage.w / 2;
    expect(left).toBeLessThanOrEqual(150);
    expect(left + l.stage.w).toBeGreaterThanOrEqual(810);
    // No dead band over the room: the walls' corner (`sky` under the box's top) is at most 60 px under the shelf.
    expect(l.stage.y + sky - (l.controls.y + l.controls.h)).toBeLessThanOrEqual(60);
    // The TV clears the left wall where the column lets the room go right, else the walls' right end is at its edge
    // (the player over the left wall's top is by design, ADR 0058).
    const frameRight = l.tv.x + l.tv.w + 6;
    const wallTop = l.stage.y + sky + (l.stage.x + l.stage.w / 2 - frameRight) / 2;
    expect(wallTop >= l.tv.y + l.tv.h + 6 || l.stage.x + l.stage.w / 2 + 330 >= w - 1).toBe(true);
  });

  test("a band that holds the whole room shows it from the walls' tops (stage y 60)", () => {
    const room = preset("living");
    // From the walls' tops (60) to the floor's front corner 8 px clear (548, OME-2282).
    const c = bandHome(seatPoints(room), standingPoints(room), { w: 700, h: 488 });
    expect(c.y - 488 / 2).toBe(60);
    expect(c.x).toBe(480);
  });

  // QA OME-2239: a seated visitor's tag on the front row reached past the floor's front corner, the box (sized to the
  // corner) no longer held walls' tops to that tag, and the camera fell back to the old framing: 34 px of wall cut.
  // OME-2241: from the stage's top (y 0, the walls' corner cap), with the sky over it the box holds.
  test.each([[888, 618, -5], [905, 655, -8]] as const)("at %i×%i the walls' tops show with anyone on the front corner cell", (w, h, from) => {
    const l = wideLayout(w, h, "youtube", 1, 1, true);
    const room = preset("penthouse");
    const c = bandHome(seatPoints(room), standingPoints(room), { w: l.stage.w, h: l.stage.h }, cellCenter(9, 9));
    expect(c.y - l.stage.h / 2).toBe(from);
    // The view's clamp lets it look there.
    const v = wheelView(1, { zoom: 1, pan: { x: c.x - l.stage.w / 2, y: c.y - l.stage.h / 2 } }, { x: 0, y: 0 }, 1, { ...l.stage, head: ROOM_HEAD });
    expect(v.pan.y).toBe(from);
    // Without the headroom (the phone, an empty room's box) the view stops at the walls' tops as before.
    expect(wheelView(1, v, { x: 0, y: 0 }, 1, l.stage).pan.y).toBe(60);
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
