import { describe, expect, test } from "bun:test";
import type { PlaybackState } from "@omega/shared";
import { arrivalSpread, driftMs, spread, spreadVerdict, summarizeFrames, summarizeWindows, upperMedian } from "./spread";

const playing: PlaybackState = { playing: true, position: 10, rate: 1, at: 1_000_000, rev: 3, action: "play", by: null };
const paused: PlaybackState = { ...playing, playing: false, action: "pause" };

describe("driftMs: expected minus actual, ms", () => {
  test("playing: expected advances with server time since `at`", () => {
    expect(driftMs(playing, { t: 1_002_000, actual: 12 })).toBeCloseTo(0, 6);
    expect(driftMs(playing, { t: 1_002_000, actual: 11.75 })).toBeCloseTo(250, 6);
    expect(driftMs(playing, { t: 1_002_000, actual: 12.1 })).toBeCloseTo(-100, 6);
  });

  test("playing at another rate", () => {
    expect(driftMs({ ...playing, rate: 1.5 }, { t: 1_002_000, actual: 13 })).toBeCloseTo(0, 6);
  });

  test("paused: expected is the stored position whatever the time", () => {
    expect(driftMs(paused, { t: 9_999_999, actual: 9.6 })).toBeCloseTo(400, 6);
  });

  test("expected never goes below 0", () => {
    expect(driftMs({ ...playing, position: 0, at: 5_000 }, { t: 4_000, actual: 0 })).toBe(0);
  });
});

describe("spread: max − min of the drifts", () => {
  test("samples taken at different moments still compare fairly", () => {
    const r = spread(playing, [
      { t: 1_002_000, actual: 12 },
      { t: 1_002_050, actual: 12.05 },
      { t: 1_001_900, actual: 11.7 },
    ]);
    expect(r.drifts.map((d) => Math.round(d))).toEqual([0, 0, 200]);
    expect(r.spreadMs).toBeCloseTo(200, 6);
  });

  test("a common offset doesn't count; one straggler does", () => {
    const r = spread(paused, [
      { t: 1, actual: 9.9 },
      { t: 2, actual: 9.9 },
      { t: 3, actual: 9.3 },
    ]);
    expect(r.spreadMs).toBeCloseTo(600, 6);
  });

  test("needs at least two clients", () => {
    expect(() => spread(playing, [{ t: 1, actual: 1 }])).toThrow();
  });
});

describe("summarizeFrames: vsync p95 plus the raw numbers ADR 0009 asks for", () => {
  const V = 1000 / 60;

  test("clean 60 Hz: no flags", () => {
    const s = summarizeFrames(Array.from({ length: 100 }, (_, i) => V + (i % 2 === 0 ? 0.02 : -0.02)), V);
    expect(s.frames).toBe(100);
    expect(s.missed).toBe(0);
    expect(s.p95).toBeCloseTo(V, 6);
    expect(s.flags).toEqual([]);
  });

  test("raw p95 above 16.7 ms is flagged even when the vsync p95 passes", () => {
    const s = summarizeFrames(Array.from({ length: 100 }, () => 16.9), V);
    expect(s.p95).toBeCloseTo(V, 6);
    expect(s.rawP95).toBeCloseTo(16.9, 6);
    expect(s.flags).toEqual(["raw p95 16.90 ms > 16.7 ms"]);
  });

  test("more than 5% missed vsyncs is flagged", () => {
    const deltas = [...Array.from({ length: 94 }, () => V), ...Array.from({ length: 6 }, () => 2 * V)];
    const s = summarizeFrames(deltas, V);
    expect(s.missed).toBe(6);
    expect(s.missedPct).toBeCloseTo(6, 6);
    expect(s.flags).toContain("missed vsyncs 6.0% > 5%");
  });

  test("the note carries frames, missed, raw p95 and any flags", () => {
    const s = summarizeFrames(Array.from({ length: 10 }, () => V), V);
    expect(s.note).toBe("10 frames, 0 missed vsync (0.0%), raw p95 16.67 ms");
    const f = summarizeFrames(Array.from({ length: 10 }, () => 16.9), V);
    expect(f.note).toBe("10 frames, 0 missed vsync (0.0%), raw p95 16.90 ms; ⚠ raw p95 16.90 ms > 16.7 ms");
  });
});

describe("arrivalSpread: when a live pause/play reached each client (OME-131)", () => {
  test("spread is last minus first arrival; latency is last arrival minus the action", () => {
    const a = arrivalSpread(1_000, [1_040, 1_010, 1_130]);
    expect(a.spreadMs).toBe(120);
    expect(a.latencyMs).toBe(130);
  });

  test("an arrival before the action is a stale reading and throws", () => {
    expect(() => arrivalSpread(1_000, [1_020, 999])).toThrow("before the action");
  });

  test("needs at least two clients", () => {
    expect(() => arrivalSpread(1_000, [1_020])).toThrow("at least two");
  });
});

describe("upperMedian: the middle sample, the higher one of an even count (OME-846)", () => {
  test("odd count: the middle", () => {
    expect(upperMedian([3, 1, 2])).toBe(2);
  });

  test("even count: the higher middle, so one outlier per 4 never decides the row", () => {
    expect(upperMedian([100, 900, 120, 110])).toBe(120);
  });

  test("no samples throws", () => {
    expect(() => upperMedian([])).toThrow();
  });
});

describe("summarizeWindows: several rAF windows on one set-up room make one stable row (OME-846)", () => {
  const V = 1000 / 60;
  const clean = (n: number): number[] => Array.from({ length: n }, () => V);
  /** `n` frames, `missed` of them two vsyncs long. */
  const withMissed = (n: number, missed: number): number[] => Array.from({ length: n }, (_, i) => (i < missed ? 2 * V : V));

  test("missed vsyncs are pooled over every window, so one stray frame is worth a third as much", () => {
    // OME-818 evidence: 3 missed of 298 in one window was 1.007 %, a fail; pooled over 3 windows it is 1.0 % of 900.
    const s = summarizeWindows(
      [
        { samples: withMissed(300, 3), workMs: clean(300).map(() => 2) },
        { samples: withMissed(300, 0), workMs: clean(300).map(() => 2) },
        { samples: withMissed(300, 0), workMs: clean(300).map(() => 2) },
      ],
      V,
    );
    expect(s.windows).toBe(3);
    expect(s.frames).toBe(900);
    expect(s.missed).toBe(3);
    expect(s.missedPct).toBeCloseTo(100 / 300, 6);
  });

  test("frame p95 and work p95 are the median of the window p95s: one slow window doesn't decide them", () => {
    const slowFrames = withMissed(100, 10); // p95 two vsyncs
    const s = summarizeWindows(
      [
        { samples: clean(100), workMs: Array.from({ length: 100 }, () => 3) },
        { samples: slowFrames, workMs: Array.from({ length: 100 }, () => 9.7) },
        { samples: clean(100), workMs: Array.from({ length: 100 }, () => 4) },
      ],
      V,
    );
    expect(s.p95).toBeCloseTo(V, 6);
    expect(s.workP95).toBe(4);
    expect(s.windowP95s).toHaveLength(3);
    expect(s.windowWorkP95s).toEqual([3, 9.7, 4]);
  });

  test("notes print the sample counts and every window's number", () => {
    const s = summarizeWindows(
      [
        { samples: withMissed(300, 1), workMs: Array.from({ length: 290 }, () => 2) },
        { samples: withMissed(300, 2), workMs: Array.from({ length: 295 }, () => 3) },
      ],
      V,
    );
    expect(s.note).toContain("median of 2 windows");
    expect(s.note).toContain("600 frames");
    expect(s.workNote).toContain("median of 2 windows (2.00 / 3.00 ms)");
    expect(s.workNote).toContain("585 traced frames");
    expect(s.missedNote).toBe("3 of 600 frames over 2 windows (1 / 2)");
  });

  test("a flag from any window is kept", () => {
    const s = summarizeWindows(
      [
        { samples: clean(100), workMs: [1] },
        { samples: Array.from({ length: 100 }, () => 16.9), workMs: [1] },
      ],
      V,
    );
    expect(s.flags.some((f) => f.includes("raw p95"))).toBe(true);
  });

  test("no windows throws", () => {
    expect(() => summarizeWindows([], V)).toThrow();
  });
});

describe("spreadVerdict: sync spread over several rounds per action (OME-846)", () => {
  test("per action the upper median of its rounds; the row is the worst action", () => {
    const v = spreadVerdict({ pause: [40, 60, 50, 45], play: [120, 700, 110, 130], seek: [200, 210, 190, 220] });
    // play's one 700 ms outlier of 4 doesn't decide it (bimodal spreads, OME-818); seek's 210 is the worst median.
    expect(v.value).toBe(210);
    expect(v.samples).toBe(12);
    expect(v.max).toBe(700);
  });

  test("two slow rounds of 4 do decide it: a real regression still fails", () => {
    expect(spreadVerdict({ pause: [600, 40, 650, 50] }).value).toBe(600);
  });

  test("the note prints each action's median, its max, and the sample count", () => {
    const v = spreadVerdict({ pause: [40, 60, 50, 45], play: [120, 700, 110, 130] });
    expect(v.note).toBe("pause 50 (max 60) / play 130 (max 700) ms, upper median of 4 rounds per action, 8 samples");
  });

  test("an action with no rounds throws", () => {
    expect(() => spreadVerdict({ pause: [] })).toThrow();
  });
});
