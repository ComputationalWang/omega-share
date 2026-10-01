import { describe, expect, test } from "bun:test";
import type { AnyEmbed, Embed, GenericEmbed } from "@omega/shared";
import { listEmbeds, scanTab } from "../src/embeds";

const A = "aqz-KE-bpKQ";
const B = "dQw4w9WgXcQ";
const embed = (videoId: string): Embed => ({ provider: "youtube", videoId, url: `https://www.youtube.com/embed/${videoId}` });
const generic = (url: string): GenericEmbed => ({ provider: "generic", host: new URL(url).hostname, url });
/** A page scan: `urls` feed the synced tier, `media` (iframe and `<video>` sources) the generic tier. */
const scan = (urls: readonly string[], media: readonly string[] = []): unknown => ({ urls, media });

describe("listEmbeds (scan result → canonical list)", () => {
  const cases: readonly { name: string; scan: unknown; expected: readonly AnyEmbed[] }[] = [
    { name: "watch page URL", scan: scan([`https://www.youtube.com/watch?v=${A}`]), expected: [embed(A)] },
    { name: "embed iframe src", scan: scan(["https://example.com/post", `https://www.youtube.com/embed/${A}`]), expected: [embed(A)] },
    { name: "nocookie + short link", scan: scan([`https://www.youtube-nocookie.com/embed/${A}`, `https://youtu.be/${B}`]), expected: [embed(A), embed(B)] },
    {
      name: "dedupes the same video in different URL forms, keeping first-seen order",
      scan: scan([`https://www.youtube.com/watch?v=${B}`, `https://www.youtube.com/embed/${A}?autoplay=1`, `https://youtu.be/${B}?t=3`, `https://www.youtube.com/embed/${A}`]),
      expected: [embed(B), embed(A)],
    },
    {
      name: "drops everything off the allowlist",
      scan: scan([
        "https://player.example.test/embed/abc123",
        `https://www.youtube.com.evil.example/embed/${A}`,
        `https://evil.example/www.youtube.com/embed/${A}`,
        "javascript:alert(1)",
        "data:text/html,<p>hi</p>",
        "",
      ]),
      expected: [],
    },
    { name: "empty scan", scan: scan([]), expected: [] },
    { name: "scan failed (undefined)", scan: undefined, expected: [] },
    { name: "an array (old scan shape) is not a scan", scan: [`https://youtu.be/${A}`], expected: [] },
    { name: "urls not an array", scan: { urls: `https://youtu.be/${A}`, media: [] }, expected: [] },
    { name: "non-string entries are skipped", scan: { urls: [42, null, `https://youtu.be/${A}`], media: [7, "https://videos.example.org/e/1"] }, expected: [embed(A), generic("https://videos.example.org/e/1")] },
    { name: "missing media is no generic embeds", scan: { urls: [`https://youtu.be/${A}`] }, expected: [embed(A)] },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(listEmbeds(c.scan)).toEqual([...c.expected]);
    });
  }

  test("caps the number of candidates it looks at", () => {
    const junk = Array.from({ length: 5000 }, (_, i) => `https://example.test/${String(i)}`);
    expect(listEmbeds(scan([...junk, `https://youtu.be/${A}`], [...junk, "https://videos.example.org/e/1"]))).toEqual([]);
  });
});

describe("listEmbeds: other https embeds (generic tier, not synced)", () => {
  const cases: readonly { name: string; media: readonly string[]; urls?: readonly string[]; expected: readonly AnyEmbed[] }[] = [
    { name: "a public https iframe or <video> source is listed", media: ["https://videos.example.org/embed/42", "https://cdn.example.org/clip.mp4"], expected: [generic("https://videos.example.org/embed/42"), generic("https://cdn.example.org/clip.mp4")] },
    { name: "canonical url and punycode host", media: ["https://VIDEOS.Bücher.example.org/e/1"], expected: [{ provider: "generic", host: "videos.xn--bcher-kva.example.org", url: "https://videos.xn--bcher-kva.example.org/e/1" }] },
    { name: "dedupes by canonical url", media: ["https://videos.example.org/e/1", "https://VIDEOS.example.org/e/1"], expected: [generic("https://videos.example.org/e/1")] },
    {
      name: "synced embeds come first, in their own order",
      media: ["https://videos.example.org/e/1", `https://www.youtube.com/embed/${A}`],
      urls: ["https://news.example.org/post", `https://www.youtube.com/embed/${A}`, `https://youtu.be/${B}`],
      expected: [embed(A), embed(B), generic("https://videos.example.org/e/1")],
    },
    { name: "a synced provider's URL never shows twice (never as generic)", media: [`https://www.youtube.com/embed/${A}`, "https://clips.twitch.tv/Slug", "https://vimeo.com/event/1"], urls: [`https://www.youtube.com/embed/${A}`], expected: [embed(A)] },
    { name: "the page URL itself is not a generic embed", media: [], urls: ["https://news.example.org/post"], expected: [] },
    {
      name: "drops what the shared validator rejects",
      media: [
        "https://203.0.113.7/embed/42",
        "https://[2001:db8::1]/embed/42",
        "javascript:alert(1)",
        "data:text/html,<p>hi</p>",
        "blob:https://videos.example.org/00000000-0000-0000-0000-000000000000",
        "http://videos.example.org/embed/7",
        "https://localhost/embed/1",
        "https://user:pw@videos.example.org/embed/1",
        "https://videos.example.org:8443/embed/1",
        "https://player.example.test/embed/abc123",
        "not a url",
      ],
      expected: [],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(listEmbeds(scan(c.urls ?? [], c.media))).toEqual([...c.expected]);
    });
  }
});

describe("scanTab", () => {
  const WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
  const EMBED_URL = "https://www.youtube.com/embed/aqz-KE-bpKQ";

  test("lists the embeds from the top frame's result", async () => {
    const r = await scanTab(() => Promise.resolve([{ result: scan([WATCH], ["https://videos.example.org/e/1"]) }]));
    expect(r).toEqual({ kind: "embeds", embeds: [{ provider: "youtube", videoId: "aqz-KE-bpKQ", url: EMBED_URL }, generic("https://videos.example.org/e/1")] });
  });

  test("a readable page with nothing supported is an empty list", async () => {
    expect(await scanTab(() => Promise.resolve([{ result: scan(["https://example.com/"]) }]))).toEqual({ kind: "embeds", embeds: [] });
  });

  test("executeScript rejecting (chrome://, no activeTab) means the tab is unreadable", async () => {
    expect(await scanTab(() => Promise.reject(new Error("Cannot access a chrome:// URL")))).toEqual({ kind: "unreadable" });
  });

  test("a frame error means the tab is unreadable", async () => {
    expect(await scanTab(() => Promise.resolve([{ error: new Error("boom") }]))).toEqual({ kind: "unreadable" });
  });

  test("no injection results means the tab is unreadable", async () => {
    expect(await scanTab(() => Promise.resolve([]))).toEqual({ kind: "unreadable" });
  });
});
