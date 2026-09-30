import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Embed } from "@omega/shared";
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
    expect(collectCandidateUrls(doc)).toContain("https://www.youtube.com/embed/aqz-KE-bpKQ");
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([EMBED]);
  });

  test("watch-url: the page URL itself is the video", () => {
    const doc = load("watch-url", "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    expect(collectCandidateUrls(doc)[0]).toBe("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([EMBED]);
  });

  test("non-allowlisted: nothing survives canonicalization", () => {
    const doc = load("non-allowlisted", "http://localhost:4400/non-allowlisted.html");
    expect(collectCandidateUrls(doc).length).toBeGreaterThan(1);
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([]);
  });

  test("no-video: only the page URL", () => {
    const doc = load("no-video", "http://localhost:4400/no-video.html");
    expect(collectCandidateUrls(doc)).toEqual(["http://localhost:4400/no-video.html"]);
  });

  test("also reads <embed src> and <object data>, resolved against the page", () => {
    const window = new Window({ url: "https://www.youtube.com/", settings: { disableIframePageLoading: true } });
    window.document.write('<embed src="/embed/aqz-KE-bpKQ"><object data="https://youtu.be/dQw4w9WgXcQ"></object>');
    const urls = collectCandidateUrls(window.document as unknown as Document);
    expect(urls).toContain("https://www.youtube.com/embed/aqz-KE-bpKQ");
    expect(urls).toContain("https://youtu.be/dQw4w9WgXcQ");
  });
});

const TWITCH_LIVE: Embed = { provider: "twitch", kind: "live", channel: "somechannel", url: "https://player.twitch.tv/?channel=somechannel" };
const TWITCH_VOD: Embed = { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" };
const VIMEO: Embed = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
const VIMEO_UNLISTED: Embed = { ...VIMEO, hash: "8272103f6e", url: "https://player.vimeo.com/video/76979871?h=8272103f6e" };

describe("collectCandidateUrls on Twitch + Vimeo fixture pages", () => {
  test("providers-embed: lists YouTube, Twitch live, Twitch VOD and Vimeo once each, in page order", () => {
    const doc = load("providers-embed", "http://localhost:4400/providers-embed.html", OWN_PAGES);
    expect(listEmbeds(collectCandidateUrls(doc))).toEqual([EMBED, TWITCH_LIVE, TWITCH_VOD, VIMEO_UNLISTED]);
  });

  test("providers-embed: clips, collections, live events and lookalike hosts are all found but none are listed", () => {
    const doc = load("providers-embed", "http://localhost:4400/providers-embed.html", OWN_PAGES);
    const rejected = [...doc.querySelectorAll("iframe")].slice(5).map((f) => new URL(f.getAttribute("src") ?? "", doc.baseURI).href);
    expect(rejected).toHaveLength(10);
    const found = collectCandidateUrls(doc);
    for (const url of rejected) {
      expect(found).toContain(url);
      expect(listEmbeds([url])).toEqual([]);
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
      expect(collectCandidateUrls(doc)).toEqual([url]);
      expect(listEmbeds(collectCandidateUrls(doc))).toEqual([...expected]);
    });
  }
});
