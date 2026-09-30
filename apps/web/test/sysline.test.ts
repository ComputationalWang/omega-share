import { describe, expect, test } from "bun:test";
import type { Member, PlaybackState } from "@omega/shared";
import { formatClock, lineText, systemLine } from "../src/controls/sysline";

const ana: Member = { id: "a", nickname: "Ana", avatar: 0 };
const ben: Member = { id: "b", nickname: "Ben", avatar: 1 };
const members = [ana, ben];

function pb(over: Partial<PlaybackState>): PlaybackState {
  return { playing: true, position: 0, rate: 1, at: 1_000, rev: 2, action: "play", by: "a", ...over };
}

describe("formatClock", () => {
  test.each([
    [0, "0:00"],
    [5.9, "0:05"],
    [65, "1:05"],
    [750, "12:30"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3765, "1:02:45"],
    [43_200, "12:00:00"],
  ])("%p s → %p", (s, text) => {
    expect(formatClock(s)).toBe(text);
  });

  test("garbage reads as 0:00", () => {
    expect(formatClock(-3)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("systemLine", () => {
  test("pause: actor + verb, no time", () => {
    const l = systemLine(pb({ action: "pause", playing: false, by: "a" }), members, "b");
    expect(l).toEqual({ glyph: "pause", actor: "Ana", verb: "paused", time: null });
    expect(l === null ? "" : lineText(l)).toBe("Ana paused");
  });

  test("play", () => {
    const l = systemLine(pb({ action: "play", by: "b" }), members, "a");
    expect(l === null ? "" : lineText(l)).toBe("Ben pressed play");
    expect(l?.glyph).toBe("play");
  });

  test("seek carries the target time", () => {
    const l = systemLine(pb({ action: "seek", position: 750, by: "b" }), members, "a");
    expect(l).toEqual({ glyph: "seek", actor: "Ben", verb: "skipped to", time: "12:30" });
    expect(l === null ? "" : lineText(l)).toBe("Ben skipped to 12:30");
  });

  test("load from the extension (by: null) → Video shared", () => {
    const l = systemLine(pb({ action: "load", by: null, playing: true, position: 0 }), members, "a");
    expect(l === null ? "" : lineText(l)).toBe("Video shared");
    expect(l?.actor).toBeNull();
  });

  test("load by a member names them", () => {
    const l = systemLine(pb({ action: "load", by: "a" }), members, "b");
    expect(l === null ? "" : lineText(l)).toBe("Ana shared a video");
  });

  test("my own action says You", () => {
    const l = systemLine(pb({ action: "pause", by: "a" }), members, "a");
    expect(l?.actor).toBe("You");
  });

  test("someone who already left, or no actor, is Someone", () => {
    expect(systemLine(pb({ action: "pause", by: "zzz" }), members, "a")?.actor).toBe("Someone");
    expect(systemLine(pb({ action: "seek", by: null, position: 3 }), members, "a")?.actor).toBe("Someone");
  });

  test("names are carried as data, never markup", () => {
    const evil: Member = { id: "e", nickname: "<img src=x>", avatar: 2 };
    const l = systemLine(pb({ action: "pause", by: "e" }), [evil], "a");
    expect(l?.actor).toBe("<img src=x>");
  });
});
