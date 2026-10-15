import { describe, expect, test } from "bun:test";
import { reached, type MediaSample } from "./providers";

const sample = (paused: boolean, ad: boolean): MediaSample => ({ t: 0, currentTime: 10, playbackRate: 1, paused, ad, overlay: "" });

describe("reached (arrival probe)", () => {
  test("a <video> in the asked state has arrived", () => {
    expect(reached(sample(true, false), true)).toBe(true);
    expect(reached(sample(false, false), false)).toBe(true);
    expect(reached(sample(false, false), true)).toBe(false);
    expect(reached(null, true)).toBe(false);
  });

  test("Twitch's mid-roll label over the same <video> doesn't hide its pause/play (OME-1134)", () => {
    // m3-twitch-gate on crystalst: "taking an ad break" showed from the shared pause on; the SDK paused/played both players.
    expect(reached(sample(true, true), true)).toBe(true);
    expect(reached(sample(false, true), false)).toBe(true);
  });
});
