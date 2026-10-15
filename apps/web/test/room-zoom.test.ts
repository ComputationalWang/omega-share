// Pinch to zoom the phone's room window (OME-1184). The window shows the stage at a zoom from "the whole stage on
// screen" up to 2×; a pinch keeps the stage point under the fingers under the fingers; names and bubbles never shrink
// below a readable size however far out you zoom.
import { describe, expect, test } from "bun:test";
import { MAX_ZOOM, STAGE_H, STAGE_W, clampZoom, labelScale, minZoom, panTo, pinchView, readZoom } from "../src/layout";

const PHONE = { w: 390, h: 270 };

describe("zoom range", () => {
  test("the smallest zoom shows the whole stage in the window", () => {
    // 390 / 960 is the tighter fit: the stage's full width is on screen, and its full height too.
    expect(minZoom(PHONE)).toBeCloseTo(0.40625, 5);
    expect(STAGE_W * minZoom(PHONE)).toBeLessThanOrEqual(PHONE.w);
    expect(STAGE_H * minZoom(PHONE)).toBeLessThanOrEqual(PHONE.h);
    // A short, wide window fits the height.
    expect(minZoom({ w: 600, h: 150 })).toBe(0.25);
  });

  test("never above 1× at the small end, so a window bigger than the stage doesn't force a zoom in", () => {
    expect(minZoom({ w: 2000, h: 1200 })).toBe(1);
  });

  test("the largest zoom is 2×", () => {
    expect(MAX_ZOOM).toBe(2);
  });

  test("clampZoom keeps a zoom in range", () => {
    expect(clampZoom(5, PHONE)).toBe(2);
    expect(clampZoom(0.1, PHONE)).toBeCloseTo(0.40625, 5);
    expect(clampZoom(1.5, PHONE)).toBe(1.5);
    expect(clampZoom(Number.NaN, PHONE)).toBe(1);
  });
});

describe("panTo at a zoom", () => {
  test("zoomed in 2×, the window covers half as many stage px", () => {
    // 390×270 screen px at 2× is 195×135 stage px, centred on (480, 300).
    expect(panTo(PHONE, { x: 480, y: 300 }, 2)).toEqual({ x: 383, y: 233 });
  });

  test("zoomed out to fit, the window looks at the stage's top-left whatever the centre", () => {
    expect(panTo(PHONE, { x: 900, y: 500 }, minZoom(PHONE))).toEqual({ x: 0, y: 0 });
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
    expect(pinchView({ zoom: 1, at: { x: 0, y: 0 }, dist: 100 }, { dist: 1, mid: { x: 0, y: 0 } }, PHONE).zoom).toBeCloseTo(0.40625, 5);
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
