import { describe, expect, test } from "bun:test";
import { canonicalizeEmbed, playbackCaps, type Embed, type PlaybackCaps } from "../src/index";

function embed(url: string): Embed {
  const e = canonicalizeEmbed(url);
  if (e === null) throw new Error(`not an embed: ${url}`);
  return e;
}

describe("playbackCaps", () => {
  const table: readonly [string, string, PlaybackCaps][] = [
    ["youtube", "https://youtu.be/dQw4w9WgXcQ", { seek: true, live: false, rate: "yes" }],
    ["vimeo", "https://vimeo.com/76979871", { seek: true, live: false, rate: "probe" }],
    ["vimeo unlisted", "https://vimeo.com/76979871/abc123def4", { seek: true, live: false, rate: "probe" }],
    ["twitch vod", "https://www.twitch.tv/videos/40464143", { seek: true, live: false, rate: "no" }],
    ["twitch live", "https://www.twitch.tv/some_streamer", { seek: false, live: true, rate: "no" }],
  ];

  for (const [name, url, caps] of table) {
    test(name, () => {
      expect(playbackCaps(embed(url))).toEqual(caps);
    });
  }

  test("returns a shared frozen object (no allocation per call)", () => {
    const a = playbackCaps(embed("https://youtu.be/dQw4w9WgXcQ"));
    const b = playbackCaps(embed("https://youtu.be/aaaaaaaaaaa"));
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});
