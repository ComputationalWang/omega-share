import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Embed, type GenericEmbed, isSyncedEmbed } from "@omega/shared";
import { Window } from "happy-dom";
import { listEmbeds } from "../src/embeds";
import { collectCandidateUrls } from "../src/scan";

const PAGES = join(import.meta.dirname, "../../../e2e/fixtures/pages");
const OWN_PAGES = join(import.meta.dirname, "fixtures/pages");

function load(name: string, url: string, dir: string = PAGES): Document {
  const window = new Window({
    url,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  window.document.write(readFileSync(join(dir, `${name}.html`), "utf8"));
  return window.document as unknown as Document;
}

const EMBED: Embed = { provider: "youtube", videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/embed/aqz-KE-bpKQ" };

describe("collectCandidateUrls on fixture pages", () => {
  test("youtube-embed: finds the iframe", () => {
    const doc = load("youtube-embed", "http://localhost:4400/youtube-embed.html");
    expect(collectCandidateUrls(doc).urls).toContain("https://www.youtube.com/embed/aqz-KE-bpKQ");
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([EMBED]);
  });

  test("watch-url: the page URL itself is the video", () => {
    const doc = load("watch-url", "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    expect(collectCandidateUrls(doc).urls[0]).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([EMBED]);
  });

  test("non-allowlisted: nothing survives canonicalization", () => {
    const doc = load("non-allowlisted", "http://localhost:4400/non-allowlisted.html");
    expect(collectCandidateUrls(doc).urls.length).toBeGreaterThan(1);
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([]);
  });

  test("no-video: only the page URL", () => {
    const doc = load("no-video", "http://localhost:4400/no-video.html");
    expect(collectCandidateUrls(doc)).toEqual({ urls: ["http://localhost:4400/no-video.html"], media: [] });
  });

  test("also reads <embed src> and <object data>, resolved against the page", () => {
    const window = new Window({ url: "https://www.youtube.com/", settings: { disableIframePageLoading: true } });
    window.document.write('<embed src="/embed/aqz-KE-bpKQ"><object data="https://youtu.be/dQw4w9WgXcQ"></object>');
    const { urls } = collectCandidateUrls(window.document as unknown as Document);
    expect(urls).toContain("https://www.youtube.com/embed/aqz-KE-bpKQ");
    expect(urls).toContain("https://youtu.be/dQw4w9WgXcQ");
  });
});

const generic = (url: string): GenericEmbed => ({ provider: "generic", host: new URL(url).hostname, url });

const TWITCH_LIVE: Embed = { provider: "twitch", kind: "live", channel: "somechannel", url: "https://player.twitch.tv/?channel=somechannel" };
const TWITCH_VOD: Embed = { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" };
const VIMEO: Embed = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
const VIMEO_UNLISTED: Embed = { ...VIMEO, hash: "8272103f6e", url: "https://player.vimeo.com/video/76979871?h=8272103f6e" };

describe("collectCandidateUrls on Twitch + Vimeo fixture pages", () => {
  test("providers-embed: lists YouTube, Twitch live, Twitch VOD and Vimeo once each, in page order", () => {
    const doc = load("providers-embed", "http://localhost:4400/providers-embed.html", OWN_PAGES);
    expect(listEmbeds(collectCandidateUrls(doc)).filter(isSyncedEmbed)).toEqual([EMBED, TWITCH_LIVE, TWITCH_VOD, VIMEO_UNLISTED]);
  });

  test("providers-embed: lookalikes on real public hosts are only ever generic, labelled with their own host, after the synced ones", () => {
    const doc = load("providers-embed", "http://localhost:4400/providers-embed.html", OWN_PAGES);
    expect(listEmbeds(collectCandidateUrls(doc)).slice(4)).toEqual([
      { provider: "generic", host: "player-twitch.tv", url: "https://player-twitch.tv/?channel=somechannel" },
      { provider: "generic", host: "vimeo.co", url: "https://vimeo.co/76979871" },
    ]);
  });

  const rejectedIframes = (doc: Document): string[] =>
    [...doc.querySelectorAll("iframe")].slice(5).map((f) => new URL(f.getAttribute("src") ?? "", doc.baseURI).href);

  test("providers-embed: clips, collections and Vimeo live events are found but not listed at all, synced or generic", () => {
    const doc = load("providers-embed", "http://localhost:4400/providers-embed.html", OWN_PAGES);
    const rejected = rejectedIframes(doc).slice(0, 4);
    expect(rejected).toEqual([
      "https://clips.twitch.tv/embed?clip=AwkwardHelplessSalamanderSwiftRage&parent=localhost",
      "https://www.twitch.tv/somechannel/clip/AwkwardHelplessSalamanderSwiftRage",
      "https://player.twitch.tv/?collection=abcDEF123&video=1234567890&parent=localhost",
      "https://vimeo.com/event/123456/embed",
    ]);
    const found = collectCandidateUrls(doc);
    for (const url of rejected) {
      expect(found.urls).toContain(url);
      expect(found.media).toContain(url);
      expect(listEmbeds({ urls: [url], media: [url] })).toEqual([]);
    }
  });

  test("providers-embed: lookalike and path-spoof hosts are never synced; public ones are generic under their own host, .example ones are dropped", () => {
    const doc = load("providers-embed", "http://localhost:4400/providers-embed.html", OWN_PAGES);
    const lookalikes = rejectedIframes(doc).slice(4);
    const expected: Record<string, readonly GenericEmbed[]> = {
      "https://player.twitch.tv.evil.example/?channel=somechannel": [],
      "https://player-twitch.tv/?channel=somechannel": [generic("https://player-twitch.tv/?channel=somechannel")],
      "https://evil.example/player.twitch.tv/?channel=somechannel": [],
      "https://player.vimeo.com.evil.example/video/76979871": [],
      "https://vimeo.co/76979871": [generic("https://vimeo.co/76979871")],
      "https://evil.example/player.vimeo.com/video/76979871": [],
    };
    expect(lookalikes).toEqual(Object.keys(expected));
    const found = collectCandidateUrls(doc);
    for (const url of lookalikes) {
      expect(found.urls).toContain(url);
      expect(listEmbeds({ urls: [url], media: [url] })).toEqual([...(expected[url] ?? [])]);
    }
  });

  const watchPages: readonly { url: string; expected: readonly Embed[] }[] = [
    { url: "https://www.twitch.tv/SomeChannel", expected: [TWITCH_LIVE] },
    { url: "https://m.twitch.tv/somechannel?sr=a", expected: [TWITCH_LIVE] },
    { url: "https://www.twitch.tv/videos/1234567890?t=1h2m3s", expected: [TWITCH_VOD] },
    { url: "https://vimeo.com/76979871", expected: [VIMEO] },
    { url: "https://vimeo.com/76979871/8272103f6e", expected: [VIMEO_UNLISTED] },
    { url: "https://vimeo.com/channels/staffpicks/76979871", expected: [VIMEO] },
    // Rejected: clips, non-video pages, live events, lookalike hosts.
    { url: "https://www.twitch.tv/somechannel/clip/AwkwardHelplessSalamanderSwiftRage", expected: [] },
    { url: "https://clips.twitch.tv/AwkwardHelplessSalamanderSwiftRage", expected: [] },
    { url: "https://www.twitch.tv/directory", expected: [] },
    { url: "https://www.twitch.tv/somechannel/videos", expected: [] },
    { url: "https://vimeo.com/event/123456", expected: [] },
    { url: "https://www.twitch.tv.evil.example/somechannel", expected: [] },
    { url: "https://vimeo.com.evil.example/76979871", expected: [] },
  ];
  for (const { url, expected } of watchPages) {
    test(`watch page ${url}`, () => {
      const doc = load("watch-page", url, OWN_PAGES);
      expect(collectCandidateUrls(doc).urls).toEqual([url]);
      expect(listEmbeds(collectCandidateUrls(doc))).toEqual([...expected]);
    });
  }
});

describe("collectCandidateUrls on the generic-embeds fixture page", () => {
  const doc = (): Document => load("generic-embeds", "http://localhost:4400/generic-embeds.html", OWN_PAGES);

  test("lists the synced embed first, then the allowed iframe and <video> sources once each; IP-literal, javascript:, http:, blob: and local are dropped", () => {
    expect(listEmbeds(collectCandidateUrls(doc()))).toEqual([
      EMBED,
      generic("https://videos.example.org/embed/42"),
      generic("https://cdn.example.org/clip.mp4"),
      generic("https://cdn.example.org/other.webm"),
    ]);
  });

  test("media holds iframe, <video src> and <video><source src>, resolved against the page; the page URL is not media", () => {
    const { media } = collectCandidateUrls(doc());
    expect(media).toContain("https://203.0.113.7/embed/42");
    expect(media).toContain("javascript:alert(1)");
    expect(media).toContain("https://cdn.example.org/other.webm");
    expect(media).toContain("http://localhost:4400/local.mp4");
    expect(media).not.toContain("http://localhost:4400/generic-embeds.html");
  });

  test("<embed> and <object> are synced candidates only, never generic media", () => {
    const window = new Window({ url: "https://news.example.org/", settings: { disableIframePageLoading: true } });
    window.document.write('<embed src="https://videos.example.org/a.swf"><object data="https://videos.example.org/b.pdf"></object>');
    const scanned = collectCandidateUrls(window.document as unknown as Document);
    expect(scanned.media).toEqual([]);
    expect(listEmbeds(scanned)).toEqual([]);
  });

  test("the non-allowlisted e2e page still lists nothing", () => {
    const page = load("non-allowlisted", "http://localhost:4400/non-allowlisted.html");
    expect(listEmbeds(collectCandidateUrls(page))).toEqual([]);
  });
});
