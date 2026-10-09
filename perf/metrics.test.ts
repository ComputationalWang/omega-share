import { expect, test } from "bun:test";
import { appendRun, p95, vsyncFrames } from "./metrics";

test("p95 picks the nearest-rank sample", () => {
  expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  expect(p95([5])).toBe(5);
  expect(() => p95([])).toThrow();
});

test("vsyncFrames snaps rAF deltas to whole vsync intervals", () => {
  const vsync = 1000 / 60;
  // Timer jitter around one interval is a presented frame, not a slow one; a missed vsync is two intervals.
  expect(vsyncFrames([16.6, 16.7, 16.8, 17.3], vsync)).toEqual([vsync, vsync, vsync, vsync]);
  expect(vsyncFrames([33.3, 50.1], vsync)).toEqual([2 * vsync, 3 * vsync]);
  // Never below one interval, even for a coalesced early callback.
  expect(vsyncFrames([2], vsync)).toEqual([vsync]);
  expect(p95(vsyncFrames([...Array.from({ length: 19 }, () => 16.8), 33.4], vsync))).toBeCloseTo(vsync);
  expect(p95(vsyncFrames([...Array.from({ length: 18 }, () => 16.8), 33.4, 33.4], vsync))).toBeCloseTo(2 * vsync);
});

test("appendRun keeps every repeat of a row, in order, and the other rows as they were (OME-567)", () => {
  const first = appendRun({}, "emote.generic", { p95: 16.67 });
  expect(first).toEqual({ "emote.generic": [{ p95: 16.67 }] });
  const second = appendRun(first, "emote.generic", { p95: 33.33 });
  expect(second).toEqual({ "emote.generic": [{ p95: 16.67 }, { p95: 33.33 }] });
  expect(appendRun(second, "walk.generic", { p95: 16.67 })).toEqual({ "emote.generic": [{ p95: 16.67 }, { p95: 33.33 }], "walk.generic": [{ p95: 16.67 }] });
  // A file from before OME-567 holds one object per key: it becomes the first run.
  expect(appendRun({ "emote.vimeo": { p95: 16.67 } }, "emote.vimeo", { p95: 50 })).toEqual({ "emote.vimeo": [{ p95: 16.67 }, { p95: 50 }] });
  // Anything that isn't an object starts a fresh file.
  expect(appendRun(null, "k", { a: 1 })).toEqual({ k: [{ a: 1 }] });
  expect(appendRun([1, 2], "k", { a: 1 })).toEqual({ k: [{ a: 1 }] });
});
