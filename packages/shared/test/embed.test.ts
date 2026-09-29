import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { EmbedSchema, canonicalizeEmbed } from "../src/index";

const ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/embed/${ID}`;

describe("canonicalizeEmbed — allowed", () => {
  const allowed: readonly string[] = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://www.youtube.com/watch?feature=share&v=${ID}`,
    `https://WWW.YouTube.COM/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=10`,
    `https://www.youtube.com/embed/${ID}`,
    `https://youtube.com/embed/${ID}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://youtube-nocookie.com/embed/${ID}`,
    `  https://youtu.be/${ID}  `,
    `https://www.youtube.com/watch?v=${ID}#comments`,
  ];

  for (const input of allowed) {
    test(input, () => {
      expect(canonicalizeEmbed(input)).toEqual({ provider: "youtube", videoId: ID, url: CANONICAL });
    });
  }

  test("keeps the id's case and _ - characters", () => {
    expect(canonicalizeEmbed("https://youtu.be/a_B-c9D_e-F")?.url).toBe(
      "https://www.youtube.com/embed/a_B-c9D_e-F",
    );
  });
});

describe("canonicalizeEmbed — rejected", () => {
  const rejected: readonly [string, string][] = [
    ["empty", ""],
    ["not a url", "hello world"],
    ["bare id", ID],
    ["javascript scheme", `javascript:alert(1)//https://youtu.be/${ID}`],
    ["data scheme", `data:text/html,<iframe src="https://youtu.be/${ID}">`],
    ["ftp scheme", `ftp://youtube.com/watch?v=${ID}`],
    ["protocol-relative", `//www.youtube.com/watch?v=${ID}`],
    ["credentials", `https://user:pass@www.youtube.com/watch?v=${ID}`],
    ["username only", `https://evil@youtube.com/watch?v=${ID}`],
    ["non-default port", `https://www.youtube.com:8443/watch?v=${ID}`],
    ["other host", `https://vimeo.com/${ID}`],
    ["lookalike host suffix", `https://youtube.com.evil.example/watch?v=${ID}`],
    ["lookalike host prefix", `https://evilyoutube.com/watch?v=${ID}`],
    ["subdomain not allowed", `https://music.youtube.com/watch?v=${ID}`],
    ["trailing-dot host", `https://youtube.com./watch?v=${ID}`],
    ["backslash host trick", `https:\\\\evil.example\\www.youtube.com/watch?v=${ID}`],
    ["ip host", `https://142.250.1.1/watch?v=${ID}`],
    ["id too short", "https://youtu.be/dQw4w9WgXc"],
    ["id too long", "https://youtu.be/dQw4w9WgXcQQ"],
    ["id bad char", "https://youtu.be/dQw4w9WgX.Q"],
    ["id encoded", "https://youtu.be/dQw4w9WgX%51"],
    ["watch without v", "https://www.youtube.com/watch?list=PL123"],
    ["watch with empty v", "https://www.youtube.com/watch?v="],
    ["watch with duplicate v", `https://www.youtube.com/watch?v=${ID}&v=aaaaaaaaaaa`],
    ["watch bad id", "https://www.youtube.com/watch?v=<script>xx"],
    ["youtu.be with extra path", `https://youtu.be/${ID}/extra`],
    ["youtu.be root", "https://youtu.be/"],
    ["youtu.be watch path", `https://youtu.be/watch?v=${ID}`],
    ["embed with extra path", `https://www.youtube.com/embed/${ID}/x`],
    ["embed trailing slash", `https://www.youtube.com/embed/${ID}/`],
    ["embed missing id", "https://www.youtube.com/embed/"],
    ["nocookie watch path", `https://www.youtube-nocookie.com/watch?v=${ID}`],
    ["channel page", "https://www.youtube.com/@somechannel"],
    ["shorts not yet supported", `https://www.youtube.com/shorts/${ID}`],
    ["live_stream slug", "https://www.youtube.com/embed/live_stream?channel=UC123"],
    ["playlist embed", "https://www.youtube.com/embed/videoseries?list=PL123"],
    ["over length cap", `https://www.youtube.com/watch?v=${ID}&x=${"a".repeat(3000)}`],
  ];

  for (const [name, input] of rejected) {
    test(name, () => {
      expect(canonicalizeEmbed(input)).toBeNull();
    });
  }
});

describe("EmbedSchema", () => {
  test("accepts a canonical embed", () => {
    expect(v.is(EmbedSchema, { provider: "youtube", videoId: ID, url: CANONICAL })).toBe(true);
  });

  test("accepts whatever canonicalizeEmbed returns", () => {
    expect(v.is(EmbedSchema, canonicalizeEmbed(`https://youtu.be/${ID}`))).toBe(true);
  });

  const invalid: readonly [string, unknown][] = [
    ["unknown provider", { provider: "vimeo", videoId: ID, url: CANONICAL }],
    ["bad id", { provider: "youtube", videoId: "nope", url: "https://www.youtube.com/embed/nope" }],
    ["url not canonical", { provider: "youtube", videoId: ID, url: `https://youtu.be/${ID}` }],
    ["url for another id", { provider: "youtube", videoId: ID, url: "https://www.youtube.com/embed/aaaaaaaaaaa" }],
    ["arbitrary iframe url", { provider: "youtube", videoId: ID, url: "https://evil.example/" }],
    ["reserved id", { provider: "youtube", videoId: "videoseries", url: "https://www.youtube.com/embed/videoseries" }],
    ["missing url", { provider: "youtube", videoId: ID }],
    ["null", null],
  ];

  for (const [name, input] of invalid) {
    test(`rejects ${name}`, () => {
      expect(v.is(EmbedSchema, input)).toBe(false);
    });
  }
});
