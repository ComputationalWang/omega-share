import { describe, expect, test } from "bun:test";
import { reached, stallWatch, type MediaSample } from "./providers";

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

describe("stallWatch (room player kick, OME-2057/OME-2364)", () => {
  const at = (paused: boolean, currentTime: number) => ({ paused, currentTime });

  test("paused for 20 s from the start → one 'paused' kick", () => {
    const w = stallWatch(0);
    expect(w(at(true, 0), 10_000)).toBeNull();
    expect(w(at(true, 0), 20_500)).toBe("paused");
    expect(w(at(true, 0), 30_000)).toBeNull();
  });

  test("'playing' at a frozen currentTime for 20 s → one 'stalled' kick; then a pause gets its own kick", () => {
    const w = stallWatch(0);
    expect(w(at(false, 0), 500)).toBeNull();
    expect(w(at(false, 0), 20_000)).toBeNull();
    expect(w(at(false, 0), 20_600)).toBe("stalled");
    expect(w(at(false, 0), 45_000)).toBeNull();
    // The stall kick (a click) can pause it: the paused kick then plays it again.
    expect(w(at(true, 0), 45_500)).toBe("paused");
  });

  test("the paused kick plays it: the next sample at the same currentTime is not 'stalled' at once", () => {
    const w = stallWatch(0);
    expect(w(at(true, 0), 250)).toBeNull();
    expect(w(at(true, 0), 20_500)).toBe("paused");
    expect(w(at(false, 0), 20_750)).toBeNull();
    expect(w(at(false, 0), 40_000)).toBeNull();
    expect(w(at(false, 0), 41_000)).toBe("stalled");
  });

  test("a player whose currentTime moves is never 'stalled'", () => {
    const w = stallWatch(0);
    for (let t = 0; t <= 60_000; t += 500) expect(w(at(false, t / 100_000), t)).toBeNull();
  });
});
