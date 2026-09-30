import { describe, expect, test } from "bun:test";
import { playerErrorText } from "../src/controls/player-error";

describe("playerErrorText", () => {
  test.each([101, 150])("%i: the owner doesn't allow playback on other sites", (code) => {
    expect(playerErrorText(code)).toBe("This video can't play here: the owner doesn't allow playback on other sites.");
  });

  test("100: removed or private", () => {
    expect(playerErrorText(100)).toBe("This video can't play here: it's unavailable (removed or private).");
  });

  test.each([2, 5, 153, -1])("%i: a generic can't-play notice", (code) => {
    expect(playerErrorText(code)).toMatch(/^This video can't play here/);
  });
});
