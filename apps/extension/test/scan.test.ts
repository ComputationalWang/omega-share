import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Embed } from "@omega/shared";
import { Window } from "happy-dom";
import { listEmbeds } from "../src/embeds";
import { collectCandidateUrls } from "../src/scan";

const PAGES = join(import.meta.dirname, "../../../e2e/fixtures/pages");

function load(name: string, url: string): Document {
  const window = new Window({
    url,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  window.document.write(readFileSync(join(PAGES, `${name}.html`), "utf8"));
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
