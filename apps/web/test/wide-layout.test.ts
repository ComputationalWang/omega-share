// The desktop wide layout (OME-642, M7 W7): at ≥ 1024 px wide and landscape the room page is two columns, the TV, its
// shelf and the room on the left and the chat (with Up next) on the right, full height, so nothing you need while
// watching is below the fold. The left column's geometry is `wideLayout`: it fits the TV, the shelf and the stage in
// the column's box (width and height), never scales the room up, and keeps ADR 0012's player minimum.
import { describe, expect, test } from "bun:test";
import { CONTROL_BAR_H, STAGE_H, STAGE_W, WIDE_CHAT_W, WIDE_QUERY, wideLayout, type Rect } from "../src/layout";

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

  test.each(BOXES)("at %p×%p the stage keeps 960:600, is never scaled up, and is centred", (w, h) => {
    const { stage, scale } = wideLayout(w, h, "youtube");
    expect(scale).toBeLessThanOrEqual(1);
    expect(stage.w).toBeCloseTo(STAGE_W * scale, 5);
    expect(stage.h).toBeCloseTo(STAGE_H * scale, 5);
    expect(Math.abs(stage.x + stage.w / 2 - w / 2)).toBeLessThanOrEqual(1);
  });

  test("a 1280×720 window (left column ≈ 920×640) shows the room at about half size, not a sliver", () => {
    const { scale, tv } = wideLayout(920, 640, "youtube");
    expect(scale).toBeGreaterThanOrEqual(0.45);
    expect(tv.w).toBeGreaterThanOrEqual(420);
  });

  test("a 1920×1080 window (left column ≈ 1560×960) shows a bigger TV than the stacked page's 560 px", () => {
    expect(wideLayout(1560, 960, "youtube").tv.w).toBeGreaterThan(560);
  });

  test("`height` is the column's content height (the stage's foot)", () => {
    const l = wideLayout(920, 640, "youtube");
    expect(l.height).toBe(l.stage.y + l.stage.h);
  });
});
