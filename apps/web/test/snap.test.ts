import { describe, expect, test } from "bun:test";
import { polaroidLayout, snapFilename } from "../src/snap";

// OME-1565: /snap, a polaroid of the room canvas at 2× nearest-neighbour, downloaded locally.

describe("snapFilename", () => {
  test("omega-<local date>.png, zero-padded", () => {
    expect(snapFilename(new Date(2026, 9, 20, 23, 59))).toBe("omega-2026-10-20.png");
    expect(snapFilename(new Date(2027, 0, 5, 0, 0))).toBe("omega-2027-01-05.png");
  });
});

describe("polaroidLayout", () => {
  test("the photo is the canvas at 2×, inside an even border with a thicker bottom band", () => {
    expect(polaroidLayout(960, 600)).toEqual({
      width: 1968,
      height: 1320,
      photo: { x: 24, y: 24, w: 1920, h: 1200 },
      band: { y: 1224, h: 96 },
      title: { x: 24, y: 1262 },
      date: { x: 24, y: 1300 },
    });
  });

  test("a small canvas keeps the same border and band; the text sits inside the band", () => {
    const l = polaroidLayout(100, 50);
    expect(l.width).toBe(248);
    expect(l.height).toBe(220);
    expect(l.band.y).toBe(l.photo.y + l.photo.h);
    for (const y of [l.title.y, l.date.y]) {
      expect(y).toBeGreaterThan(l.band.y);
      expect(y).toBeLessThan(l.band.y + l.band.h);
    }
  });
});
