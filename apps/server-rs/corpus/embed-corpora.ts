// Embed corpora (OME-1156): URL canonicalizers, the stored-embed schemas, capabilities and the server's
// embed policy. Kept apart from corpora.ts to keep that file's merge surface small. Inputs hold no lone
// surrogates (PORTING.md: an allowed disagreement), so every input survives a JSON round trip.
import * as v from "valibot";
import {
  AnyEmbedSchema,
  MAX_GENERIC_EMBED_URL_LENGTH,
  MAX_URL_LENGTH,
  canonicalizeAnyEmbed,
  canonicalizeEmbed,
  canonicalizeGenericEmbed,
  playbackCaps,
  type AnyEmbed,
  type Embed,
} from "@omega/shared";
import { EmbedPolicy } from "../../server/src/embed-policy";
import { rawEmbedCorpus } from "./embed-raw-corpus";
import type { Case, Corpus } from "./corpora";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const clean = (xs: readonly string[]): string[] => [...new Set(xs.filter((s) => !LONE_SURROGATE.test(s)))];

const stringify = (x: unknown): string | null => (x === null ? null : JSON.stringify(x));
const decide = <I,>(inputs: readonly I[], run: (input: I) => unknown): Case[] =>
  inputs.map((input) => {
    const output = stringify(run(input));
    return output === null ? { input, ok: false } : { input, ok: true, output };
  });

// ---------------------------------------------------------------- synced URL shapes

const YT = "dQw4w9WgXcQ";
const YT_HOSTS = [
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "gaming.youtube.com", "youtu.be", "www.youtu.be",
  "youtube-nocookie.com", "www.youtube-nocookie.com", "m.youtube-nocookie.com", "WWW.YouTube.COM", "YOUTU.BE", "youtube.com.",
  "www.youtube.com.", "youtu.be.", "youtube.com.evil.example", "notyoutube.com", "youtube.co", "xn--ytube-7ve.com",
  "ｙｏｕｔｕ.ｂｅ", "youtu。be", "you\ttu.be", "www%2eyoutube%2ecom", "youtube.com:443", "youtube.com:80", "youtube.com:8443",
  "user@youtube.com", "user:pw@youtu.be", ":@youtu.be", "142.250.1.1", "[::1]", "yоutube.com", "www.youtube.com\\@evil.example",
];
const YT_PATHS = [
  `/watch?v=${YT}`, `/watch?v=${YT}&t=42s&list=PL1`, `/watch?feature=share&v=${YT}`, `/watch?v=${YT}&v=${YT}`, `/watch?v=${YT}&v=aaaaaaaaaaa`,
  `/watch?v=${YT}#t=1`, `/watch/?v=${YT}`, `/WATCH?v=${YT}`, `/watch?V=${YT}`, `/watch?v=${YT}%20`, `/watch?v=${YT.slice(0, 10)}`,
  `/watch?v=${YT}Q`, "/watch?v=", "/watch", "/watch?list=PL1", `/watch?%76=${YT}`, `/watch?v%3D=${YT}`, `/watch?v=d%51w4w9WgXcQ`,
  `/watch?v=dQw4w9WgX+Q`, `/watch?v=dQw4w9WgX%2BQ`, `/watch?v=dQw4w9WgX.Q`, `/watch?v=videoseries`, `/watch?v=live_stream`,
  `/watch?v=a_B-c9D_e-F`, `/watch?v=dQw4w9WgXс`, `/watch?v=${YT}&x=%ff`, `/watch?v=%ff${YT}`, `/watch?v=${YT}%00`,
  `/watch;v=${YT}`, `//watch?v=${YT}`, `/./watch?v=${YT}`, `/x/../watch?v=${YT}`,
  `/${YT}`, `/${YT}?t=10`, `/${YT}/`, `/${YT}/extra`, `/${YT}%00`, `/%64Qw4w9WgXcQ`, `/dQw4w9WgX%51`, `/../${YT}`, `/%2e%2e/${YT}`, "/", "",
  `/watch/${YT}`, `/embed/${YT}`, `/embed/${YT}?autoplay=1`, `/embed/${YT}/`, `/embed/${YT}/x`, "/embed/", "/embed", "/embed/videoseries?list=PL1",
  "/embed/live_stream?channel=UC1", `/embed/${YT}%2F`, `/embed/..%2f${YT}`, `/EMBED/${YT}`, `/shorts/${YT}`, `/live/${YT}`, `/v/${YT}`,
  `/e/${YT}`, "/@somechannel", "/playlist?list=PL1", `/embed/${"a".repeat(11)}`, `/embed/${"a".repeat(10)}`, `/embed/${"a".repeat(12)}`,
  `/embed/a_B-c9D_e-F`, `/embed/${YT.toLowerCase()}`, `/embed/${YT}#frag`, `/embed/${YT}?`, `/embed/${YT}#`,
];
const SCHEMES = ["https://", "http://", "HTTPS://", "Http://", "ftp://", "//", "", "https:/", "https:\\\\", "https:/\\", "javascript:", "wss://"];

const TW_HOSTS = [
  "twitch.tv", "www.twitch.tv", "m.twitch.tv", "player.twitch.tv", "clips.twitch.tv", "dashboard.twitch.tv", "WWW.Twitch.TV", "twitch.tv.",
  "player.twitch.tv.", "eviltwitch.tv", "twitch.tv.evil.example", "twitсh.tv", "twitch.tv:1", "twitch.tv:443", "u@twitch.tv", "player.twitch.tv:8080",
  "play%65r.twitch.tv", "PLAYER.twitch.tv",
];
const TW_PATHS = [
  "/some_streamer", "/some_streamer/", "/Some_Streamer", "/SOME_STREAMER?sr=a", "/some_streamer#chat", "/some_streamer//", "/some_streamer/videos",
  "/some_streamer/clip/abc", "/a", `/${"a".repeat(25)}`, `/${"a".repeat(26)}`, `/${"A".repeat(25)}`, "/some-streamer", "/some.streamer", "/some%5Fstreamer",
  "/some%5fstreamer", "/strеamer", "/Kelvin", "/K", "/KELVIN", "/ǅ", "/İstanbul", "/ΑΣ", "/_", "/__", "/0", "/9".repeat(1), "/",
  "/directory", "/videos", "/videos/", "/settings", "/p", "/u", "/embed", "/popout", "/Directory", "/DIRECTORY", "/following", "/jobs",
  "/videos/40464143", "/videos/40464143?t=1h2m3s", "/videos/40464143/", "/videos/40464143/extra", "/videos/040464143", "/videos/0", "/videos/1",
  `/videos/${"1".repeat(12)}`, `/videos/${"1".repeat(13)}`, "/videos/abc", "/videos/v123", "/videos/%31", "/videos/١٢٣", "/videos/0x10", "/videos/1e9",
  "/videos/12 3", "/videos/+1", "/some%2fchannel", "/%2e%2e", "/a/../b", "/./a",
  "/?channel=some_streamer", "/?channel=Some_Streamer&parent=example.com&autoplay=false", "/?channel=some_streamer&parent=a&parent=b",
  "/?video=v40464143", "/?video=40464143", "/?video=V40464143", "/?video=vv40464143", "/?video=v", "/?video=v0", "/?video=0", "/?video=v1&video=v2",
  "/?channel=a&channel=b", "/?channel=", "/?video=", "/?channel=a&video=v1", "/?collection=abc&video=v1", "/?collection=abc", "/?collection=abc&channel=a",
  "/?channel=directory", "/?channel=%C3%A9", "/?channel=a%22onload%3D", "/?channel=%E2%84%AA", "/?channel=%E2%84%AAx", "/?channel=Ab+c", "/?channel=a+b",
  "/?channel=a%20b", "/?channel=%ff", "/?CHANNEL=a", "/?channel=a#f", "/?channel", "/?video", "/?video=v%31", "/?video=%76%31", "/?video=V1",
  "/embed?channel=a", "/embed/?channel=a", "//?channel=a", "?channel=a", "", "/?video=v123456789012", "/?video=v1234567890123", "/?video=1234567890123",
  "/?channel=Ǆ", "/?channel=İ", "/?channel=%C4%B0", "/?channel=ΑΣ", `/?channel=${"a".repeat(25)}`, `/?channel=${"a".repeat(26)}`,
];

const VM_HOSTS = [
  "vimeo.com", "www.vimeo.com", "player.vimeo.com", "api.vimeo.com", "vimeo.com.", "player.vimeo.com.", "VIMEO.com", "Player.Vimeo.COM", "vimeo.com.evil.example",
  "evilvimeo.com", "player.vimeo.work", "player.videoji.hk", "vimeo.com:444", "vimeo.com:443", "u:p@vimeo.com", "player.vimeo.com:80", "vimеo.com",
];
const VM_PATHS = [
  "/76979871", "/76979871?share=copy#t=10", "/76979871/", "/076979871", "/0", "/1", `/${"1".repeat(12)}`, `/${"1".repeat(13)}`, "/٧٦٩", "/７６９",
  "/76979871/abc123def4", "/76979871/ABC123DEF4", "/76979871/abc123", "/76979871/abc12", `/76979871/${"a".repeat(32)}`, `/76979871/${"a".repeat(33)}`,
  "/76979871/xyz123def4", "/76979871/abc123def4/extra", "/76979871/abc123%22def", "/76979871/ABC%26x", "/76979871/%61bc123", "/76979871/ａbc123",
  "/76979871/ǅabcde", "/76979871/Kabcde", "/76979871/abc123def4?x=1#y",
  "/channels/staffpicks/76979871", "/channels/staffpicks", "/channels/staffpicks/76979871/extra", "/channels//76979871", "/channels/a/b/76979871",
  "/groups/shortfilms/videos/76979871", "/groups/shortfilms/76979871", "/groups/s/videos/", "/album/1234/video/76979871", "/showcase/1234/video/76979871",
  "/showcase/1234", "/album/1234/76979871", "/event/1234567", "/event/1234567/embed", "/someuser", "/", "", "/video/76979871", "/CHANNELS/a/1",
  "/video/76979871?h=abc123def4", "/video/76979871?h=ABC123DEF4", "/video/76979871?h=abc123def4&h=abc123def5", "/video/76979871?h=", "/video/76979871?h=abc12",
  "/video/76979871?h=abc123%22def", "/video/76979871?autoplay=1&dnt=1", "/video/76979871?badge=0&h=abc123def4&dnt=1", "/video/76979871/", "/video/76979871/extra",
  "/video/abc", "/video/076979871", "/video/", "/video", "/76979871?h=abc123def4", "/video/76979871?H=abc123def4", "/video/76979871?h=Kbcdef",
  "/video/76979871?h=abc%E2%84%AAdef", "/video/76979871?h=a+bcdef", "/video/76979871?h=%ff", "/video/76979871?h=abc123#f", "/video/76979871?h",
  "/video/1", "/video/0", `/video/${"9".repeat(12)}`, `/video/${"9".repeat(13)}`, `/video/76979871?h=${"f".repeat(32)}`, `/video/76979871?h=${"f".repeat(33)}`,
];

const cross = (hosts: readonly string[], paths: readonly string[], schemes: readonly string[] = ["https://"]): string[] =>
  hosts.flatMap((h) => paths.flatMap((p) => schemes.map((s) => `${s}${h}${p}`)));

/** Wrap or perturb a known URL in the ways WHATWG parsing normalises or refuses. */
const perturb = (u: string): string[] => {
  const out = [
    ` ${u} `, `﻿${u}`, `${u}﻿`, `\u0085${u}`, `${u}\u0085`, `\t${u}\n`, `\n${u}`, `　${u} `, `\u0000${u}`, `${u}\u0000`, `\u0001${u}`, `${u}\u001F`, ` ${u}`,
    u.toUpperCase(), u.replace("https://", "HTTPS://"), u.replace("https://", "http://"), u.replace("https://", "https:"), u.replace("https://", "https:/"),
    u.replace("https://", "https:\\\\"), u.replace("https://", "https:\\/"), u.replace("https://", "https://user@"), u.replace("https://", "https://user:pw@"),
    u.replace("https://", "https://:@"), u.replace("https://", "https://@"), u.replace("https://", "https://:pw@"),
    u.replace(/^(https:\/\/[^/?#]+)/, "$1:443"), u.replace(/^(https:\/\/[^/?#]+)/, "$1:80"), u.replace(/^(https:\/\/[^/?#]+)/, "$1:"), u.replace(/^(https:\/\/[^/?#]+)/, "$1:8443"),
    u.replace(/^(https:\/\/[^/?#]+)/, "$1."), u.replace(/^(https:\/\/[^/?#]+)/, "$1.."), u.replace("https://", "https://."), u.replace(/^(https:\/\/[^/?#]+)/, "$1%2e"),
    u.replace(/^(https:\/\/)([^/?#]+)/, (_, a: string, b: string) => `${a}${b.replace(".", "。")}`),
    u.replace(/^(https:\/\/)([^/?#]+)/, (_, a: string, b: string) => `${a}${b.replace(".", "%2e")}`),
    u.replace(/^(https:\/\/)([^/?#]+)/, (_, a: string, b: string) => `${a}${b}\\x`),
    u.replace("://", ":///"), u.replace("://", ":////"), u.replace("?", "\n?"), u.replace("/", "/\t/"), `${u}#frag`, `${u}#`, `${u}?`, `${u}\\`, `${u}%`, `${u}%zz`,
    u.replace(/^(https:\/\/[^/?#]+)/, "$1/./"), u.replace(/^(https:\/\/[^/?#]+)/, "$1/%2e/"), u.replace(/^(https:\/\/[^/?#]+)\/?/, "$1//"),
    u.replace(/^(https:\/\/[^/?#]+)/, "$1/x/%2E%2e"), u.replace(/^(https:\/\/[^/?#]+)/, "$1/x/.."),
    `${u}\u{1F600}`, `${u}é`, `${u}%C3%A9`,
  ];
  // WHATWG strips tab, LF and CR anywhere in the input.
  for (const at of [3, 9, 12, Math.floor(u.length / 2), u.length - 2]) {
    if (at > 0 && at < u.length) out.push(`${u.slice(0, at)}\t${u.slice(at)}`, `${u.slice(0, at)}\n${u.slice(at)}`, `${u.slice(0, at)}\r${u.slice(at)}`);
  }
  return out;
};

const SEEDS = [
  `https://www.youtube.com/watch?v=${YT}&t=42s`, `https://youtu.be/${YT}`, `https://www.youtube-nocookie.com/embed/${YT}`, `https://m.youtube.com/watch?v=${YT}`,
  "https://www.twitch.tv/some_streamer", "https://www.twitch.tv/videos/40464143", "https://player.twitch.tv/?channel=some_streamer&parent=example.org",
  "https://player.twitch.tv/?video=v40464143", "https://vimeo.com/76979871", "https://vimeo.com/76979871/abc123def0", "https://vimeo.com/channels/staffpicks/76979871",
  "https://player.vimeo.com/video/76979871?h=abc123",
];

const LENGTHS: string[] = (() => {
  const out: string[] = [];
  const base = `https://youtu.be/${YT}?x=`;
  for (const n of [MAX_URL_LENGTH - 1, MAX_URL_LENGTH, MAX_URL_LENGTH + 1]) {
    out.push(base + "a".repeat(n - base.length));
    // astral chars count two UTF-16 units each; the (raw) length cap is in units, not code points
    out.push(base + "\u{1F600}".repeat(Math.floor((n - base.length) / 2)) + (n % 2 === base.length % 2 ? "" : "a"));
    out.push(`  ${base}${"a".repeat(n - base.length - 4)}  `);
    out.push(`﻿${base}${"a".repeat(n - base.length - 1)}`);
  }
  const tw = "https://www.twitch.tv/some_streamer?x=";
  for (const n of [MAX_URL_LENGTH - 1, MAX_URL_LENGTH, MAX_URL_LENGTH + 1]) out.push(tw + "a".repeat(n - tw.length));
  const vm = "https://vimeo.com/76979871?x=";
  for (const n of [MAX_URL_LENGTH, MAX_URL_LENGTH + 1]) out.push(vm + "\u{1F600}".repeat(Math.floor((n - vm.length) / 2)));
  return out;
})();

/** mulberry32 and the mutator from packages/shared/test/embed.fuzz.test.ts, so the corpus covers the same hostile space. */
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
const HOSTILE_CHARS = [
  ".", "/", "\\", "@", ":", "?", "#", "&", "=", "%", "%2e", "%2E", "%2f", "%40", "%00", "%25", " ", "\t", "\n", "\u0000", "­", "​", "‍", "‮", "﻿",
  "о", "е", "а", "с", "ο", "ı", "ｏ", "．", "。", "｡", "ß", "İ", "x", "X", "0", "-", "_", "~", "K", "ǅ", "Σ", "\u{1F600}",
];
function mutate(url: string, rand: () => number): string {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  let s = url;
  const edits = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < edits; i++) {
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
const mutants = (seed: number, per: number): string[] => {
  const rand = prng(seed);
  return SEEDS.flatMap((u) => Array.from({ length: per }, () => mutate(u, rand)));
};

/** Inputs from `HOSTILE_REJECTED` / `NORMALIZED_ACCEPTED` in embed.fuzz.test.ts (the hostile lists). */
const FUZZ_LISTS: string[] = [
  `https://yоutube.com/watch?v=${YT}`, `https://youtu.bе/${YT}`, `https://twitсh.tv/somechannel`, `https://vimеo.com/76979871`, `https://yıutube.com/watch?v=${YT}`,
  `https://xn--ytube-7ve.com/watch?v=${YT}`, `https://xn--youtube-2vh.com/watch?v=${YT}`, `https://youtube.com%2e/watch?v=${YT}`, `https://:pass@www.youtube.com/embed/${YT}`,
  `https://youtube.com@evil.example/watch?v=${YT}`, `https://www.youtube.com%40evil.example/watch?v=${YT}`, `https://vimeo.com:80@evil.example/76979871`,
  `https://evil.example\\@youtube.com/watch?v=${YT}`, `https://evil.example\\.youtube.com/watch?v=${YT}`, `https://youtube.com\\@evil.example/watch?v=${YT}`,
  `https://youtube.com\\..\\evil.example/watch?v=${YT}`, `https://youtube%2ecom.evil.example/watch?v=${YT}`, `https://youtube%252ecom/watch?v=${YT}`,
  `https://youtube%E3%80%82com.evil.example/watch?v=${YT}`, `https://youtube.com%2fwatch%3fv%3d${YT}@evil.example/`, `https://youtube.com%00.evil.example/watch?v=${YT}`,
  `https://0x8e.0xfa.0x48.0x0e/watch?v=${YT}`, `https://2398766094/watch?v=${YT}`, `javascript://youtube.com/%0aalert(1)`, `data:text/html,<iframe src="https://youtu.be/${YT}">`,
  `blob:https://www.youtube.com/0b1c2d3e-0000-4000-8000-000000000000`, `file:///youtube.com/watch?v=${YT}`, `view-source:https://youtu.be/${YT}`, `youtube.com/watch?v=${YT}`,
  `https:/\\evil.example/youtu.be/${YT}`, `https://youtu.be/${YT}%00`, `https://youtu.be/../../evil.example/${YT}`, `https://www.youtube.com/embed/${YT}/../../evil`,
  `https://www.youtube.com/embed/..%2f..%2fevil%2f${YT}`, `https://www.youtube.com/watch?v=${YT}%26x`, `https://www.youtube.com/watch?v=<script>x</a>`,
  `https://www.youtube.com/watch?v=dQw4w9WgXсQ`, `https://twitch.tv/%2e%2e`, `https://twitch.tv/somechannel/../videos`, `https://twitch.tv/javascript:alert(1)`,
  `https://player.twitch.tv/?channel=a%26parent%3Devil.example`, `https://player.twitch.tv/?video=v12%2345`, `https://vimeo.com/76979871/..%2f..`, `https://vimeo.com/７６９７９８７１`,
  `https://player.vimeo.com/video/76979871?h=abc123%26autoplay%3D1`, "https://", "https://?v=x", "https://‮eb.utuoy/" + YT,
  `https://YouTube.COM/watch?v=${YT}`, `HTTPS://WWW.YOUTUBE-NOCOOKIE.COM/embed/${YT}`, `https://www%2eyoutube%2ecom/watch?v=${YT}`, `https://youtu%2Ebe/${YT}`,
  `https://ｙｏｕｔｕ.ｂｅ/${YT}`, `https://youtu。be/${YT}`, `https:\\\\youtu.be\\${YT}`, `https://youtube.com:443/watch?v=${YT}`, `http://youtu.be:80/${YT}`,
  `https://you\ttu.be/${YT}`, `https://youtu.be/%2e%2e/${YT}`, `https://Twitch.TV/SomeChannel`, `https://PLAYER.twitch.tv/?video=V123`, `https://VIMEO.com/76979871/ABC123`,
  `https://player%2evimeo%2ecom/video/76979871`, "", " ", "\u0000", "not a url", "hello world", YT,
];

const SYNCED_URLS = clean([
  ...cross(YT_HOSTS, YT_PATHS.slice(0, 18)),
  ...cross(["www.youtube.com", "youtu.be", "m.youtube.com", "youtube-nocookie.com", "music.youtube.com"], YT_PATHS),
  ...cross(["www.youtube.com", "youtu.be"], YT_PATHS.slice(0, 8), SCHEMES),
  ...cross(TW_HOSTS, TW_PATHS.slice(0, 12)),
  ...cross(["www.twitch.tv", "twitch.tv", "m.twitch.tv", "player.twitch.tv", "clips.twitch.tv"], TW_PATHS),
  ...cross(["www.twitch.tv", "player.twitch.tv"], TW_PATHS.slice(0, 6), SCHEMES),
  ...cross(VM_HOSTS, VM_PATHS.slice(0, 10)),
  ...cross(["vimeo.com", "www.vimeo.com", "player.vimeo.com", "api.vimeo.com"], VM_PATHS),
  ...cross(["vimeo.com", "player.vimeo.com"], VM_PATHS.slice(0, 6), SCHEMES),
  ...[`https://youtu.be/${YT}`, "https://www.twitch.tv/some_streamer", "https://player.twitch.tv/?video=v40464143", "https://vimeo.com/76979871/abc123def4", "https://player.vimeo.com/video/76979871?h=abc123def4",
    `https://www.youtube.com/embed/${YT}`, "https://www.twitch.tv/videos/40464143", "https://vimeo.com/channels/staffpicks/76979871"].flatMap(perturb),
  ...FUZZ_LISTS,
  ...LENGTHS,
]);

// ---------------------------------------------------------------- generic URL shapes

const GENERIC_HOSTS = [
  "player.example.com", "Player.EXAMPLE.com", "example.net", "media.example.org", "a.io", "a-b.co", "a--b.co", "xn--a.co", "x.y.z.example.com", "1a.com", "a1.com", "0.com",
  "bücher.de", "BÜCHER.de", "日本語.jp", "例え.テスト", "faß.de", "ΣΑΣ.gr", "ǆ.com", "ｅｘａｍｐｌｅ.com", "example。com", "example．com", "example｡com", "a­b.com", "a‍b.com", "a‌b.com",
  "a‮b.com", "\u{1F600}.com", "xn--e28h.com", "xn--bcher-kva.de", "xn--zz.de", "xn--.com", "xn--a-.com", "xn--bcher-kva.xn--p1ai", "пример.рф", "пример.xn--p1ai", "example.рф", "example.xn--p1ai",
  "example.中国", "ex́ample.com", "İstanbul.com", "i̇.com", "ǅ.com", "Kelvin.com", "Kelvin.com", "ſ.com", "ß.de", "ς.gr", "a。b.com", "a%2eb.com", "ex%41mple.com", "%zz.com",
  "a..b.com", ".example.com", "example.com.", "example.com..", "a.b.", "-a.com", "a-.com", "a.-b.com", "a.b-.com", "a_b.com", "_a.com", "a b.com", "a\tb.com", "a:80.com",
  "1.2.3.4", "1.2.3", "1.2", "127.1", "0x7f.1", "0x7f.0.0.1", "2130706433", "0177.0.0.1", "01.02.03.04", "256.1.1.1", "1.2.3.4.5", "1.2.3.4.", "[::1]", "[::ffff:127.0.0.1]",
  "[2606:2800:220:1:248:1893:25c8:1946]", "[::]", "[1::]", "[fe80::1%25eth0]", "[::1", "::1",
  "example.123", "example.1a", "example.a1", "example.a", "example.ab", "example.com1", "example.0x1", "example.0xa", "example.0xg", "example.x-y", "example.-xy", "example.xy-", "example.xn--",
  "example.xn--a", `example.xn--${"a".repeat(59)}`, `example.xn--${"a".repeat(60)}`, `example.${"a".repeat(63)}`, `example.${"a".repeat(64)}`, `${"a".repeat(63)}.com`, `${"a".repeat(64)}.com`,
  `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.com`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(56)}.com`,
  `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`,
  "localhost", "localhost.", "app.localhost", "a.local", "a.internal", "a.localdomain", "a.lan", "a.home", "a.corp", "a.intranet", "a.arpa", "nas.home.arpa", "1.0.0.127.in-addr.arpa",
  "a.test", "a.example", "a.invalid", "a.onion", "a.alt", "example.test.com", "test.com", "local.com", "internal.example.com", "a.LOCAL", "a.Test", "alt.com", "x.alt.com",
  "localtest.me", "a.localtest.me", "lvh.me", "a.lvh.me", "vcap.me", "localhost.direct", "a.localhost.direct", "127.0.0.1.nip.io", "nip.io", "10-0-0-1.sslip.io", "sslip.io", "xip.io", "traefik.me",
  "notlocaltest.me", "evil-lvh.me", "nip.io.com", "localtest.me.evil.com", "omega.example.org", "OMEGA.example.org", "cdn.omega.example.org", "notomega.example.org", "omega.example.org.evil.com",
  "share.example.org", "x.share.example.org", "bücher.de", "x.bücher.de", "youtube.com", "www.youtube.com", "youtu.be", "youtube-nocookie.com", "x.youtu.be", "twitch.tv", "clips.twitch.tv", "vimeo.com",
  "foo.vimeo.com", "player.vimeo.com", "notvimeo.com", "vimeo.com.evil.com", "twitch.tv.evil.com", "youtube.com.evil.com", "myyoutube.com", "user@player.example.com", "u:p@player.example.com",
  "player.example.com:443", "player.example.com:8443", "player.example.com:80", "player.example.com:", "player.example.com:0", "player.example.com:65536", "player.example.com:abc",
];

const GENERIC_PATHS = [
  "/embed/42", "", "/", "/a/../embed/42", "/a/./b", "/%41", "/%2e%2e/x", "/a%2fb", "/a b", "/a\\b", "/a|b{c}^`d", "/é", "/\u{1F600}", "/日本", "/%E6%97%A5", "/%zz", "/%", "/a%00b", "/\u0000",
  "?q=1", "/v?id=7&t=30", "/v?q=a b", "/v?q=é", "/v?q='x'", '/v?q="x"', "/v?q=<x>", "/v?q=a+b", "/v?q=%41", "/v?q=%zz", "/v?q=`", "/v?a=1&&b=2", "/v?", "/v?#", "/v#", "/v#frag", "/v#a b", "/v#é",
  "/v#%41", "/v#`", "/v?q=\\", "/v?q=\u{1F600}", "#x", "?", "\t/x", "/x\ty", "/x\ny", "/x\ry", "/;a=b", "/:x", "/@x", "/a//b", "//x", "///", "/..", "/../..", "/./", "/.%2e/", "/%2E/x", "/a/%2e%2e/b",
  "/‮", "/​", "/ ", "/﻿", "/\u0085", "/a b", "/embed/42/", "/embed/42?autoplay=1&muted=1",
];

const GENERIC_SCHEMES = ["https://", "HTTPS://", "Https://", "http://", "ftp://", "wss://", "//", "", "https:", "https:/", "https:\\\\", "https:\\/", "blob:https://", "javascript://", "data:", "file://"];

const GENERIC_PRE_HOST = ["", "u@", "u:p@", ":@", "@", ":p@", "player.example.com@", "player.example.com:443@"];

const genericWithLengths = (): string[] => {
  const out: string[] = [];
  const base = "https://player.example.com/";
  for (const n of [MAX_GENERIC_EMBED_URL_LENGTH - 1, MAX_GENERIC_EMBED_URL_LENGTH, MAX_GENERIC_EMBED_URL_LENGTH + 1]) {
    out.push(base + "a".repeat(n - base.length));
    out.push(`  ${base}${"a".repeat(n - base.length)}  `);
    out.push(`https://player.example.com${"/é".repeat(Math.floor((n - base.length) / 6))}`);
    out.push(`https://player.example.com/?${"\u{1F600}".repeat(Math.floor((n - base.length) / 12))}`);
    out.push(`https://player.example.com/${"%41".repeat(Math.floor((n - base.length) / 3))}`);
    out.push(`https://player.example.com/${"a".repeat(n - base.length - 3)}/..`);
  }
  for (const n of [MAX_URL_LENGTH - 1, MAX_URL_LENGTH, MAX_URL_LENGTH + 1]) {
    out.push(base + "a".repeat(n - base.length));
    out.push(`  ${base}/${"a/../".repeat(Math.floor((n - base.length - 6) / 5))}x  `.slice(0, n));
    out.push(`https://player.example.com/${"\u{1F600}".repeat(Math.floor((n - base.length) / 2))}`);
    out.push(`https://player.example.com/?${"\u{1F600}".repeat(Math.floor((n - base.length) / 2))}`);
    out.push(`https://player.example.com/${"%00".repeat(Math.floor((n - base.length) / 3))}`);
    out.push(`https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(Math.max(1, n - 200 - 10))}.com`);
  }
  return out;
};

/** Every ASCII char (and a spread of others) in the path, query, fragment and host of a generic URL: finds where the two URL parsers' percent-encode sets and IDNA tables part. */
const sweepChars = (): string[] => {
  const cs: string[] = [];
  for (let c = 0; c < 0x100; c++) cs.push(String.fromCharCode(c));
  for (const [lo, hi] of [[0x100, 0x530], [0x1c00, 0x1d00], [0x2000, 0x2200], [0x2460, 0x2500], [0x3000, 0x3100], [0xfb00, 0xfb50], [0xfe00, 0xfe70], [0xff00, 0xfff0]] as const)
    for (let c = lo; c < hi; c++) cs.push(String.fromCharCode(c));
  for (const c of [0x1f600, 0x10000, 0x1d400, 0xe0001, 0x10ffff, 0x1d7ce, 0x2f800]) cs.push(String.fromCodePoint(c));
  return cs;
};
const GENERIC_SWEEP: string[] = (() => {
  const out: string[] = [];
  const cs = sweepChars();
  for (const ch of cs.slice(0, 0x100)) out.push(`https://player.example.com/a${ch}b`, `https://player.example.com/?a${ch}b`, `https://player.example.com/#a${ch}b`, `https://player.example.com/?a=${ch}&b`, `https://player.example.com/a%${ch}b`);
  for (const ch of cs) out.push(`https://a${ch}b.com/x`, `https://${ch}.example.com/x`);
  for (const ch of cs.slice(0x100).filter((_, i) => i % 7 === 0)) out.push(`https://player.example.com/a${ch}b?q=${ch}#${ch}`);
  return out;
})();

/** The sweep again, in the host of each synced provider: an IDNA mapping that lands on `youtu.be` etc. */
const HOST_SWEEP: string[] = sweepChars()
  .filter((_, i) => i < 0x100 || i % 5 === 0)
  .flatMap((ch) => [`https://you${ch}tu.be/${YT}`, `https://www.${ch}youtube.com/watch?v=${YT}`, `https://twitch${ch}.tv/some_streamer`, `https://vimeo.com${ch}/76979871`, `https://player.vimeo.com/video/76979871?h=abc12${ch}`, `https://player.twitch.tv/?channel=a${ch}`]);

const GENERIC_URLS = clean([
  ...GENERIC_HOSTS.flatMap((h) => ["/embed/42", "", "/x?y=1#z"].map((p) => `https://${h}${p}`)),
  ...["player.example.com", "xn--bcher-kva.de", "bücher.de"].flatMap((h) => GENERIC_PATHS.map((p) => `https://${h}${p}`)),
  ...GENERIC_SCHEMES.flatMap((s) => ["player.example.com/embed/42", "bücher.de/e", "youtu.be/" + YT, "localhost/x"].map((p) => `${s}${p}`)),
  ...GENERIC_PRE_HOST.map((p) => `https://${p}player.example.com/embed/42`),
  ...["https://player.example.com/embed/42", "https://bücher.de/e?x=é#y", "https://media.example.org/v?id=7&t=30"].flatMap(perturb),
  ...genericWithLengths(),
  ...SYNCED_URLS.slice(0, 120),
  ...FUZZ_LISTS,
  "relative/path", "/embed/42", "garbage", "https://", "https://%", "https://ex\u0000ample.com/", "\u0000", "javascript:alert(1)", "javascript://player.example.com/%0aalert(1)",
  "data:text/html,<script>alert(1)</script>", "blob:https://player.example.com/550e8400-e29b-41d4-a716-446655440000",
]);

// ---------------------------------------------------------------- the embed corpora

const OWN_HOST_SETS: readonly (readonly string[])[] = [[], ["omega.example.org"], [" Share.Example.ORG. ", "bücher.de", "", "a/b", "localhost", "youtube.com"]];

interface AnyInput {
  url: string;
  generic: boolean;
  ownHosts: readonly string[];
}
const anyInputs = (): AnyInput[] => {
  const urls = clean([...SYNCED_URLS.filter((_, i) => i % 3 === 0), ...GENERIC_URLS]);
  const sets = [
    { generic: true, ownHosts: OWN_HOST_SETS[0] ?? [] },
    { generic: false, ownHosts: OWN_HOST_SETS[0] ?? [] },
    { generic: true, ownHosts: OWN_HOST_SETS[1] ?? [] },
    { generic: true, ownHosts: OWN_HOST_SETS[2] ?? [] },
  ];
  return urls.flatMap((url) => sets.map((s) => ({ url, ...s })));
};

/** Valid stored embeds: whatever the canonicalizers produce (generic on, no own hosts). */
const storedEmbeds = (): AnyEmbed[] => {
  const seen = new Set<string>();
  const out: AnyEmbed[] = [];
  for (const url of [...SYNCED_URLS, ...GENERIC_URLS]) {
    const e = canonicalizeAnyEmbed(url, { generic: true });
    if (e !== null && !seen.has(JSON.stringify(e))) {
      seen.add(JSON.stringify(e));
      out.push(e);
    }
  }
  return out;
};

interface Loose {
  provider: unknown;
  url: unknown;
  videoId?: unknown;
  kind?: unknown;
  host?: unknown;
  [key: string]: unknown;
}
const tamper = (e: AnyEmbed): unknown[] => {
  const o = e as unknown as Loose;
  const out: unknown[] = [e, { ...o, extra: 1 }, { ...o, url: String(o.url).toUpperCase() }, { ...o, url: `${String(o.url)}/` }, { ...o, url: `${String(o.url)}?x=1` },
    { ...o, url: `${String(o.url)}#f` }, { ...o, url: String(o.url).replace("https://", "http://") }, { ...o, url: ` ${String(o.url)}` }, { ...o, url: 5 }, { ...o, url: null }, { ...o, provider: "other" },
    { ...o, provider: "generic" }, { ...o, provider: null }, { ...o, provider: 1 }, { ...o, provider: "YOUTUBE" }];
  for (const key of Object.keys(o)) {
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
    out.push(rest, { ...o, [key]: null }, { ...o, [key]: 7 }, { ...o, [key]: "" }, { ...o, [key]: `${String(o[key])}x` }, { ...o, [key]: String(o[key]).toUpperCase() }, { ...o, [key]: [o[key]] });
  }
  if (o.provider === "vimeo") out.push({ ...o, hash: null }, { ...o, hash: "abc123" }, { ...o, hash: "ABC123" }, { ...o, hash: "abc12" }, { provider: "vimeo", videoId: o.videoId, url: o.url });
  if (o.provider === "twitch") out.push({ ...o, kind: o.kind === "live" ? "vod" : "live" }, { ...o, kind: "clip" }, { ...o, kind: "LIVE" });
  if (o.provider === "generic") out.push({ ...o, host: "other.example.com" }, { ...o, host: String(o.host).toUpperCase() }, { ...o, host: "" });
  return out;
};

const HAND_INVALID: unknown[] = [
  null, undefined, 0, 1, "", "x", true, false, [], [{}], {}, { provider: "youtube" }, { url: "https://www.youtube.com/embed/dQw4w9WgXcQ" },
  { provider: "youtube", videoId: "videoseries", url: "https://www.youtube.com/embed/videoseries" },
  { provider: "youtube", videoId: "live_stream", url: "https://www.youtube.com/embed/live_stream" },
  { provider: "youtube", videoId: YT, url: `https://youtu.be/${YT}` },
  { provider: "twitch", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" },
  { provider: "twitch", kind: "live", channel: "directory", url: "https://player.twitch.tv/?channel=directory" },
  { provider: "twitch", kind: "live", channel: "Some_Streamer", url: "https://player.twitch.tv/?channel=Some_Streamer" },
  { provider: "twitch", kind: "live", videoId: "40464143", url: "https://player.twitch.tv/?video=v40464143" },
  { provider: "twitch", kind: "vod", videoId: "40464143", url: "https://player.twitch.tv/?video=40464143" },
  { provider: "twitch", kind: "live", channel: "a", url: "https://player.twitch.tv/?channel=a&parent=evil.example" },
  { provider: "vimeo", videoId: "76979871", url: "https://player.vimeo.com/video/76979871" },
  { provider: "vimeo", videoId: "76979871", hash: undefined, url: "https://player.vimeo.com/video/76979871" },
  { provider: "vimeo", videoId: "76979871", hash: "abc123def4", url: "https://player.vimeo.com/video/76979871" },
  { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871?h=abc123def4" },
  { provider: "vimeo", videoId: "076979871", hash: null, url: "https://player.vimeo.com/video/076979871" },
  { provider: "generic", host: "x", url: "javascript:alert(1)" },
  { provider: "generic", host: "127.0.0.1", url: "https://127.0.0.1/" },
  { provider: "generic", host: "localhost", url: "https://localhost/" },
  { provider: "generic", host: "player.vimeo.com", url: "https://player.vimeo.com/video/76979871" },
  { provider: "generic", url: "https://player.example.com/embed/42" },
  { provider: "generic", host: "player.example.com", url: `https://player.example.com/${"a".repeat(MAX_GENERIC_EMBED_URL_LENGTH)}` },
  { provider: "generic", host: "player.example.com", url: `https://player.example.com/${"a".repeat(MAX_GENERIC_EMBED_URL_LENGTH - 27)}` },
  { provider: "generic", host: "player.example.com", url: `https://player.example.com/${"a".repeat(MAX_GENERIC_EMBED_URL_LENGTH - 28)}` },
  { provider: "generic", host: "player.example.com", url: "https://player.example.com/embed/42", provider2: "x" },
  { provider: "generic", host: "xn--bcher-kva.de", url: "https://xn--bcher-kva.de/e" },
  { provider: "generic", host: "bücher.de", url: "https://bücher.de/e" },
  { provider: "generic", host: "player.example.com", url: "https://player.example.com" },
  { provider: "generic", host: "player.example.com", url: "https://player.example.com:443/embed/42" },
  { provider: "generic", host: "player.example.com", url: "https://user@player.example.com/embed/42" },
  { provider: "generic", host: "player.example.com", url: "https://player.example.com/a/../embed/42" },
];

export const embedCorpora: Corpus[] = [
  rawEmbedCorpus,
  {
    name: "canonicalize-embed",
    cases: () => decide(clean([...SYNCED_URLS, ...HOST_SWEEP, ...mutants(0x0ae226, 120)]), (s) => canonicalizeEmbed(s)),
  },
  {
    name: "canonicalize-any-embed",
    cases: () => decide(anyInputs(), (i) => canonicalizeAnyEmbed(i.url, { generic: i.generic, ownHosts: i.ownHosts })),
  },
  {
    name: "canonicalize-generic-embed",
    cases: () => decide(clean([...GENERIC_URLS, ...GENERIC_SWEEP, ...mutants(0x51ed, 30).map((u) => u.replace(/^https:\/\/[^/?#]+/, "https://player.example.com"))]), (s) => canonicalizeGenericEmbed(s)),
  },
  {
    name: "any-embed-schema",
    cases: (): Case[] => {
      const inputs = [...storedEmbeds().filter((_, i) => i % 5 === 0).flatMap(tamper), ...HAND_INVALID].filter((x) => !LONE_SURROGATE.test(JSON.stringify(x)));
      return inputs.map((input): Case => {
        const r = v.safeParse(AnyEmbedSchema, input);
        return r.success ? { input: input === undefined ? null : input, ok: true, output: JSON.stringify(r.output) } : { input: input === undefined ? null : input, ok: false };
      });
    },
  },
  {
    name: "playback-caps",
    cases: () => storedEmbeds().map((input) => ({ input, ok: true, output: JSON.stringify(playbackCaps(input)) })),
  },
  {
    name: "embed-policy-accept",
    cases: () => {
      const policies = embedPolicies();
      return Object.entries(policies).flatMap(([mode, policy]) =>
        decide(clean([...GENERIC_URLS.filter((_, i) => i % 3 === 0), ...SYNCED_URLS.filter((_, i) => i % 9 === 0), ...POLICY_URLS]).map((url) => ({ mode, url })), (i) => policy.accept(i.url)),
      );
    },
  },
  {
    name: "embed-policy-restore",
    cases: () => {
      const policies = embedPolicies();
      const embeds = [...storedEmbeds().filter((e) => e.provider === "generic").filter((_, i) => i % 3 === 0), ...storedEmbeds().filter((e) => e.provider !== "generic").slice(0, 10)];
      return Object.entries(policies).flatMap(([mode, policy]) => decide(embeds.map((embed) => ({ mode, embed })), (i) => policy.restore(i.embed)));
    },
  },
];

const POLICY_URLS = [
  "https://bad.video.net/x", "https://BAD.video.net/x", "https://cdn.bad.video.net/x", "https://notbad.video.net/x", "https://bad.video.net.evil.com/x", "https://video.net/x",
  "https://x.bücher-bad.de/x", "https://xn--bcher-bad-q9a.de/x", "https://omega.example.org/x", "https://a.own.site.net/", "https://own.site.net./", "https://player.example.com/x",
  "https://youtube.com/watch?v=" + YT, "https://youtu.be/" + YT,
];

function embedPolicies(): Record<string, EmbedPolicy> {
  const ownHosts = ["omega.example.org", " Own.Site.NET. "];
  const denylist = ["bad.video.net", "bücher-bad.de", "youtube.com", "example-host.net"];
  return {
    on: new EmbedPolicy({ genericEmbeds: true, ownHosts, denylist }),
    off: new EmbedPolicy({ genericEmbeds: false, ownHosts, denylist }),
    plain: new EmbedPolicy({ genericEmbeds: true, ownHosts: [], denylist: [] }),
  };
}
