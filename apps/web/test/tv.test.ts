import { describe, expect, test } from "bun:test";
import { NOCOOKIE_ORIGIN, tvFrame, twitchIframeMatches, type TvFrame, type TvIframe, type TvTwitch } from "../src/tv";

const good = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
const ORIGIN = "http://localhost:5173";
const vimeo = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
const vimeoUnlisted = { provider: "vimeo", videoId: "76979871", hash: "0a1b2c3d4e", url: "https://player.vimeo.com/video/76979871?h=0a1b2c3d4e" };
const twitchLive = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" };
const twitchVod = { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" };

function iframe(f: TvFrame | null): TvIframe {
  if (f?.kind !== "iframe") throw new Error(`expected an iframe frame, got ${f === null ? "null" : f.kind}`);
  return f;
}
function twitch(f: TvFrame | null): TvTwitch {
  if (f?.kind !== "twitch") throw new Error(`expected a Twitch SDK frame, got ${f === null ? "null" : f.kind}`);
  return f;
}

describe("tvFrame", () => {
  test("src is the nocookie embed with exactly the fixed player parameters", () => {
    const f = iframe(tvFrame(good, ORIGIN));
    const src = new URL(f.src);
    expect(src.origin).toBe("https://www.youtube-nocookie.com");
    expect(NOCOOKIE_ORIGIN).toBe("https://www.youtube-nocookie.com");
    expect(src.pathname).toBe("/embed/dQw4w9WgXcQ");
    expect(src.hash).toBe("");
    expect(Object.fromEntries(src.searchParams)).toEqual({
      enablejsapi: "1",
      origin: ORIGIN,
      controls: "0",
      disablekb: "1",
      playsinline: "1",
      rel: "0",
      autoplay: "1",
    });
    expect([...src.searchParams.keys()]).toHaveLength(7);
  });

  test("the nocookie flag off keeps the canonical www.youtube.com host", () => {
    const f = iframe(tvFrame(good, ORIGIN, false));
    const src = new URL(f.src);
    expect(src.origin + src.pathname).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(src.searchParams.get("enablejsapi")).toBe("1");
    expect(src.searchParams.get("origin")).toBe(ORIGIN);
  });

  test("sandbox allows popups for YouTube's own links, but no forms, modals or top navigation", () => {
    const f = iframe(tvFrame(good, ORIGIN));
    expect(f.sandbox.split(" ").sort()).toEqual([
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-presentation",
      "allow-same-origin",
      "allow-scripts",
    ]);
    expect(f.allow).toBe("autoplay; encrypted-media; picture-in-picture; fullscreen");
    expect(f.referrerPolicy).toBe("strict-origin-when-cross-origin");
  });

  test("the origin parameter is the page origin only, never a path or query", () => {
    const f = iframe(tvFrame(good, "http://localhost:5173/rooms/lobby?x=1"));
    expect(new URL(f.src).searchParams.get("origin")).toBe(ORIGIN);
  });

  test("an origin that is not http(s) renders nothing, for every provider", () => {
    for (const e of [good, vimeo, twitchLive, twitchVod]) {
      for (const o of ["", "null", "javascript:alert(1)", "file:///x"]) expect(tvFrame(e, o)).toBeNull();
    }
  });

  test("the change key differs per embed and per page host", () => {
    const keys = [tvFrame(good, ORIGIN), tvFrame(vimeo, ORIGIN), tvFrame(vimeoUnlisted, ORIGIN), tvFrame(twitchLive, ORIGIN), tvFrame(twitchVod, ORIGIN), tvFrame(twitchLive, "https://abc.trycloudflare.com")].map((f) => f?.key);
    expect(new Set(keys).size).toBe(6);
    expect(tvFrame(twitchLive, ORIGIN)?.key).toBe(tvFrame(twitchLive, ORIGIN)?.key);
  });

  test("anything that is not a canonical allowlisted embed renders nothing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      { ...good, url: "https://evil.example/embed/dQw4w9WgXcQ" },
      { ...good, url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" },
      { ...good, url: "javascript:alert(1)" },
      { ...good, provider: "vimeo" },
      { ...good, provider: "twitch" },
      { ...vimeo, url: "https://player.vimeo.com/video/76979871?autoplay=0" },
      { ...vimeo, url: "https://evil.example/video/76979871" },
      { ...vimeo, url: "https://player.vimeo.com/video/1" },
      { ...vimeo, videoId: "76979871?x", url: "https://player.vimeo.com/video/76979871?x" },
      { ...vimeoUnlisted, hash: "0A1B2C3D4E", url: "https://player.vimeo.com/video/76979871?h=0A1B2C3D4E" },
      { ...vimeoUnlisted, hash: "abc123&autoplay=0", url: "https://player.vimeo.com/video/76979871?h=abc123&autoplay=0" },
      { ...vimeo, provider: "vimeo", url: "https://vimeo.com/76979871" },
      { ...twitchLive, channel: "evil&parent=evil.example", url: "https://player.twitch.tv/?channel=evil&parent=evil.example" },
      { ...twitchLive, channel: "Some_Streamer", url: "https://player.twitch.tv/?channel=Some_Streamer" },
      { ...twitchLive, channel: "directory", url: "https://player.twitch.tv/?channel=directory" },
      { ...twitchLive, url: "https://player.twitch.tv/?channel=other" },
      { ...twitchLive, kind: "vod" },
      { ...twitchVod, url: "https://player.twitch.tv/?video=1234567890" },
      { ...twitchVod, url: "https://player.twitch.tv/?video=v1234567890&parent=evil.example" },
      { provider: "twitch", kind: "clip", slug: "x", url: "https://clips.twitch.tv/x" },
      { ...good, videoId: "videoseries", url: "https://www.youtube.com/embed/videoseries" },
      { ...good, videoId: "../../../x", url: "https://www.youtube.com/embed/../../../x" },
      { ...good, url: "https://www.youtube.com/embed/dQw4w9WgXcQ?list=x" },
      { ...good, url: "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=0" },
    ];
    for (const b of bad) expect(tvFrame(b, ORIGIN)).toBeNull();
  });
});

describe("tvFrame: Vimeo (ADR 0014 §5)", () => {
  test("src is the canonical player URL plus exactly the fixed parameters", () => {
    const src = new URL(iframe(tvFrame(vimeo, ORIGIN)).src);
    expect(src.origin + src.pathname).toBe("https://player.vimeo.com/video/76979871");
    expect(src.hash).toBe("");
    expect([...src.searchParams]).toEqual([
      ["dnt", "1"],
      ["autopause", "0"],
      ["autoplay", "1"],
      ["keyboard", "0"],
      ["controls", "0"],
      ["title", "0"],
      ["byline", "0"],
      ["portrait", "0"],
    ]);
  });

  test("an unlisted video keeps its privacy hash, first", () => {
    const src = new URL(iframe(tvFrame(vimeoUnlisted, ORIGIN)).src);
    expect(src.origin + src.pathname).toBe("https://player.vimeo.com/video/76979871");
    expect([...src.searchParams.keys()]).toEqual(["h", "dnt", "autopause", "autoplay", "keyboard", "controls", "title", "byline", "portrait"]);
    expect(src.searchParams.get("h")).toBe("0a1b2c3d4e");
  });

  test("ADR 0011 sandbox, Vimeo's allow list, strict-origin referrer", () => {
    const f = iframe(tvFrame(vimeo, ORIGIN));
    expect(f.sandbox.split(" ").sort()).toEqual([
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-presentation",
      "allow-same-origin",
      "allow-scripts",
    ]);
    expect(f.allow).toBe("autoplay; fullscreen; picture-in-picture; encrypted-media");
    expect(f.referrerPolicy).toBe("strict-origin-when-cross-origin");
  });

  test("the nocookie flag doesn't touch Vimeo", () => {
    expect(iframe(tvFrame(vimeo, ORIGIN, true)).src).toBe(iframe(tvFrame(vimeo, ORIGIN, false)).src);
  });
});

describe("tvFrame: Twitch (the SDK builds the iframe; ADR 0014 §5)", () => {
  test("live: frozen SDK options from the parsed embed, parent = this page's host only", () => {
    const f = twitch(tvFrame(twitchLive, "https://abc.trycloudflare.com/r/lobby?x=1"));
    expect(f.options).toEqual({ channel: "some_streamer", parent: ["abc.trycloudflare.com"], width: "100%", height: "100%", autoplay: true, muted: false });
    expect(Object.isFrozen(f.options)).toBe(true);
    expect(Object.isFrozen(f.options.parent)).toBe(true);
  });

  test("VOD: the video option carries the v prefix", () => {
    const f = twitch(tvFrame(twitchVod, ORIGIN));
    expect(f.options).toEqual({ video: "v1234567890", parent: ["localhost"], width: "100%", height: "100%", autoplay: true, muted: false });
  });
});

describe("twitchIframeMatches (post-render check, research §4.1 W1)", () => {
  // The shape the real SDK builds: options + parent + referrer, keys sorted (e2e/fixtures/fake-twitch-embed.ts).
  const built = (q: string) => `https://player.twitch.tv?${q}`;
  const live = twitch(tvFrame(twitchLive, ORIGIN));
  const vod = twitch(tvFrame(twitchVod, ORIGIN));

  test("accepts the SDK's iframe for this embed", () => {
    expect(twitchIframeMatches(built("autoplay=true&channel=some_streamer&height=100%25&muted=false&parent=localhost&referrer=http%3A%2F%2Flocalhost%3A5173%2Fr%2Flobby&width=100%25"), live)).toBe(true);
    expect(twitchIframeMatches(built("autoplay=true&height=100%25&parent=localhost&video=v1234567890&width=100%25"), vod)).toBe(true);
    expect(twitchIframeMatches("https://player.twitch.tv/?channel=some_streamer&parent=localhost", live)).toBe(true);
  });

  test("rejects another origin, another channel or video, or an ambiguous src", () => {
    const bad = [
      "",
      "not a url",
      "http://player.twitch.tv?channel=some_streamer",
      "https://player.twitch.tv.evil.example?channel=some_streamer",
      "https://evil.example?channel=some_streamer",
      "https://clips.twitch.tv?channel=some_streamer",
      "https://player.twitch.tv:8443?channel=some_streamer",
      "https://player.twitch.tv?channel=other",
      "https://player.twitch.tv?channel=some_streamer&channel=other",
      "https://player.twitch.tv?channel=some_streamer&video=v1",
      "https://player.twitch.tv?channel=some_streamer&collection=abc",
      "https://player.twitch.tv?video=v1234567890",
      // parent must be exactly this page's host (the SDK appends document.domain, which is the same host).
      "https://player.twitch.tv?channel=some_streamer",
      "https://player.twitch.tv?channel=some_streamer&parent=evil.example",
      "https://player.twitch.tv?channel=some_streamer&parent=localhost&parent=evil.example",
    ];
    for (const b of bad) expect([b, twitchIframeMatches(b, live)]).toEqual([b, false]);
    expect(twitchIframeMatches("https://player.twitch.tv?video=v1", vod)).toBe(false);
    expect(twitchIframeMatches("https://player.twitch.tv?video=v1234567890&channel=some_streamer", vod)).toBe(false);
  });
});
