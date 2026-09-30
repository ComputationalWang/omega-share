import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

function csp(): Map<string, string[]> {
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (m?.[1] === undefined) throw new Error("no CSP meta in index.html");
  const out = new Map<string, string[]>();
  for (const d of m[1].split(";")) {
    const [name, ...values] = d.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe("index.html CSP (ADR 0011, ADR 0014 §5)", () => {
  test("scripts: self, the two YouTube API paths and the exact Twitch/Vimeo SDK files, never a whole host", () => {
    expect(csp().get("script-src")).toEqual([
      "'self'",
      "https://www.youtube.com/iframe_api",
      "https://www.youtube.com/s/player/",
      "https://player.twitch.tv/js/embed/v1.js",
      "https://player.vimeo.com/api/player.js",
    ]);
  });

  test("frames: the YouTube hosts plus the Twitch and Vimeo player hosts only", () => {
    expect(csp().get("frame-src")).toEqual([
      "https://www.youtube.com",
      "https://www.youtube-nocookie.com",
      "https://player.twitch.tv",
      "https://player.vimeo.com",
    ]);
  });

  test("the rest stays locked down", () => {
    const c = csp();
    expect(c.get("default-src")).toEqual(["'self'"]);
    expect(c.get("object-src")).toEqual(["'none'"]);
    expect(c.get("base-uri")).toEqual(["'none'"]);
    expect(c.get("form-action")).toEqual(["'none'"]);
  });
});
