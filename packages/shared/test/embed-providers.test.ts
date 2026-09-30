import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { EmbedSchema, MAX_EMBED_URL_LENGTH, PROVIDERS, canonicalizeEmbed, type Embed } from "../src/index";

const LIVE: Embed = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" };
const VOD: Embed = { provider: "twitch", kind: "vod", videoId: "40464143", url: "https://player.twitch.tv/?video=v40464143" };
const VIMEO: Embed = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
const UNLISTED: Embed = {
  provider: "vimeo",
  videoId: "76979871",
  hash: "abc123def4",
  url: "https://player.vimeo.com/video/76979871?h=abc123def4",
};

test("PROVIDERS is the M2 allowlist", () => {
  expect(PROVIDERS).toEqual(["youtube", "twitch", "vimeo"]);
});

function accepts(table: readonly [string, Embed][]): void {
  for (const [input, expected] of table) {
    test(input, () => {
      const got = canonicalizeEmbed(input);
      expect(got).toEqual(expected);
      expect(v.is(EmbedSchema, got)).toBe(true);
    });
  }
}

function rejects(table: readonly [string, string][]): void {
  for (const [name, input] of table) {
    test(name, () => {
      expect(canonicalizeEmbed(input)).toBeNull();
    });
  }
}

describe("canonicalizeEmbed: Twitch accepted", () => {
  accepts([
    ["https://www.twitch.tv/some_streamer", LIVE],
    ["https://twitch.tv/some_streamer", LIVE],
    ["https://m.twitch.tv/some_streamer", LIVE],
    ["http://www.twitch.tv/some_streamer", LIVE],
    ["https://www.twitch.tv/some_streamer/", LIVE],
    ["https://www.twitch.tv/Some_Streamer", LIVE],
    ["https://WWW.Twitch.TV/some_streamer?sr=a", LIVE],
    ["  https://www.twitch.tv/some_streamer#chat  ", LIVE],
    ["https://player.twitch.tv/?channel=some_streamer", LIVE],
    ["https://player.twitch.tv/?channel=Some_Streamer&parent=example.com&autoplay=false", LIVE],
    ["https://www.twitch.tv/videos/40464143", VOD],
    ["https://m.twitch.tv/videos/40464143?t=1h2m3s", VOD],
    ["https://player.twitch.tv/?video=v40464143", VOD],
    ["https://player.twitch.tv/?video=40464143&parent=example.com", VOD],
    ["https://player.twitch.tv/?video=V40464143", VOD],
  ]);

  test("a 1-char and a 25-char login are both valid", () => {
    expect(canonicalizeEmbed("https://twitch.tv/a")?.url).toBe("https://player.twitch.tv/?channel=a");
    const long = "a".repeat(25);
    expect(canonicalizeEmbed(`https://twitch.tv/${long}`)?.url).toBe(`https://player.twitch.tv/?channel=${long}`);
  });
});

describe("canonicalizeEmbed: Twitch rejected", () => {
  rejects([
    ["clips host", "https://clips.twitch.tv/SomeClipSlug-abc"],
    ["channel clip path", "https://www.twitch.tv/some_streamer/clip/SomeClipSlug-abc"],
    ["collection in player", "https://player.twitch.tv/?collection=abc123&video=v40464143"],
    ["collection only", "https://player.twitch.tv/?collection=abc123"],
    ["channel and video together", "https://player.twitch.tv/?channel=some_streamer&video=v40464143"],
    ["duplicate channel", "https://player.twitch.tv/?channel=a&channel=b"],
    ["duplicate video", "https://player.twitch.tv/?video=v1&video=v2"],
    ["player with nothing", "https://player.twitch.tv/"],
    ["player with a path", "https://player.twitch.tv/embed?channel=some_streamer"],
    ["empty channel param", "https://player.twitch.tv/?channel="],
    ["twitch root", "https://www.twitch.tv/"],
    ["reserved page: directory", "https://www.twitch.tv/directory"],
    ["reserved page: videos", "https://www.twitch.tv/videos"],
    ["reserved page: settings", "https://www.twitch.tv/settings"],
    ["reserved login via player", "https://player.twitch.tv/?channel=directory"],
    ["channel sub-page", "https://www.twitch.tv/some_streamer/videos"],
    ["channel double slash", "https://www.twitch.tv/some_streamer//"],
    ["vod extra path", "https://www.twitch.tv/videos/40464143/extra"],
    ["vod trailing slash", "https://www.twitch.tv/videos/40464143/"],
    ["login too long", `https://www.twitch.tv/${"a".repeat(26)}`],
    ["login with dash", "https://www.twitch.tv/some-streamer"],
    ["login with dot", "https://www.twitch.tv/some.streamer"],
    ["login percent-encoded", "https://www.twitch.tv/some%5Fstreamer"],
    ["login non-ascii", "https://www.twitch.tv/strеamer"],
    ["player channel with quote", "https://player.twitch.tv/?channel=a%22onload%3D"],
    ["vod leading zero", "https://www.twitch.tv/videos/040464143"],
    ["vod zero", "https://player.twitch.tv/?video=v0"],
    ["vod too long", `https://www.twitch.tv/videos/${"1".repeat(13)}`],
    ["vod not numeric", "https://www.twitch.tv/videos/abc"],
    ["player vod double v", "https://player.twitch.tv/?video=vv40464143"],
    ["player vod bare v", "https://player.twitch.tv/?video=v"],
    ["userinfo", "https://user:pass@www.twitch.tv/some_streamer"],
    ["username only", "https://evil@player.twitch.tv/?channel=some_streamer"],
    ["port", "https://www.twitch.tv:8443/some_streamer"],
    ["lookalike suffix", "https://twitch.tv.evil.example/some_streamer"],
    ["lookalike prefix", "https://eviltwitch.tv/some_streamer"],
    ["other subdomain", "https://dashboard.twitch.tv/some_streamer"],
    ["trailing-dot host", "https://twitch.tv./some_streamer"],
    ["javascript scheme", "javascript:alert(1)//https://twitch.tv/some_streamer"],
    ["over length cap", `https://www.twitch.tv/some_streamer?x=${"a".repeat(3000)}`],
  ]);
});

describe("canonicalizeEmbed: Vimeo accepted", () => {
  accepts([
    ["https://vimeo.com/76979871", VIMEO],
    ["https://www.vimeo.com/76979871", VIMEO],
    ["http://vimeo.com/76979871", VIMEO],
    ["https://Vimeo.COM/76979871?share=copy#t=10", VIMEO],
    ["https://vimeo.com/channels/staffpicks/76979871", VIMEO],
    ["https://vimeo.com/groups/shortfilms/videos/76979871", VIMEO],
    ["https://vimeo.com/album/1234/video/76979871", VIMEO],
    ["https://vimeo.com/showcase/1234/video/76979871", VIMEO],
    ["https://player.vimeo.com/video/76979871", VIMEO],
    ["https://player.vimeo.com/video/76979871?autoplay=1&dnt=1", VIMEO],
    ["https://vimeo.com/76979871/abc123def4", UNLISTED],
    ["https://vimeo.com/76979871/ABC123DEF4", UNLISTED],
    ["https://player.vimeo.com/video/76979871?h=abc123def4", UNLISTED],
    ["https://player.vimeo.com/video/76979871?badge=0&h=abc123def4&dnt=1", UNLISTED],
  ]);
});

describe("canonicalizeEmbed: Vimeo rejected", () => {
  rejects([
    ["live event", "https://vimeo.com/event/1234567"],
    ["live event embed", "https://vimeo.com/event/1234567/embed"],
    ["showcase without a video", "https://vimeo.com/showcase/1234"],
    ["channel without a video", "https://vimeo.com/channels/staffpicks"],
    ["user page", "https://vimeo.com/someuser"],
    ["vimeo root", "https://vimeo.com/"],
    ["id leading zero", "https://vimeo.com/076979871"],
    ["id too long", `https://vimeo.com/${"1".repeat(13)}`],
    ["id not numeric", "https://player.vimeo.com/video/abc"],
    ["hash too short", "https://vimeo.com/76979871/abc12"],
    ["hash too long", `https://vimeo.com/76979871/${"a".repeat(33)}`],
    ["hash not hex", "https://vimeo.com/76979871/xyz123def4"],
    ["hash with quote", "https://player.vimeo.com/video/76979871?h=abc123%22def"],
    ["empty h", "https://player.vimeo.com/video/76979871?h="],
    ["duplicate h", "https://player.vimeo.com/video/76979871?h=abc123def4&h=abc123def5"],
    ["path extra after hash", "https://vimeo.com/76979871/abc123def4/extra"],
    ["player extra path", "https://player.vimeo.com/video/76979871/extra"],
    ["player trailing slash", "https://player.vimeo.com/video/76979871/"],
    ["player without video path", "https://player.vimeo.com/76979871"],
    ["watch trailing slash", "https://vimeo.com/76979871/"],
    ["channel extra path", "https://vimeo.com/channels/staffpicks/76979871/extra"],
    ["group without videos segment", "https://vimeo.com/groups/shortfilms/76979871"],
    ["album without video segment", "https://vimeo.com/album/1234/76979871"],
    ["white-label videoji", "https://player.videoji.hk/video/76979871"],
    ["white-label vimeo.work", "https://player.vimeo.work/video/76979871"],
    ["other subdomain", "https://api.vimeo.com/videos/76979871"],
    ["lookalike suffix", "https://vimeo.com.evil.example/76979871"],
    ["lookalike prefix", "https://evilvimeo.com/76979871"],
    ["userinfo", "https://user:pass@vimeo.com/76979871"],
    ["port", "https://player.vimeo.com:444/video/76979871"],
    ["javascript scheme", "javascript:alert(1)//https://vimeo.com/76979871"],
    ["over length cap", `https://vimeo.com/76979871?x=${"a".repeat(3000)}`],
  ]);
});

describe("EmbedSchema: Twitch and Vimeo", () => {
  test("accepts canonical embeds of every variant", () => {
    for (const e of [LIVE, VOD, VIMEO, UNLISTED]) expect(v.is(EmbedSchema, e)).toBe(true);
  });

  const invalid: readonly [string, unknown][] = [
    ["twitch live url not canonical", { ...LIVE, url: "https://www.twitch.tv/some_streamer" }],
    ["twitch live url with render-time params", { ...LIVE, url: `${LIVE.url}&parent=evil.example` }],
    ["twitch live url for another channel", { ...LIVE, url: "https://player.twitch.tv/?channel=other" }],
    ["twitch live uppercase channel", { ...LIVE, channel: "Some_Streamer", url: "https://player.twitch.tv/?channel=Some_Streamer" }],
    ["twitch live reserved channel", { ...LIVE, channel: "directory", url: "https://player.twitch.tv/?channel=directory" }],
    ["twitch live without kind", { provider: "twitch", channel: "some_streamer", url: LIVE.url }],
    ["twitch unknown kind", { provider: "twitch", kind: "clip", channel: "some_streamer", url: LIVE.url }],
    ["twitch vod url without v", { ...VOD, url: "https://player.twitch.tv/?video=40464143" }],
    ["twitch vod labelled live", { provider: "twitch", kind: "live", videoId: "40464143", url: VOD.url }],
    ["twitch vod bad id", { ...VOD, videoId: "0", url: "https://player.twitch.tv/?video=v0" }],
    ["vimeo url not canonical", { ...VIMEO, url: "https://vimeo.com/76979871" }],
    ["vimeo url drops the hash", { ...UNLISTED, url: VIMEO.url }],
    ["vimeo url adds a hash", { ...VIMEO, url: UNLISTED.url }],
    ["vimeo missing hash key", { provider: "vimeo", videoId: VIMEO.videoId, url: VIMEO.url }],
    ["vimeo uppercase hash", { ...UNLISTED, hash: "ABC123DEF4", url: "https://player.vimeo.com/video/76979871?h=ABC123DEF4" }],
    ["vimeo arbitrary iframe url", { ...VIMEO, url: "https://evil.example/" }],
    ["youtube shape labelled vimeo", { provider: "vimeo", videoId: "dQw4w9WgXcQ", hash: null, url: "https://www.youtube.com/embed/dQw4w9WgXcQ" }],
  ];

  for (const [name, input] of invalid) {
    test(`rejects ${name}`, () => {
      expect(v.is(EmbedSchema, input)).toBe(false);
    });
  }
});

describe("MAX_EMBED_URL_LENGTH", () => {
  test("covers the longest canonical url of every provider", () => {
    const longest = [
      canonicalizeEmbed("https://youtu.be/dQw4w9WgXcQ"),
      canonicalizeEmbed(`https://twitch.tv/${"a".repeat(25)}`),
      canonicalizeEmbed(`https://twitch.tv/videos/${"9".repeat(12)}`),
      canonicalizeEmbed(`https://vimeo.com/${"9".repeat(12)}/${"f".repeat(32)}`),
    ];
    for (const e of longest) {
      expect(e).not.toBeNull();
      expect(e?.url.length ?? Infinity).toBeLessThanOrEqual(MAX_EMBED_URL_LENGTH);
    }
  });
});
