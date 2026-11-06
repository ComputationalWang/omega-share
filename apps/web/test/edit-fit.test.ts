// OME-2264: the open editor shows the whole room on the desktop, as big as the room's column holds it.
import { describe, expect, test } from "bun:test";
import { ROOM_VIEW, editFit, wideLayout } from "../src/layout";

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

// OME-2283: the editor is the chat column's sheet, so the room's column is the watch layout's (888×652 at 1280×800,
// 1048×752 at 1440×900). Editing, the TV gives way so the stage holds the whole room as wide as the column allows: at
// 1440×900 the curtain's share left it 453 px of 532 and the room 817 px wide, narrower than at 1280×800 (888).
describe("wideLayout, editing", () => {
  test.each([[888, 652], [1048, 752]] as const)("%i×%i, nothing on: the stage holds the whole room at the column's width", (w, h) => {
    const l = wideLayout(w, h, null, 1, 1, false, true, true);
    expect(editFit(l.scale, l.stage.w, l.stage.h)).toBeCloseTo(Math.min(1, l.stage.w / ROOM_VIEW.w));
  });
  test.each([[888, 652], [1048, 752]] as const)("%i×%i, a video: the TV at its floor (ADR 0012: 356 px), the room gets the rest", (w, h) => {
    expect(wideLayout(w, h, "youtube", 1, 1, false, false, true).tv.w).toBe(356);
  });
  // QA OME-2297: Room view's corner TV left the editing room the width beside it (700×388 at 1920×1080, main 880×488).
  test.each([[888, 652], [1048, 752], [1608, 1032]] as const)("%i×%i, a video in Room view: laid out as with Room view off", (w, h) => {
    expect(wideLayout(w, h, "youtube", 1, 1, true, false, true)).toEqual(wideLayout(w, h, "youtube", 1, 1, false, false, true));
  });
});
