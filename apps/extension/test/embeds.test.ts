import { describe, expect, test } from "bun:test";
import type { Embed } from "@omega/shared";
import { listEmbeds, scanTab } from "../src/embeds";

const A = "aqz-KE-bpKQ";
const B = "dQw4w9WgXcQ";
const embed = (videoId: string): Embed => ({ provider: "youtube", videoId, url: `https://www.youtube.com/embed/${videoId}` });

describe("listEmbeds (scan result → canonical list)", () => {
  const cases: readonly { name: string; scan: unknown; expected: readonly Embed[] }[] = [
    { name: "watch page URL", scan: [`https://www.youtube.com/watch?v=${A}`], expected: [embed(A)] },
    { name: "embed iframe src", scan: ["https://example.com/post", `https://www.youtube.com/embed/${A}`], expected: [embed(A)] },
    { name: "nocookie + short link", scan: [`https://www.youtube-nocookie.com/embed/${A}`, `https://youtu.be/${B}`], expected: [embed(A), embed(B)] },
    {
      name: "dedupes the same video in different URL forms, keeping first-seen order",
      scan: [`https://www.youtube.com/watch?v=${B}`, `https://www.youtube.com/embed/${A}?autoplay=1`, `https://youtu.be/${B}?t=3`, `https://www.youtube.com/embed/${A}`],
      expected: [embed(B), embed(A)],
    },
    {
      name: "drops everything off the allowlist",
      scan: [
        "https://player.example.net/embed/abc123",
        `https://www.youtube.com.evil.example/embed/${A}`,
        `https://evil.example/www.youtube.com/embed/${A}`,
        "javascript:alert(1)",
        "data:text/html,<p>hi</p>",
        "",
      ],
      expected: [],
    },
    { name: "empty scan", scan: [], expected: [] },
    { name: "scan failed (undefined)", scan: undefined, expected: [] },
    { name: "not an array", scan: { url: `https://youtu.be/${A}` }, expected: [] },
    { name: "non-string entries are skipped", scan: [42, null, `https://youtu.be/${A}`], expected: [embed(A)] },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(listEmbeds(c.scan)).toEqual([...c.expected]);
    });
  }

  test("caps the number of candidates it looks at", () => {
    const junk = Array.from({ length: 5000 }, (_, i) => `https://example.com/${String(i)}`);
    expect(listEmbeds([...junk, `https://youtu.be/${A}`])).toEqual([]);
  });
});

describe("scanTab", () => {
  const WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
  const EMBED_URL = "https://www.youtube.com/embed/aqz-KE-bpKQ";

  test("lists the embeds from the top frame's result", async () => {
    const r = await scanTab(() => Promise.resolve([{ result: [WATCH] }]));
    expect(r).toEqual({ kind: "embeds", embeds: [{ provider: "youtube", videoId: "aqz-KE-bpKQ", url: EMBED_URL }] });
  });

  test("a readable page with nothing supported is an empty list", async () => {
    expect(await scanTab(() => Promise.resolve([{ result: ["https://example.com/"] }]))).toEqual({ kind: "embeds", embeds: [] });
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
