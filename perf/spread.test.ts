import { describe, expect, test } from "bun:test";
import type { PlaybackState } from "@omega/shared";
import { driftMs, spread, summarizeFrames } from "./spread";

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
