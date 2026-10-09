import { describe, expect, test } from "bun:test";
import { CONTROL_BAR_H, STAGE_H, STAGE_W, fullscreenLayout, popRoomLayout, type Rect } from "../src/layout";

// OME-600 (M7 W3b, set k `ui-m7-popout`): the whole room on a second monitor. The room window holds the stage (at 1×
// where it fits, scaled down where it doesn't, never up) beside a chat column; the room tab keeps the picture, and in
// full screen shows it alone (no strip: the chat is in the window).

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, w: number, h: number): boolean => a.x >= 0 && a.y >= 0 && a.x + a.w <= w && a.y + a.h <= h;

describe("popRoomLayout: the room window", () => {
  test("set k 1280×668: the room at 1× beside a 300 px chat column, nothing overlapping", () => {
    const l = popRoomLayout(1280, 668);
    expect(l.scale).toBe(1);
    expect(l.chat).toEqual({ x: 980, y: 0, w: 300, h: 668 });
    expect(l.stage.w).toBe(STAGE_W);
    expect(l.stage.h).toBe(STAGE_H);
    expect(inside(l.stage, 980, 668)).toBe(true);
    expect(intersects(l.stage, l.chat)).toBe(false);
  });

  test("a big window never scales the room up; a small one scales it down to fit, keeping its shape", () => {
    expect(popRoomLayout(2560, 1400).scale).toBe(1);
    const small = popRoomLayout(900, 500);
    expect(small.scale).toBeCloseTo(Math.min((900 - 300) / STAGE_W, 500 / STAGE_H), 5);
    expect(small.stage.w / small.stage.h).toBeCloseTo(STAGE_W / STAGE_H, 2);
    expect(inside(small.stage, 600, 500)).toBe(true);
    expect(intersects(small.stage, small.chat)).toBe(false);
  });

  test("whole pixels, and never a negative size in a tiny window", () => {
    const l = popRoomLayout(301, 10);
    for (const r of [l.stage, l.chat]) {
      for (const n of [r.x, r.y, r.w, r.h]) {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    }
    expect(l.scale).toBeGreaterThan(0);
  });
});

describe("fullscreenLayout with the room popped out: the picture alone", () => {
  test("no strip; the picture is the largest 16:9 that leaves room for the shelf, centred", () => {
    const l = fullscreenLayout(1280, 720, "youtube", "none");
    expect(l.at).toBe("alone");
    expect(l.strip).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(l.tv.w / l.tv.h).toBeCloseTo(16 / 9, 2);
    expect(l.tv.h + CONTROL_BAR_H).toBeLessThanOrEqual(720);
    expect(l.tv.w).toBeGreaterThan(fullscreenLayout(1280, 720, "youtube", "open").tv.w);
    expect(Math.abs(l.tv.x + l.tv.w / 2 - 640)).toBeLessThanOrEqual(1);
    expect(intersects(l.tv, l.controls)).toBe(false);
    expect(inside(l.controls, 1280, 720)).toBe(true);
  });

  test("portrait too", () => {
    const l = fullscreenLayout(390, 844, "twitch", "none");
    expect(l.at).toBe("alone");
    expect(l.tv.w).toBeGreaterThanOrEqual(390);
    expect(intersects(l.tv, l.controls)).toBe(false);
  });
});
