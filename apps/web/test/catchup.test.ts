import { describe, expect, test } from "bun:test";
import { CATCHUP_SHOW_MS, NOT_CATCHING, stepCatchup, type Catchup } from "../src/controls/catchup";
import type { PlayerState } from "../src/player/adapter";

const run = (steps: [now: number, state: PlayerState, roomPlaying: boolean][], from: Catchup = NOT_CATCHING): Catchup => {
  let c = from;
  for (const [now, playerState, roomPlaying] of steps) c = stepCatchup(c, { now, playerState, roomPlaying });
  return c;
};

describe("stepCatchup", () => {
  test("playing in step is not catching up", () => {
    expect(run([[0, "playing", true], [1000, "playing", true]]).catching).toBe(false);
  });

  test("buffering while the room plays shows after CATCHUP_SHOW_MS, not before", () => {
    expect(run([[0, "buffering", true], [CATCHUP_SHOW_MS - 1, "buffering", true]]).catching).toBe(false);
    expect(run([[0, "buffering", true], [CATCHUP_SHOW_MS, "buffering", true]]).catching).toBe(true);
  });

  test("an ad while the room plays is catching up too", () => {
    expect(run([[0, "ad", true], [CATCHUP_SHOW_MS, "ad", true]]).catching).toBe(true);
  });

  test("a short buffering blip never shows", () => {
    expect(run([[0, "buffering", true], [200, "playing", true], [CATCHUP_SHOW_MS + 100, "playing", true]]).catching).toBe(false);
  });

  test("a blip restarts the timer", () => {
    expect(run([[0, "buffering", true], [300, "playing", true], [400, "buffering", true], [400 + CATCHUP_SHOW_MS - 1, "buffering", true]]).catching).toBe(false);
  });

  test("back to playing clears it at once", () => {
    const shown = run([[0, "ad", true], [CATCHUP_SHOW_MS, "ad", true]]);
    expect(stepCatchup(shown, { now: CATCHUP_SHOW_MS + 1, playerState: "playing", roomPlaying: true }).catching).toBe(false);
  });

  test("when the room is paused, nobody is behind", () => {
    const shown = run([[0, "buffering", true], [CATCHUP_SHOW_MS, "buffering", true]]);
    expect(stepCatchup(shown, { now: CATCHUP_SHOW_MS + 1, playerState: "buffering", roomPlaying: false }).catching).toBe(false);
    expect(run([[0, "buffering", false], [5000, "buffering", false]]).catching).toBe(false);
  });

  test("unchanged input returns the same object (no allocation per tick)", () => {
    const a = run([[0, "buffering", true]]);
    expect(stepCatchup(a, { now: 10, playerState: "buffering", roomPlaying: true })).toBe(a);
    expect(stepCatchup(NOT_CATCHING, { now: 10, playerState: "playing", roomPlaying: true })).toBe(NOT_CATCHING);
  });
});
