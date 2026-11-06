// OME-2264: the open editor shows the whole room on the desktop, as big as the room's column holds it.
import { describe, expect, test } from "bun:test";
import { ROOM_VIEW, editFit } from "../src/layout";

describe("editFit", () => {
  test("keeps the scale where the room fits whole", () => {
    expect(editFit(1, 960, 532)).toBe(1);
    expect(editFit(2, 1920, 1100)).toBe(2);
  });
  test("drops to a whole scale that fits before a fraction", () => {
    expect(editFit(2, 1500, 1100)).toBe(1);
  });
  test("fits the column's width or height below 1×, never under half", () => {
    expect(editFit(1, 576, 410)).toBeCloseTo(576 / ROOM_VIEW.w);
    expect(editFit(1, 900, 266)).toBeCloseTo(266 / ROOM_VIEW.h);
    expect(editFit(1, 300, 400)).toBe(0.5);
  });
});
