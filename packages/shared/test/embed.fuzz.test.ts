import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { EmbedSchema, MAX_URL_LENGTH, canonicalizeEmbed, type Embed, type Provider } from "../src/index";

// Hostile embed URLs (threat model §6, §8 "Embed fuzz"). Whatever the input,
// canonicalizeEmbed returns null or an embed that re-parses under EmbedSchema and
// points at its provider's player host. It never throws.

const YT = "dQw4w9WgXcQ";

/** The only hosts an embed `url` may point at (ADR 0003, ADR 0014). */
const PLAYER_HOST: Readonly<Record<Provider, string>> = {
  youtube: "www.youtube.com",
  twitch: "player.twitch.tv",
  vimeo: "player.vimeo.com",
};

/** Every host a user may paste; an accepted input must parse to one of these. */
const INPUT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be",
  "twitch.tv", "www.twitch.tv", "m.twitch.tv", "player.twitch.tv",
  "vimeo.com", "www.vimeo.com", "player.vimeo.com",
]);

function inputHost(input: string): string | null {
  try {
    return new URL(input.trim()).hostname;
  } catch {
    return null;
  }
}

/** Returns a failure reason, or null if the invariant holds for `input`. */
function violation(input: string): string | null {
  let out: Embed | null;
  try {
    out = canonicalizeEmbed(input);
  } catch (e) {
    return `threw ${String(e)}`;
  }
  if (out === null) return null;
  if (!v.is(EmbedSchema, out)) return "output does not re-parse under EmbedSchema";
  const host = inputHost(input);
  if (host === null || !INPUT_HOSTS.has(host)) return `accepted input host ${String(host)}`;
  let url: URL;
  try {
    url = new URL(out.url);
  } catch {
    return "output url does not parse";
  }
  if (url.href !== out.url) return "output url is not in normal form";
  if (url.protocol !== "https:") return `output protocol ${url.protocol}`;
  if (url.username !== "" || url.password !== "" || url.port !== "") return "output has userinfo or port";
  if (url.hostname !== PLAYER_HOST[out.provider]) return `output host ${url.hostname} for ${out.provider}`;
  const again = canonicalizeEmbed(out.url);
  if (again === null || JSON.stringify(again) !== JSON.stringify(out)) return "output url does not re-canonicalize to itself";
  return null;
}

function expectInvariant(inputs: readonly string[]): void {
  const failures = inputs.flatMap((input) => {
    const why = violation(input);
    return why === null ? [] : [`${JSON.stringify(input)}: ${why}`];
  });
  expect(failures).toEqual([]);
}

/** Look-alikes and smuggling tricks that must never produce an embed. */
const HOSTILE_REJECTED: readonly string[] = [
  // IDN look-alikes: Cyrillic о / е / а, Greek ο, dotless ı
  `https://yоutube.com/watch?v=${YT}`,
  `https://www.yоutube.com/watch?v=${YT}`,
  `https://youtu.bе/${YT}`,
  `https://www.youtubе-nocookie.com/embed/${YT}`,
  `https://twitсh.tv/somechannel`,
  `https://player.twitсh.tv/?channel=somechannel`,
  `https://vimеo.com/76979871`,
  `https://player.vimео.com/video/76979871`,
  `https://yοutube.com/watch?v=${YT}`,
  `https://youtubе.com/watch?v=${YT}`,
  `https://www.youtube.cоm/watch?v=${YT}`,
  `https://yıutube.com/watch?v=${YT}`,
  // the same look-alikes already in punycode
  `https://xn--ytube-7ve.com/watch?v=${YT}`,
  `https://xn--youtube-2vh.com/watch?v=${YT}`,
  // trailing dots
  `https://youtube.com./watch?v=${YT}`,
  `https://www.youtube.com./embed/${YT}`,
  `https://youtu.be./${YT}`,
  `https://twitch.tv./somechannel`,
  `https://player.vimeo.com./video/76979871`,
  `https://youtube.com%2e/watch?v=${YT}`,
  // userinfo, including an allowlisted host used as the userinfo
  `https://user@youtube.com/watch?v=${YT}`,
  `https://user:pass@youtu.be/${YT}`,
  `https://:pass@www.youtube.com/embed/${YT}`,
  `https://youtube.com@evil.example/watch?v=${YT}`,
  `https://www.youtube.com%40evil.example/watch?v=${YT}`,
  `https://youtu.be@evil.example/${YT}`,
  `https://player.twitch.tv@evil.example/?channel=somechannel`,
  `https://vimeo.com:80@evil.example/76979871`,
  // non-default ports
  `https://youtube.com:8443/watch?v=${YT}`,
  `http://youtu.be:8080/${YT}`,
  `https://player.vimeo.com:444/video/76979871`,
  `https://twitch.tv:1/somechannel`,
  // backslashes that move the host
  `https://evil.example\\@youtube.com/watch?v=${YT}`,
  `https://evil.example\\.youtube.com/watch?v=${YT}`,
  `https://youtube.com\\@evil.example/watch?v=${YT}`,
  `https://youtube.com\\..\\evil.example/watch?v=${YT}`,
  // allowlisted name as a label, suffix, prefix, path, query or fragment of another host
  `https://youtube.com.evil.example/watch?v=${YT}`,
  `https://evil.example.youtube.com.evil.example/watch?v=${YT}`,
  `https://notyoutube.com/watch?v=${YT}`,
  `https://youtube.co/watch?v=${YT}`,
  `https://youtube.com-evil.example/watch?v=${YT}`,
  `https://youtu.be.evil.example/${YT}`,
  `https://evil-youtu.be/${YT}`,
  `https://player.twitch.tv.evil.example/?channel=somechannel`,
  `https://clips.twitch.tv/somechannel`,
  `https://evilvimeo.com/76979871`,
  `https://evil.example/youtube.com/watch?v=${YT}`,
  `https://evil.example/watch?v=${YT}&u=https://youtube.com/`,
  `https://evil.example/?next=https://youtu.be/${YT}`,
  `https://evil.example/#https://youtu.be/${YT}`,
  `https://www.google.com/url?q=https://youtu.be/${YT}`,
  // percent-encoded or dot-smuggled hosts that do not decode to an allowlisted host
  `https://youtube%2ecom.evil.example/watch?v=${YT}`,
  `https://youtube%252ecom/watch?v=${YT}`,
  `https://youtube%E3%80%82com.evil.example/watch?v=${YT}`,
  `https://youtube.com%2fwatch%3fv%3d${YT}@evil.example/`,
  `https://youtube.com%00.evil.example/watch?v=${YT}`,
  // raw IPs and host forms
  `https://142.250.72.14/watch?v=${YT}`,
  `https://0x8e.0xfa.0x48.0x0e/watch?v=${YT}`,
  `https://2398766094/watch?v=${YT}`,
  `https://[::1]/watch?v=${YT}`,
  `https://localhost/watch?v=${YT}`,
  // other schemes
  `javascript:alert(1)//https://youtu.be/${YT}`,
  `javascript://youtube.com/%0aalert(1)`,
  `data:text/html,<iframe src="https://youtu.be/${YT}">`,
  `blob:https://www.youtube.com/0b1c2d3e-0000-4000-8000-000000000000`,
  `file:///youtube.com/watch?v=${YT}`,
  `ftp://youtube.com/watch?v=${YT}`,
  `ws://youtube.com/watch?v=${YT}`,
  `view-source:https://youtu.be/${YT}`,
  `//youtube.com/watch?v=${YT}`,
  `youtube.com/watch?v=${YT}`,
  `https:/\\evil.example/youtu.be/${YT}`,
  // hostile ids and paths on an allowlisted host
  `https://youtu.be/${YT}%00`,
  `https://youtu.be/${YT}/`,
  `https://youtu.be/../../evil.example/${YT}`,
  `https://www.youtube.com/embed/${YT}/../../evil`,
  `https://www.youtube.com/embed/..%2f..%2fevil%2f${YT}`,
  `https://www.youtube.com/embed/${YT}%2F`,
  `https://www.youtube.com/watch?v=${YT}&v=${YT}`,
  `https://www.youtube.com/watch?v=${YT}%26x`,
  `https://www.youtube.com/watch?v=<script>x</a>`,
  `https://www.youtube.com/watch?v=javascript:`,
  `https://www.youtube.com/watch?v=dQw4w9WgXc%22`,
  `https://www.youtube.com/watch?v=dQw4w9WgXcQ%20`,
  `https://www.youtube.com/watch?v=dQw4w9WgXсQ`,
  `https://www.youtube.com/watch/?v=${YT}`,
  `https://www.youtube.com/WATCH?v=${YT}`,
  `https://twitch.tv/%2e%2e`,
  `https://twitch.tv/some%2fchannel`,
  `https://twitch.tv/somechannel/../videos`,
  `https://twitch.tv/javascript:alert(1)`,
  `https://twitch.tv/somechаnnel`,
  `https://twitch.tv/videos/0x10`,
  `https://twitch.tv/videos/1e9`,
  `https://player.twitch.tv/?channel=a%26parent%3Devil.example`,
  `https://player.twitch.tv/?channel=a&channel=b`,
  `https://player.twitch.tv/?video=v12%2345`,
  `https://player.twitch.tv/?channel=a&video=v123`,
  `https://vimeo.com/76979871/ABC%26x`,
  `https://vimeo.com/76979871/..%2f..`,
  `https://vimeo.com/0x76979871`,
  `https://vimeo.com/７６９７９８７１`,
  `https://player.vimeo.com/video/76979871?h=abc123&h=def456`,
  `https://player.vimeo.com/video/76979871?h=abc123%26autoplay%3D1`,
  `https://player.vimeo.com/video/76979871/`,
  // size and junk
  `https://youtu.be/${YT}?${"a".repeat(MAX_URL_LENGTH)}`,
  "",
  " ",
  "\u0000",
  "https://",
  "https://?v=x",
  "https://‮eb.utuoy/" + YT,
  "https://\uD800.com/" + YT,
];

/**
 * Tricks the WHATWG URL parser normalizes to an allowlisted host. Accepting them is
 * correct: the browser would load that same host. Each maps to its known-good embed.
 */
const NORMALIZED_ACCEPTED: readonly (readonly [string, Embed])[] = [
  [`https://YouTube.COM/watch?v=${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://YOUTU.BE/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`HTTPS://WWW.YOUTUBE-NOCOOKIE.COM/embed/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://www%2eyoutube%2ecom/watch?v=${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://youtu%2Ebe/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://ｙｏｕｔｕ.ｂｅ/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://youtu。be/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https:\\\\youtu.be\\${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://youtube.com:443/watch?v=${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`http://youtu.be:80/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://you\ttu.be/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://youtu.be/%2e%2e/${YT}`, { provider: "youtube", videoId: YT, url: `https://www.youtube.com/embed/${YT}` }],
  [`https://Twitch.TV/SomeChannel`, { provider: "twitch", kind: "live", channel: "somechannel", url: "https://player.twitch.tv/?channel=somechannel" }],
  [`https://PLAYER.twitch.tv/?video=V123`, { provider: "twitch", kind: "vod", videoId: "123", url: "https://player.twitch.tv/?video=v123" }],
  [`https://VIMEO.com/76979871/ABC123`, { provider: "vimeo", videoId: "76979871", hash: "abc123", url: "https://player.vimeo.com/video/76979871?h=abc123" }],
  [`https://player%2evimeo%2ecom/video/76979871`, { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" }],
];

describe("embed fuzz: hostile corpus", () => {
  for (const input of HOSTILE_REJECTED) {
    test(`rejects ${JSON.stringify(input.length > 120 ? `${input.slice(0, 120)}…` : input)}`, () => {
      expect(canonicalizeEmbed(input)).toBeNull();
    });
  }

  for (const [input, embed] of NORMALIZED_ACCEPTED) {
    test(`normalizes ${JSON.stringify(input)}`, () => {
      expect(canonicalizeEmbed(input)).toEqual(embed);
    });
  }

  test("the invariant holds for the whole corpus", () => {
    expectInvariant([...HOSTILE_REJECTED, ...NORMALIZED_ACCEPTED.map(([input]) => input)]);
  });
});

/** mulberry32: small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALID: readonly string[] = [
  `https://www.youtube.com/watch?v=${YT}&t=42s`,
  `https://youtu.be/${YT}`,
  `https://m.youtube.com/watch?v=${YT}`,
  `https://www.youtube-nocookie.com/embed/${YT}`,
  "https://www.twitch.tv/somechannel",
  "https://www.twitch.tv/videos/123456789",
  "https://player.twitch.tv/?channel=somechannel&parent=example.org",
  "https://player.twitch.tv/?video=v123456789",
  "https://vimeo.com/76979871",
  "https://vimeo.com/76979871/abc123def0",
  "https://vimeo.com/channels/staffpicks/76979871",
  "https://player.vimeo.com/video/76979871?h=abc123",
];

/** Characters that break URL parsing or smuggle hosts, plus look-alikes. */
const HOSTILE_CHARS = [
  ".", "/", "\\", "@", ":", "?", "#", "&", "=", "%", "%2e", "%2E", "%2f", "%40", "%00", "%25",
  " ", "\t", "\n", "\u0000", "­", "​", "‍", "‮", "﻿", "\uD800",
  "о", "е", "а", "с", "ο", "ı", "ｏ", "．", "。", "｡", "ß", "İ", "x", "X", "0", "-", "_", "~",
];

const SEED = 0x0ae226;
const MUTANTS_PER_URL = 1500;

function mutate(url: string, rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => {
    const x = xs[Math.floor(rand() * xs.length)];
    if (x === undefined) throw new Error("empty pick");
    return x;
  };
  let s = url;
  const edits = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < edits; i++) {
    // Bias edits toward the authority, where host smuggling lives.
    const hostEnd = s.indexOf("/", s.indexOf("//") + 2);
    const inHost = rand() < 0.5 && hostEnd > 8;
    const at = inHost ? 8 + Math.floor(rand() * (hostEnd - 8 + 1)) : Math.floor(rand() * (s.length + 1));
    const op = Math.floor(rand() * 6);
    if (op === 0) s = s.slice(0, at) + pick(HOSTILE_CHARS) + s.slice(at);
    else if (op === 1) s = s.slice(0, at) + s.slice(at + 1);
    else if (op === 2) s = s.slice(0, at) + pick(HOSTILE_CHARS) + s.slice(at + 1);
    else if (op === 3) {
      const c = s.charAt(at);
      s = s.slice(0, at) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + s.slice(at + 1);
    } else if (op === 4) {
      const c = s.charCodeAt(at);
      if (!Number.isNaN(c) && c < 0x80) s = `${s.slice(0, at)}%${c.toString(16).padStart(2, "0")}${s.slice(at + 1)}`;
    } else s = s.slice(0, at) + pick(["evil.example", "@evil.example", ".evil.example", ":8080", "..", "//", "xn--"]) + s.slice(at);
  }
  return s;
}

describe("embed fuzz: seeded mutations of valid urls", () => {
  const rand = prng(SEED);
  const mutants = VALID.flatMap((url) => Array.from({ length: MUTANTS_PER_URL }, () => mutate(url, rand)));

  test("every seed url is accepted unmutated", () => {
    for (const url of VALID) expect(canonicalizeEmbed(url)).not.toBeNull();
  });

  test(`the invariant holds for ${String(VALID.length * MUTANTS_PER_URL)} mutants (seed ${SEED.toString(16)})`, () => {
    expectInvariant(mutants);
  });

  test("the mutants exercise both outcomes", () => {
    const accepted = mutants.filter((m) => canonicalizeEmbed(m) !== null).length;
    expect(accepted).toBeGreaterThan(mutants.length / 20);
    expect(accepted).toBeLessThan(mutants.length);
  });
});
