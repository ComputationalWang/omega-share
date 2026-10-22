import { describe, expect, test } from "bun:test";
import { MOMENTS_H, fullscreenLayout, momentsBox, roomLayout, wideLayout } from "../src/layout";

// QA OME-1715: the strip sat over the top of the player and spanned the whole stage. It belongs under the shelf, the
// player's width, in every layout that has room for it.
const under = (l: { tv: { x: number; w: number }; controls: { y: number; h: number } }, r: { x: number; y: number; w: number; h: number } | null): void => {
  expect(r).not.toBeNull();
  if (r === null) return;
  expect(r.y).toBeGreaterThanOrEqual(l.controls.y + l.controls.h);
  expect(r.x).toBe(l.tv.x);
  expect(r.w).toBe(l.tv.w);
  expect(r.h).toBe(MOMENTS_H);
};

describe("momentsBox: under the shelf, the player's width", () => {
  test("desktop page", () => {
    const l = roomLayout(912);
    under(l, momentsBox(l, l.height));
  });
  test("phone page", () => {
    const l = roomLayout(390, null, true);
    under(l, momentsBox(l, l.height));
  });
  test("wide layout", () => {
    const l = wideLayout(1000, 800, null);
    under(l, momentsBox(l, 800));
  });
  test("full screen, chat beside or popped out, where the picture leaves room under the shelf", () => {
    const side = fullscreenLayout(1280, 720, null, "open");
    expect(side.at).toBe("side");
    under(side, momentsBox(side, 720, side.at));
    const alone = fullscreenLayout(1280, 1000, null, "none");
    under(alone, momentsBox(alone, 1000, alone.at));
    // A picture that fills the height: its shelf ends at the screen's edge, nothing under it.
    const full = fullscreenLayout(1280, 720, null, "none");
    expect(momentsBox(full, 720, full.at)).toBeNull();
  });
  test("never where the chat is under the shelf, the shelf is gone, or it would leave the wrap", () => {
    const band = fullscreenLayout(1280, 720, null, "band");
    expect(momentsBox(band, 720, band.at)).toBeNull();
    const hidden = fullscreenLayout(1280, 720, null, "hidden");
    expect(momentsBox(hidden, 720, hidden.at)).toBeNull();
    const l = roomLayout(912);
    expect(momentsBox(l, l.controls.y + l.controls.h + 4)).toBeNull();
  });
});
