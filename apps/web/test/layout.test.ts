import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { STAGE_H, STAGE_W, SYSLINE_RAIL, bubbleRect, roomLayout, stageToPage, tagRect, type Rect } from "../src/layout";

const SEATS = seatPoints(DEFAULT_LAYOUT);
const STANDING = standingPoints(DEFAULT_LAYOUT);

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

const WIDTHS: number[] = [];
for (let w = 360; w <= 1920; w += 8) WIDTHS.push(w);
WIDTHS.push(375, 390, 412, 1366, 1440, 1919.5);

describe("roomLayout: YouTube RMF player size", () => {
  test.each(WIDTHS)("the TV is at least 356×200 CSS px after scaling at width %p", (width) => {
    const { tv } = roomLayout(width);
    expect(tv.w).toBeGreaterThanOrEqual(356);
    expect(tv.h).toBeGreaterThanOrEqual(200);
  });

  test("the TV still meets the minimum when the container is narrower than it", () => {
    const { tv } = roomLayout(300);
    expect(tv.w).toBeGreaterThanOrEqual(356);
    expect(tv.h).toBeGreaterThanOrEqual(200);
  });

  test("the TV is 16:9 and grows on wide windows", () => {
    expect(roomLayout(360).tv).toMatchObject({ w: 356, h: 200 });
    const wide = roomLayout(1920).tv;
    expect(wide.w).toBeGreaterThan(356);
    expect(Math.abs(wide.w / wide.h - 16 / 9)).toBeLessThan(0.01);
  });
});

describe("roomLayout: nothing of ours over the player", () => {
  test.each(WIDTHS)("the control bar sits directly below the TV, never over it, at width %p", (width) => {
    const { tv, controls } = roomLayout(width);
    expect(intersects(controls, tv)).toBe(false);
    expect(controls.y).toBeGreaterThanOrEqual(tv.y + tv.h);
    expect(controls.y - (tv.y + tv.h)).toBeLessThanOrEqual(16);
    expect(controls.x).toBe(tv.x);
    expect(controls.w).toBe(tv.w);
    // Set (e) chrome at 1×: 8 px panel border + 4 px padding around a 20 px key, both sides.
    expect(controls.h).toBeGreaterThanOrEqual(44);
  });

  test.each(WIDTHS)("the stage never overlaps the TV or the control bar at width %p", (width) => {
    const { tv, controls, stage } = roomLayout(width);
    expect(intersects(stage, tv)).toBe(false);
    expect(intersects(stage, controls)).toBe(false);
  });

  const spots = [...SEATS.map((p, i) => ({ name: `seat ${String(i)}`, p })), ...STANDING.map((p, i) => ({ name: `standing ${String(i)}`, p }))];

  test.each([360, 412, 768, 1024, 1920])("no bubble or tag intersects the TV or control bar, for every seat and standing spot, at width %p", (width) => {
    const l = roomLayout(width);
    for (const { name, p } of spots) {
      for (const [kind, r] of [["bubble", bubbleRect(p)], ["tag", tagRect(p)]] as const) {
        const onPage = stageToPage(l, r);
        expect({ name, kind, overTv: intersects(onPage, l.tv) }).toEqual({ name, kind, overTv: false });
        expect({ name, kind, overControls: intersects(onPage, l.controls) }).toEqual({ name, kind, overControls: false });
        // Clipped by the stage, so it can't reach the TV even if the box estimate is off.
        expect({ name, kind, inStage: inside(onPage, l.stage) }).toEqual({ name, kind, inStage: true });
      }
    }
  });

  test("a back-row bubble sits above its seat and inside the stage", () => {
    const backRow = SEATS[0];
    expect(backRow).toBeDefined();
    if (backRow === undefined) return;
    const b = bubbleRect(backRow);
    expect(b.y + b.h).toBeLessThan(backRow.y);
    expect(b.y).toBeGreaterThanOrEqual(0);
  });

  test("the stage scales to fit and the block height covers it", () => {
    const l = roomLayout(480);
    expect(l.stage.w).toBeLessThanOrEqual(480);
    expect(l.height).toBe(l.stage.y + l.stage.h);
    expect(roomLayout(1920).scale).toBe(1);
  });
});

// The TV frame's ink (assets/ui/reference.css, OME-92): border-image-outset paints outside each box.
// Bezel 6/6/8/6 around the player, shelf 1/38/6/38 around the control bar; `.compact` drops the sides.
const outset = (r: Rect, top: number, side: number, bottom: number): Rect => ({ x: r.x - side, y: r.y - top, w: r.w + 2 * side, h: r.h + top + bottom });
const frameInk = (l: ReturnType<typeof roomLayout>): Rect => outset(l.tv, 6, l.compact.tv ? 0 : 6, 8);
const shelfInk = (l: ReturnType<typeof roomLayout>): Rect => outset(l.controls, 1, l.compact.controls ? 0 : 38, 6);

describe("roomLayout: TV frame", () => {
  test.each([
    [360, { tv: true, controls: true }],
    [600, { tv: false, controls: true }],
    [635, { tv: false, controls: true }],
    [636, { tv: false, controls: false }],
    [1920, { tv: false, controls: false }],
  ] as const)("at width %p the compact flags are %o", (width, compact) => {
    expect(roomLayout(width).compact).toEqual(compact);
  });

  test.each(WIDTHS)("the bezel and shelf ink stay inside the container, no horizontal scroll, at width %p", (width) => {
    const l = roomLayout(width);
    const box: Rect = { x: 0, y: 0, w: Math.floor(width), h: l.height };
    expect(inside(frameInk(l), box)).toBe(true);
    expect(inside(shelfInk(l), box)).toBe(true);
  });

  test.each(WIDTHS)("the frame never paints over the player, and the shelf stays above the stage, at width %p", (width) => {
    const l = roomLayout(width);
    // The bezel is a ring outside the player (no `fill`), so only the shelf could reach it.
    expect(intersects(shelfInk(l), l.tv)).toBe(false);
    // The bezel's bottom row and the shelf's 1 px top outset share the plum outline row (reference.css).
    expect(frameInk(l).y + frameInk(l).h).toBeLessThanOrEqual(l.controls.y + 1);
    expect(shelfInk(l).y + shelfInk(l).h).toBeLessThanOrEqual(l.stage.y);
  });
});

describe("SYSLINE_RAIL: the chat system-line caption rail", () => {
  test("sits inside the stage", () => {
    expect(inside(SYSLINE_RAIL, { x: 0, y: 0, w: STAGE_W, h: STAGE_H })).toBe(true);
  });

  test("never covers a seat, a standing spot or their name tags", () => {
    for (const p of [...SEATS, ...STANDING]) {
      expect(intersects(SYSLINE_RAIL, tagRect(p))).toBe(false);
      expect(intersects(SYSLINE_RAIL, { x: p.x - 32, y: p.y - 48, w: 64, h: 64 })).toBe(false);
    }
  });

  test.each(WIDTHS)("stays off the player and the control bar at width %p", (width) => {
    const l = roomLayout(width);
    const onPage = stageToPage(l, SYSLINE_RAIL);
    expect(intersects(onPage, l.tv)).toBe(false);
    expect(intersects(onPage, l.controls)).toBe(false);
  });
});

describe("roomLayout: Twitch's 400×300 minimum (research M2 §2.1, §6.4)", () => {
  test.each(WIDTHS)("with a Twitch embed the TV is at least 400×300 at width %p", (width) => {
    const { tv, controls } = roomLayout(width, "twitch");
    expect(tv.w).toBeGreaterThanOrEqual(400);
    expect(tv.h).toBeGreaterThanOrEqual(300);
    expect(Math.abs(tv.w / tv.h - 16 / 9)).toBeLessThan(0.01);
    expect(controls.w).toBe(tv.w);
  });

  test("at 360 px the Twitch TV is 534×300 (the page scrolls sideways); YouTube and Vimeo keep 356×200", () => {
    expect(roomLayout(360, "twitch").tv).toMatchObject({ w: 534, h: 300 });
    expect(roomLayout(360, "youtube").tv).toMatchObject({ w: 356, h: 200 });
    expect(roomLayout(360, "vimeo").tv).toMatchObject({ w: 356, h: 200 });
    expect(roomLayout(360).tv).toMatchObject({ w: 356, h: 200 });
  });

  test("wide windows are the same for every provider", () => {
    expect(roomLayout(1920, "twitch")).toEqual(roomLayout(1920, "youtube"));
  });
});
