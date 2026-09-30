import { describe, expect, test } from "bun:test";
import { MAX_POSITION_S, type PlaybackState } from "@omega/shared";
import { applyControl, expectedPosition, loadPlayback } from "../src/playback";

const VIDEO = "dQw4w9WgXcQ";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const T0 = 1_700_000_000_000;

const loaded = (rev = 0): PlaybackState => loadPlayback(rev - 1, T0);

describe("loadPlayback", () => {
  test("a new embed starts playing at 0 with action load and no author", () => {
    expect(loadPlayback(-1, T0)).toEqual({ playing: true, position: 0, rate: 1, at: T0, rev: 0, action: "load", by: null });
  });

  test("rev keeps rising across embed changes", () => {
    expect(loadPlayback(7, T0).rev).toBe(8);
  });
});

describe("expectedPosition", () => {
  test("advances while playing", () => {
    expect(expectedPosition(loaded(), T0 + 2500)).toBe(2.5);
  });

  test("stays put while paused", () => {
    const paused: PlaybackState = { ...loaded(), playing: false, position: 30 };
    expect(expectedPosition(paused, T0 + 60_000)).toBe(30);
  });

  test("never runs past MAX_POSITION_S", () => {
    const nearEnd: PlaybackState = { ...loaded(), position: MAX_POSITION_S - 1 };
    expect(expectedPosition(nearEnd, T0 + 10_000)).toBe(MAX_POSITION_S);
  });

  test("never goes below 0 if the server clock steps back", () => {
    expect(expectedPosition(loaded(), T0 - 5000)).toBe(0);
  });
});

describe("applyControl", () => {
  test("pause at the extrapolated position is a pause by the sender", () => {
    const next = applyControl(loaded(), VIDEO, { videoId: VIDEO, playing: false, position: 10.4 }, ALICE, T0 + 10_000);
    expect(next).toEqual({ playing: false, position: 10.4, rate: 1, at: T0 + 10_000, rev: 1, action: "pause", by: ALICE });
  });

  test("play from a paused state within 1 s of where it stopped is a play", () => {
    const paused: PlaybackState = { ...loaded(3), playing: false, position: 42 };
    const next = applyControl(paused, VIDEO, { videoId: VIDEO, playing: true, position: 42.9 }, BOB, T0 + 60_000);
    expect(next?.action).toBe("play");
    expect(next?.rev).toBe(4);
  });

  test("a position more than 1 s from the extrapolated one is a seek, playing or not", () => {
    const playing = applyControl(loaded(), VIDEO, { videoId: VIDEO, playing: true, position: 120 }, ALICE, T0 + 10_000);
    expect(playing?.action).toBe("seek");
    const paused = applyControl(loaded(), VIDEO, { videoId: VIDEO, playing: false, position: 8.9 }, ALICE, T0 + 10_000);
    expect(paused?.action).toBe("seek");
  });

  test("last write wins: each accepted control replaces the state and bumps rev", () => {
    const a = applyControl(loaded(), VIDEO, { videoId: VIDEO, playing: false, position: 5 }, ALICE, T0 + 5000);
    if (a === null) throw new Error("rejected");
    const b = applyControl(a, VIDEO, { videoId: VIDEO, playing: true, position: 300 }, BOB, T0 + 5001);
    expect(b).toEqual({ playing: true, position: 300, rate: 1, at: T0 + 5001, rev: 2, action: "seek", by: BOB });
  });

  test("clamps the position into [0, MAX_POSITION_S]", () => {
    const hi = applyControl(loaded(), VIDEO, { videoId: VIDEO, playing: true, position: MAX_POSITION_S + 50 }, ALICE, T0);
    expect(hi?.position).toBe(MAX_POSITION_S);
    const lo = applyControl(loaded(), VIDEO, { videoId: VIDEO, playing: true, position: -3 }, ALICE, T0);
    expect(lo?.position).toBe(0);
  });

  test("a control for a video other than the current embed is rejected", () => {
    expect(applyControl(loaded(), VIDEO, { videoId: "aaaaaaaaaaa", playing: false, position: 0 }, ALICE, T0)).toBeNull();
  });

  test("a control with no embed is rejected", () => {
    expect(applyControl(null, null, { videoId: VIDEO, playing: false, position: 0 }, ALICE, T0)).toBeNull();
  });
});
