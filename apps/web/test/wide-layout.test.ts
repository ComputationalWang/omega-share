// The desktop wide layout (OME-642, M7 W7): at ≥ 1024 px wide and landscape the room page is two columns, the TV, its
// shelf and the room on the left and the chat (with Up next) on the right, full height, so nothing you need while
// watching is below the fold. The left column's geometry is `wideLayout`: it fits the TV, the shelf and the stage in
// the column's box (width and height) and keeps ADR 0012's player minimum. OME-1050 (board): the room fills what the
// shelf leaves, scaled up past 1× where the column has room, and is the larger part of the column at 16:9.
import { describe, expect, test } from "bun:test";
import { CONTROL_BAR_H, ROOM_VIEW, WIDE_CHAT_W, WIDE_QUERY, chromeZoom, wideLayout, type Rect } from "../src/layout";

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
  test("two columns from 1024 px wide, landscape only, and on a short landscape screen past the phone layout (OME-1297)", () => {
    expect(WIDE_QUERY).toBe("(min-width: 1024px) and (orientation: landscape), (min-width: 601px) and (max-height: 500px) and (orientation: landscape)");
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
  // OME-1803: with a video loaded the TV is the hero (below); an empty room keeps this room-first split.
  test("an empty room in a 1280×720 window (left column ≈ 920×640) shows the room's floor at least as wide as the TV", () => {
    const { scale, tv } = wideLayout(920, 640, null);
    expect(scale).toBeGreaterThanOrEqual(0.65);
    expect(640 * scale).toBeGreaterThanOrEqual(tv.w);
  });

  test("an empty room in a 1920×1080 window (left column ≈ 1560×960) shows the room past 1×, wider than a TV still bigger than the stacked page's 560 px", () => {
    const { scale, tv } = wideLayout(1560, 960, null);
    expect(tv.w).toBeGreaterThan(560);
    expect(scale).toBeGreaterThan(1);
    expect(640 * scale).toBeGreaterThan(tv.w);
  });

  test("an empty room in a 2560×1440 window (left column ≈ 2200×1320) scales the room up past 1×", () => {
    expect(wideLayout(2200, 1320, null).scale).toBeGreaterThan(1.2);
  });

  test("`height` is the column's content height (the stage's foot)", () => {
    const l = wideLayout(920, 640, "youtube");
    expect(l.height).toBe(l.stage.y + l.stage.h);
  });
});

// OME-1803 (design OME-1799 §2): on a big monitor the TV was a small island, 25–30 % of the window's width. With a video
// loaded the TV is the hero: as large as leaves the room a band at least 240 px and 28 % of the column tall, and never
// smaller than the room-first split gave it. Columns are each window's left column as measured in the page (OME-1803 audit).
const HERO: readonly (readonly [number, number, number, number])[] = [
  // [window width, column width, column height, chrome zoom]
  [1440, 1096, 713, 1],
  [1920, 1416, 828, 1.5],
  [2560, 1896, 1118, 2],
];

describe("the TV as the hero (OME-1803)", () => {
  test.each(HERO)("a %p px window: the TV is at least 45 %% of it and as wide as its shelf; the band keeps 240 px and 28 %% of the column", (vw, w, h, z) => {
    for (const provider of ["youtube", "twitch"] as const) {
      const l = wideLayout(w, h, provider, z);
      expect(l.tv.w).toBeGreaterThanOrEqual(0.45 * vw);
      expect(l.tv.w).toBeGreaterThanOrEqual(l.controls.w);
      expect(h - l.stage.y).toBeGreaterThanOrEqual(Math.max(240, 0.28 * h) - 1);
      for (const r of [l.tv, l.controls, l.stage]) expect(inside(r, w, h)).toBe(true);
      expect(intersects(l.controls, l.stage)).toBe(false);
    }
  });

  test.each(BOXES)("at %p×%p a video's TV is never smaller than the room-first split's", (w, h) => {
    for (const z of [1, 1.5, 2]) expect(wideLayout(w, h, "youtube", z).tv.w).toBeGreaterThanOrEqual(wideLayout(w, h, null, z).tv.w);
  });
});

// OME-1667 (board): on a 2K screen the chrome was 1280's, floating in a big canvas. From 1920×900 it zooms 1.5×, from
// 2560×1200 2×, so every key is at least 40 px and the page looks like 1280×720's, only larger.
describe("chrome zoom (OME-1667)", () => {
  test("1× below 1920×900, 1.5× from there, 2× from 2560×1200", () => {
    for (const [w, h, z] of [[1280, 720, 1], [1919, 1080, 1], [1920, 899, 1], [1920, 900, 1.5], [1920, 1080, 1.5], [2559, 1440, 1.5], [2560, 1199, 1.5], [2560, 1200, 2], [2560, 1440, 2], [3840, 2160, 2]] as const) {
      expect(chromeZoom(w, h)).toBe(z);
    }
  });
  test("the shelf grows with the chrome and the stage still fits under it", () => {
    for (const z of [1.5, 2]) {
      const l = wideLayout(2200, 1320, null, z);
      expect(l.controls.h).toBe(CONTROL_BAR_H * z);
      expect(l.stage.y).toBeGreaterThanOrEqual(l.controls.y + l.controls.h);
      expect(inside(l.stage, 2200, 1320)).toBe(true);
      expect(intersects(l.stage, l.controls)).toBe(false);
    }
    expect(wideLayout(2200, 1320, null).controls.h).toBe(CONTROL_BAR_H);
  });
  // QA OME-1696: stepping the shelf down for a narrow TV (People open) put 27 px keys back at 1920×1080, and a Twitch VOD's
  // longer shelf left its seek bar 12 px wide. The shelf keeps the chrome's zoom and grows past a narrow TV instead,
  // centred under it: Twitch's never under 560 px (its 534 px 1280 shelf, with room for wider fonts), zoomed.
  test("the shelf keeps the chrome's zoom and is wide enough for its keys, centred under a narrow TV", () => {
    for (const [w, h, z] of [[2200, 1320, 2], [1300, 1000, 1.5], [1300, 760, 1.5], [1300, 600, 1.5], [1888, 1000, 2], [1408, 700, 1.5]] as const) {
      for (const [provider, min] of [[null, 420], ["twitch", 560]] as const) {
        const l = wideLayout(w, h, provider, z);
        expect(l.controls.h).toBe(CONTROL_BAR_H * z);
        expect(l.controls.w).toBeGreaterThanOrEqual(Math.min(min * z, w));
        expect(l.controls.w).toBeGreaterThanOrEqual(l.tv.w);
        expect(Math.abs(l.controls.x + l.controls.w / 2 - (l.tv.x + l.tv.w / 2))).toBeLessThanOrEqual(1);
        expect(inside(l.controls, w, h)).toBe(true);
      }
    }
  });
});
