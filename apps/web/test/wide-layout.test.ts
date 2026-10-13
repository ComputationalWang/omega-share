// The desktop wide layout (OME-642, M7 W7): at ≥ 1024 px wide and landscape the room page is two columns, the TV, its
// shelf and the room on the left and the chat (with Up next) on the right, full height, so nothing you need while
// watching is below the fold. The left column's geometry is `wideLayout`: it fits the TV, the shelf and the stage in
// the column's box (width and height) and keeps ADR 0012's player minimum. OME-1050 (board): the room fills what the
// shelf leaves, scaled up past 1× where the column has room, and is the larger part of the column at 16:9.
import { describe, expect, test } from "bun:test";
import { CONTROL_BAR_H, ROOM_VIEW, WIDE_CHAT_W, WIDE_QUERY, wideLayout, type Rect } from "../src/layout";

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

/** Left columns: 1024×600 (small laptop) up to 2560×1440. Heights are what's left under the room's title and status. */
const BOXES: readonly (readonly [number, number])[] = [
  [640, 520],
  [900, 600],
  [920, 640],
  [1200, 760],
  [1560, 960],
  [2200, 1320],
];

describe("wide breakpoint", () => {
  test("two columns from 1024 px wide, landscape only", () => {
    expect(WIDE_QUERY).toBe("(min-width: 1024px) and (orientation: landscape)");
  });
  test("the chat column is 320 px", () => {
    expect(WIDE_CHAT_W).toBe(320);
  });
});

describe("wideLayout", () => {
  test.each(BOXES)("at %p×%p the TV, shelf and stage all fit the column, none overlapping", (w, h) => {
    const l = wideLayout(w, h, "youtube");
    for (const r of [l.tv, l.controls, l.stage]) expect(inside(r, w, h)).toBe(true);
    expect(intersects(l.tv, l.controls)).toBe(false);
    expect(intersects(l.controls, l.stage)).toBe(false);
    expect(intersects(l.tv, l.stage)).toBe(false);
  });

  test.each(BOXES)("at %p×%p the player is 16:9 and at least ADR 0012's 356×200", (w, h) => {
    const { tv } = wideLayout(w, h, "youtube");
    expect(tv.w).toBeGreaterThanOrEqual(356);
    expect(tv.h).toBeGreaterThanOrEqual(200);
    expect(Math.abs(tv.w / tv.h - 16 / 9)).toBeLessThan(0.01);
  });

  test("Twitch keeps its 400×300 minimum (534×300 at 16:9)", () => {
    const { tv } = wideLayout(640, 520, "twitch");
    expect(tv.w).toBeGreaterThanOrEqual(534);
    expect(tv.h).toBeGreaterThanOrEqual(300);
  });

  test.each(BOXES)("at %p×%p the shelf is right under the picture, as wide, one bar tall", (w, h) => {
    const { tv, controls } = wideLayout(w, h, "youtube");
    expect(controls.y - (tv.y + tv.h)).toBeGreaterThanOrEqual(0);
    expect(controls.y - (tv.y + tv.h)).toBeLessThanOrEqual(8);
    expect(controls.h).toBe(CONTROL_BAR_H);
    expect(controls.x).toBe(tv.x);
    expect(controls.w).toBe(tv.w);
  });

  test.each(BOXES)("at %p×%p the room's view keeps its shape, fills the column's width or what the shelf leaves of its height, and is centred", (w, h) => {
    const { stage, scale } = wideLayout(w, h, "youtube");
    expect(Math.max(stage.w / w, stage.h / (h - stage.y))).toBeGreaterThan(0.99);
    expect(stage.w).toBeCloseTo(ROOM_VIEW.w * scale, 5);
    expect(stage.h).toBeCloseTo(ROOM_VIEW.h * scale, 5);
    expect(Math.abs(stage.x + stage.w / 2 - w / 2)).toBeLessThanOrEqual(1);
  });

  // OME-1050: the board's expected layout has the room zoomed in, its floor wider than the TV (the floor is 640 stage px).
  test("a 1280×720 window (left column ≈ 920×640) shows the room's floor at least as wide as the TV", () => {
    const { scale, tv } = wideLayout(920, 640, "youtube");
    expect(scale).toBeGreaterThanOrEqual(0.65);
    expect(640 * scale).toBeGreaterThanOrEqual(tv.w);
  });

  test("a 1920×1080 window (left column ≈ 1560×960) shows the room past 1×, wider than a TV still bigger than the stacked page's 560 px", () => {
    const { scale, tv } = wideLayout(1560, 960, "youtube");
    expect(tv.w).toBeGreaterThan(560);
    expect(scale).toBeGreaterThan(1);
    expect(640 * scale).toBeGreaterThan(tv.w);
  });

  test("a 2560×1440 window (left column ≈ 2200×1320) scales the room up past 1×", () => {
    expect(wideLayout(2200, 1320, "youtube").scale).toBeGreaterThan(1.2);
  });

  test("`height` is the column's content height (the stage's foot)", () => {
    const l = wideLayout(920, 640, "youtube");
    expect(l.height).toBe(l.stage.y + l.stage.h);
  });
});
