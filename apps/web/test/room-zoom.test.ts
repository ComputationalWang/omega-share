// Pinch to zoom the phone's room window (OME-1184). The window shows the stage at a zoom from "the whole stage on
// screen" up to 2×; a pinch keeps the stage point under the fingers under the fingers; names and bubbles never shrink
// below a readable size however far out you zoom.
import { describe, expect, test } from "bun:test";
import { MAX_ZOOM, ROOM_VIEW, ROOM_WALLS, TAG_H, clampZoom, labelScale, minZoom, panTo, pinchView, readZoom, tagScale, wheelView } from "../src/layout";
import { EMOTE_LIFT } from "../src/walk/animator";

const PHONE = { w: 390, h: 270 };

describe("zoom range", () => {
  // OME-2148: fitting the 960 px stage left a 412 px phone's room at 60 % of its width; the walls are 660 px of it.
  test("the smallest zoom shows the room's walls whole in the window, not the empty stage around them", () => {
    // 270 / 532 is the tighter fit here: the walls' full height is on screen, and their full width too.
    expect(minZoom(PHONE)).toBeCloseTo(270 / 532, 5);
    expect(ROOM_WALLS.w * minZoom(PHONE)).toBeLessThanOrEqual(PHONE.w + 1e-9);
    expect(ROOM_WALLS.h * minZoom(PHONE)).toBeLessThanOrEqual(PHONE.h + 1e-9);
    // QA's Pixel 7 window (OME-2146, 412×915: 360×280 beside the keys): the room takes at least 95 % of its width.
    expect(ROOM_WALLS.w * minZoom({ w: 360, h: 280 })).toBeGreaterThanOrEqual(0.95 * 360);
    // A short, wide window fits the height.
    expect(minZoom({ w: 600, h: 133 })).toBe(0.25);
  });

  test("never above 1× at the small end, so a window bigger than the stage doesn't force a zoom in", () => {
    expect(minZoom({ w: 2000, h: 1200 })).toBe(1);
  });

  test("the largest zoom is 2×", () => {
    expect(MAX_ZOOM).toBe(2);
  });

  test("clampZoom keeps a zoom in range", () => {
    expect(clampZoom(5, PHONE)).toBe(2);
    expect(clampZoom(0.1, PHONE)).toBeCloseTo(270 / 532, 5);
    expect(clampZoom(1.5, PHONE)).toBe(1.5);
    expect(clampZoom(Number.NaN, PHONE)).toBe(1);
  });
});

describe("panTo at a zoom", () => {
  test("zoomed in 2×, the window covers half as many stage px", () => {
    // 390×270 screen px at 2× is 195×135 stage px, centred on (480, 300).
    expect(panTo(PHONE, { x: 480, y: 300 }, 2)).toEqual({ x: 383, y: 233 });
  });

  test("zoomed out to fit, the window shows the room's walls whole, centred, whatever the centre", () => {
    for (const c of [{ x: 900, y: 500 }, { x: 0, y: 0 }, { x: 480, y: 300 }]) {
      const z = minZoom(PHONE);
      const p = panTo(PHONE, c, z);
      expect(p.x).toBeLessThanOrEqual(ROOM_WALLS.x);
      expect(p.x + PHONE.w / z).toBeGreaterThanOrEqual(ROOM_WALLS.x + ROOM_WALLS.w - 1e-9);
      expect(p.y).toBeLessThanOrEqual(ROOM_WALLS.y);
      expect(p.y + PHONE.h / z).toBeGreaterThanOrEqual(ROOM_WALLS.y + ROOM_WALLS.h - 1e-9);
      expect(Math.abs(p.x + PHONE.w / z / 2 - 480)).toBeLessThanOrEqual(1);
    }
  });

  test("at 1× it's the window it always was", () => {
    expect(panTo(PHONE, { x: 480, y: 350 }, 1)).toEqual(panTo(PHONE, { x: 480, y: 350 }));
  });
});

describe("pinchView: the stage point under the fingers stays under them", () => {
  test("spreading the fingers to twice their distance doubles the zoom around the pinch point", () => {
    // At 1×, the fingers' midpoint is 100 px into the window, over stage point (400, 300).
    const v = pinchView({ zoom: 1, at: { x: 400, y: 300 }, dist: 100 }, { dist: 200, mid: { x: 100, y: 135 } }, PHONE);
    expect(v.zoom).toBe(2);
    // At 2× the window's left edge is 100 / 2 = 50 stage px left of (400, 300): its centre is 350 + 195 / 2.
    expect(v.centre.x).toBeCloseTo(447.5, 5);
    expect(v.centre.y).toBeCloseTo(300 - 135 / 2 + 135 / 2, 5);
  });

  test("the zoom stops at its range however far the fingers go", () => {
    expect(pinchView({ zoom: 1, at: { x: 0, y: 0 }, dist: 100 }, { dist: 1000, mid: { x: 0, y: 0 } }, PHONE).zoom).toBe(2);
    expect(pinchView({ zoom: 1, at: { x: 0, y: 0 }, dist: 100 }, { dist: 1, mid: { x: 0, y: 0 } }, PHONE).zoom).toBeCloseTo(270 / 532, 5);
  });

  test("moving both fingers together pans with them", () => {
    const v = pinchView({ zoom: 1, at: { x: 400, y: 300 }, dist: 100 }, { dist: 100, mid: { x: 150, y: 135 } }, PHONE);
    expect(v.zoom).toBe(1);
    // The point under the fingers moved 50 px right on screen, so the window looks 50 stage px further left.
    expect(v.centre.x).toBeCloseTo(400 - 150 + 195, 5);
  });
});

describe("labelScale: names and bubbles stay readable", () => {
  test("at 1× and above they scale with the stage", () => {
    expect(labelScale(1)).toBe(1);
    expect(labelScale(2)).toBe(1);
  });

  test("zoomed out, they're counter-scaled so they never drop below 0.85× on screen", () => {
    expect(labelScale(0.5) * 0.5).toBeCloseTo(0.85, 5);
    expect(labelScale(0.40625) * 0.40625).toBeCloseTo(0.85, 5);
    expect(labelScale(0.9)).toBe(1);
  });
});

describe("readZoom: the stored zoom is untrusted", () => {
  test("a positive finite number reads back", () => {
    expect(readZoom("1.5")).toBe(1.5);
  });

  test("anything else reads as no zoom", () => {
    for (const s of [null, "", "abc", "-1", "0", "Infinity", "NaN", "1e400"]) expect(readZoom(s)).toBeNull();
  });
});

// OME-1490: on a computer the wheel zooms the fitted room, from the whole room (1×) to MAX_ZOOM× that, around the pointer.
describe("wheelView: the stage point under the pointer stays under it", () => {
  /** The room fitted at half size: its box is 480×266 px, showing ROOM_VIEW from (0, 60). */
  const FIT = 0.5;
  const HOME = { zoom: 1, pan: { x: ROOM_VIEW.x, y: ROOM_VIEW.y } };
  const under = (v: { zoom: number; pan: { x: number; y: number } }, at: { x: number; y: number }) => ({ x: v.pan.x + at.x / (FIT * v.zoom), y: v.pan.y + at.y / (FIT * v.zoom) });

  test("zooming in 2× in the middle of the room keeps the middle under the pointer", () => {
    const at = { x: 240, y: 133 };
    const v = wheelView(FIT, HOME, at, 2);
    expect(v.zoom).toBe(2);
    expect(v.pan).toEqual({ x: 240, y: 193 });
    expect(under(v, at)).toEqual(under(HOME, at));
  });

  test("off-centre, and again from a zoomed view", () => {
    const at = { x: 100, y: 50 };
    const a = wheelView(FIT, HOME, at, 1.25);
    expect(under(a, at).x).toBeCloseTo(under(HOME, at).x, 9);
    expect(under(a, at).y).toBeCloseTo(under(HOME, at).y, 9);
    const at2 = { x: 400, y: 200 };
    const b = wheelView(FIT, a, at2, 1.6);
    expect(under(b, at2).x).toBeCloseTo(under(a, at2).x, 9);
    expect(under(b, at2).y).toBeCloseTo(under(a, at2).y, 9);
  });

  test("the zoom stays between the whole room and MAX_ZOOM× it", () => {
    expect(wheelView(FIT, HOME, { x: 0, y: 0 }, 9).zoom).toBe(MAX_ZOOM);
    expect(wheelView(FIT, HOME, { x: 0, y: 0 }, 0.2).zoom).toBe(1);
    expect(wheelView(FIT, HOME, { x: 0, y: 0 }, Number.NaN).zoom).toBe(1);
  });

  test("the view never leaves the room: its edges are clamped to ROOM_VIEW", () => {
    // Zoomed in at the room's bottom-right corner: the view's bottom-right is the room's.
    const v = wheelView(FIT, HOME, { x: 480, y: 266 }, 2);
    expect(v.pan.x + ROOM_VIEW.w / 2).toBeCloseTo(ROOM_VIEW.x + ROOM_VIEW.w, 9);
    expect(v.pan.y + ROOM_VIEW.h / 2).toBeCloseTo(ROOM_VIEW.y + ROOM_VIEW.h, 9);
    // A view pushed past the top-left comes back inside.
    expect(wheelView(FIT, { zoom: 2, pan: { x: -500, y: -500 } }, { x: 0, y: 0 }, 2).pan).toEqual({ x: ROOM_VIEW.x, y: ROOM_VIEW.y });
    // Back at 1× it's the whole room, wherever the pointer is.
    expect(wheelView(FIT, v, { x: 37, y: 211 }, 1).pan).toEqual({ x: ROOM_VIEW.x, y: ROOM_VIEW.y });
  });
});

// OME-1811: at an integer scale the room can be bigger than its band (1× in a 1280 window's 936×420): the view is the
// band's box, not the whole room, and it still never leaves ROOM_VIEW.
describe("wheelView in a band smaller than the room", () => {
  const BAND = { w: 900, h: 300 };
  test("the view is clamped inside ROOM_VIEW at the band's size", () => {
    expect(wheelView(1, { zoom: 1, pan: { x: -100, y: 0 } }, { x: 0, y: 0 }, 1, BAND).pan).toEqual({ x: ROOM_VIEW.x, y: ROOM_VIEW.y });
    expect(wheelView(1, { zoom: 1, pan: { x: 500, y: 500 } }, { x: 0, y: 0 }, 1, BAND).pan).toEqual({ x: ROOM_VIEW.x + ROOM_VIEW.w - BAND.w, y: ROOM_VIEW.y + ROOM_VIEW.h - BAND.h });
    const z = wheelView(2, { zoom: 1, pan: { x: 900, y: 900 } }, { x: 0, y: 0 }, 1, BAND);
    expect(z.pan).toEqual({ x: ROOM_VIEW.x + ROOM_VIEW.w - BAND.w / 2, y: ROOM_VIEW.y + ROOM_VIEW.h - BAND.h / 2 });
  });
  test("the stage point under the pointer still stays under it", () => {
    const from = { zoom: 1, pan: { x: 30, y: 150 } };
    const at = { x: 450, y: 150 };
    const v = wheelView(1, from, at, 1.5, BAND);
    expect(v.pan.x + at.x / 1.5).toBeCloseTo(from.pan.x + at.x, 9);
    expect(v.pan.y + at.y / 1.5).toBeCloseTo(from.pan.y + at.y, 9);
  });
});

// OME-2149 (design judge on OME-2122): on the phone, fitted, the name tags were as big as the avatars.
describe("tagScale: a tag never outgrows an avatar", () => {
  test("shown, a tag is never taller than a seated avatar, at any zoom down to a 320×180 window's fit", () => {
    for (let z = minZoom({ w: 320, h: 180 }); z <= MAX_ZOOM; z += 0.01) {
      expect(TAG_H * tagScale(z)).toBeLessThanOrEqual(EMOTE_LIFT.sit);
      expect(tagScale(z)).toBeLessThanOrEqual(labelScale(z));
    }
  });

  test("where that fits, a tag is as readable as any label", () => {
    expect(tagScale(0.5)).toBe(labelScale(0.5));
    expect(tagScale(1)).toBe(1);
  });
});
