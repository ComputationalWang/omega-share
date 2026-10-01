import { describe, expect, test } from "bun:test";
// The default production policy: GENERIC_EMBEDS=on frames `https:` (ADR 0024 §4).
import { CSP_WITH_GENERIC as SERVER_CSP } from "../../server/src/headers";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

function csp(): Map<string, string[]> {
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (m?.[1] === undefined) throw new Error("no CSP meta in index.html");
  return parse(m[1]);
}

function parse(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of policy.split(";")) {
    const [name, ...values] = d.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe("index.html CSP (ADR 0011, ADR 0014 §5, ADR 0024 §4)", () => {
  test("scripts: self, the two YouTube API paths and the exact Twitch/Vimeo SDK files, never a whole host", () => {
    expect(csp().get("script-src")).toEqual([
      "'self'",
      "https://www.youtube.com/iframe_api",
      "https://www.youtube.com/s/player/",
      "https://player.twitch.tv/js/embed/v1.js",
      "https://player.vimeo.com/api/player.js",
    ]);
  });

  test("frames: youtube-nocookie, the Twitch and Vimeo player hosts, and https: for the generic tier", () => {
    expect(csp().get("frame-src")).toEqual([
      "https://www.youtube-nocookie.com",
      "https://player.twitch.tv",
      "https://player.vimeo.com",
      "https:",
    ]);
  });

  test("styles, images, workers and connections are pinned", () => {
    const c = csp();
    expect(c.get("style-src")).toEqual(["'self'"]);
    expect(c.get("img-src")).toEqual(["'self'", "data:"]);
    expect(c.get("worker-src")).toEqual(["'self'"]);
    expect(c.get("connect-src")).toEqual([
      "'self'",
      "ws://localhost:8787",
      "http://localhost:8787",
      "ws://localhost:5173",
    ]);
  });

  test("no unsafe keywords, blob: or scheme-wide sources anywhere (https: only in frame-src); no frame-ancestors in a meta", () => {
    const c = csp();
    const all = [...c.entries()].flatMap(([name, values]) => (name === "frame-src" ? values.filter((v) => v !== "https:") : values));
    for (const banned of ["'unsafe-inline'", "'unsafe-eval'", "blob:", "ws:", "wss:", "http:", "https:", "*"]) {
      expect(all).not.toContain(banned);
    }
    expect(c.has("frame-ancestors")).toBe(false);
  });

  test("the rest stays locked down", () => {
    const c = csp();
    expect(c.get("default-src")).toEqual(["'self'"]);
    expect(c.get("object-src")).toEqual(["'none'"]);
    expect(c.get("base-uri")).toEqual(["'none'"]);
    expect(c.get("form-action")).toEqual(["'none'"]);
  });
});

describe("index.html CSP vs the server header (apps/server/src/headers.ts is the source of truth)", () => {
  const DEV_ORIGINS = ["ws://localhost:8787", "http://localhost:8787", "ws://localhost:5173"];
  const TT_DIRECTIVES = ["require-trusted-types-for", "trusted-types"];

  test("Trusted Types live in the header only; the dev-only meta sets none (the Vite dev client hits TT sinks)", () => {
    const meta = csp();
    for (const name of TT_DIRECTIVES) expect([name, meta.has(name)]).toEqual([name, false]);
  });

  test("the meta allows everything the header allows, so the two intersect to the header in production", () => {
    const meta = csp();
    for (const [name, values] of parse(SERVER_CSP)) {
      // Ignored in a meta (and Chrome logs an error for it); the header alone enforces it.
      if (name === "frame-ancestors") continue;
      // Restrictions, not allowances (ADR 0025): a meta without them is the looser side.
      if (TT_DIRECTIVES.includes(name)) continue;
      const have = meta.get(name) ?? [];
      expect([name, values.filter((v) => !have.includes(v))]).toEqual([name, []]);
    }
  });

  test("the meta adds only the dev origins, and no directive the header lacks", () => {
    const server = parse(SERVER_CSP);
    const extra: string[] = [];
    for (const [name, values] of csp()) {
      const allowed = server.get(name);
      expect([name, allowed !== undefined]).toEqual([name, true]);
      extra.push(...values.filter((v) => !(allowed ?? []).includes(v)));
    }
    expect(extra.sort()).toEqual([...DEV_ORIGINS].sort());
  });
});
