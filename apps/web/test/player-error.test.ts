import { describe, expect, test } from "bun:test";
import { mountErrorText, playerErrorText, providerHint } from "../src/controls/player-error";

describe("playerErrorText", () => {
  test("refused: the owner doesn't allow playback on other sites", () => {
    expect(playerErrorText({ reason: "refused", code: "150" })).toBe("This video can't play here: the owner doesn't allow playback on other sites.");
  });

  test("not-found: removed or private", () => {
    expect(playerErrorText({ reason: "not-found", code: "100" })).toBe("This video can't play here: it's unavailable (removed or private).");
  });

  test("restricted, offline and timeout get their own text", () => {
    expect(playerErrorText({ reason: "restricted", code: "6" })).toBe("This video can't play here: it's restricted (age, subscription or region).");
    expect(playerErrorText({ reason: "offline", code: "offline" })).toBe("This video can't play here: the channel is offline.");
    expect(playerErrorText({ reason: "timeout", code: "ready" })).toBe("This video can't play here: the player didn't start.");
  });

  test("other: a generic notice with the provider's code", () => {
    expect(playerErrorText({ reason: "other", code: "5" })).toBe("This video can't play here: the player reported an error (code 5).");
  });
});

describe("mountErrorText", () => {
  test("a player API that didn't load keeps the M1b wording, per provider", () => {
    expect(mountErrorText("youtube", "load-failed")).toBe("The video plays here without sync: the YouTube player API didn't load.");
    expect(mountErrorText("youtube", "timeout")).toBe("The video plays here without sync: the YouTube player API didn't load.");
    expect(mountErrorText("vimeo", "load-failed")).toBe("The video plays here without sync: the Vimeo player API didn't load.");
  });

  test("a provider without an adapter yet, and a player that didn't match the room's video", () => {
    expect(mountErrorText("twitch", "unsupported")).toBe("Sync for Twitch videos isn't ready yet.");
    expect(mountErrorText("twitch", "invalid")).toBe("This video can't play here: the player didn't match the room's video.");
  });
});

describe("providerHint", () => {
  // OME-244: Twitch's mature gate is inside its cross-origin player, so we can't detect it; every Twitch embed gets the hint.
  test("Twitch: tell members to press the player's own Start Watching button", () => {
    expect(providerHint("twitch")).toBe("If the Twitch player asks, press Start Watching in it.");
  });

  test("YouTube and Vimeo: no hint", () => {
    expect(providerHint("youtube")).toBeNull();
    expect(providerHint("vimeo")).toBeNull();
  });
});
