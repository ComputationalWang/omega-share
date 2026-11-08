// OME-2406 (judge round 15): a phone held sideways with a video on (915×412, a ~611×370 column) had its TV at the ADR 0012
// floor and its shelf under it, so the room window under them was 112 px. `touchSideLayout` puts the TV and shelf on the
// left and the room window beside them, the column's height.
import { describe, expect, test } from "bun:test";
import { CONTROL_BAR_H, touchSideLayout, type Rect } from "../src/layout";

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("touchSideLayout", () => {
  test("611×370 with YouTube: the TV at its floor top-left, the shelf under it, the room beside them the column's height", () => {
    const l = touchSideLayout(611, 370, "youtube");
    if (l === null) throw new Error("no layout");
    expect(l.tv.w).toBe(356);
    expect(l.tv.h).toBe(200);
    expect(l.controls).toEqual({ x: l.tv.x, y: l.tv.y + l.tv.h + 8, w: l.tv.w, h: CONTROL_BAR_H });
    expect(l.stage.y).toBe(0);
    expect(l.stage.h).toBe(370);
    expect(l.stage.x + l.stage.w).toBe(611);
    expect(l.stage.w).toBeGreaterThanOrEqual(200);
    for (const r of [l.tv, l.controls]) expect(intersects(r, l.stage)).toBe(false);
    expect(l.scale).toBe(1);
  });
  test("no room for a 200 px wide room beside the TV: null (844×390's column, and Twitch's wider TV)", () => {
    expect(touchSideLayout(524, 340, "youtube")).toBeNull();
    expect(touchSideLayout(611, 370, "twitch")).toBeNull();
  });
  test("a column too short for the TV and its shelf: null", () => {
    expect(touchSideLayout(611, 240, "youtube")).toBeNull();
  });
});
