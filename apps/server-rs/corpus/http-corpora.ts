// HTTP corpora (OME-1166): the pure string functions of site-meta.ts and the path rules the TS server gets from
// Bun's URL parser and Hono, driven by the real code. No lone surrogates (PORTING.md).
//  - site-meta / with-meta / security-txt: site-meta.ts.
//  - url-pathname: the pathname of the request URL (`new URL(...)`: dot segments resolved, %2e counts as a dot).
//  - route-path: Hono's `getPath` on that URL (decodeURI, `%25` kept), what routes and static files are matched on.
//  - mime-type: Hono's `getMimeType` (static files' content types).
import { getPath } from "../../server/node_modules/hono/dist/utils/url";
import { getMimeType } from "../../server/node_modules/hono/dist/utils/mime";
import { securityTxt, siteMeta, withMeta } from "../../server/src/site-meta";
import { decided, type Corpus } from "./corpora";

const ORIGINS = ["http://localhost:5173", "https://quiet-otter.ngrok-free.app", "https://a.example:8443", "http://127.0.0.1:8787", `https://x.example/"<&>'`, ""];

const TITLES: (string | null)[] = [
  null, "", " ", "Film night", "Film night & co", `Tom & "Jerry" <b>'s</b>`, "Film‮ club​⁦﻿", "Ｆilm night", "​‮ ",
  "a".repeat(32), "a".repeat(33), "a".repeat(200), "é".repeat(40), "\u{1F600}".repeat(40), "\u{1F600} party", "👨‍👩‍👧 family", "x ".repeat(50),
  "  padded  ", "tab\tsep\nnew\r\nline", "a b", "a b", "a　b", "ㅤﾠ", "؜ᅟᅠx", "ﬁlm", "ｆｉｌｍ club", "①②③", "Å", "Å",
  "李雷 film", "हिन्दी film", "العربية", "\u0085x", "x\u0085", "'quoted'", '"double"', "<script>alert(1)</script>", "&amp;", "&&&&", "a&b&c",
  "a".repeat(31) + "\u{1F600}", "a".repeat(31) + "\u{1F600}x", " ".repeat(30) + "x", "x" + " ".repeat(40) + "y", "x".repeat(20) + "​".repeat(20) + "y",
  "· omega-share", "omega-share", "film ·", "\u{1F600}".repeat(31) + "é", "é".repeat(20), "é".repeat(40),
];

function siteMetaCases() {
  const out: { input: [string, string | null]; ok: boolean; output: unknown }[] = [];
  for (const origin of ORIGINS) for (const title of TITLES) out.push({ input: [origin, title], ok: true, output: siteMeta(origin, title) });
  return out;
}

const PAGES = [
  "", "no head here", "<html><head></head><body></body></html>", "<head></head>", "a</head>b</head>c",
  '<head><meta name="description" content="x"></head>',
  '<head><meta name="description" content="x">   \n<title>t</title></head>',
  '<head><link rel="icon" href="/favicon.ico" sizes="32x32" />\n  <link rel="apple-touch-icon" href="/a.png" /> ﻿<link rel="manifest" href="/m" /></head>',
  '<head><link rel="stylesheet" href="/s.css" /><link rel="icon" href="/f"></head>',
  '<head><meta name="description"\ncontent="multi\nline"></head>',
  '<head><meta name="description" content="x"><meta name="description" content="y"></head>',
  '<head><META NAME="description" content="x"></head>', '<head><meta  name="description" content="x"></head>', '<head><link rel="icon"></head>',
  '<head><link rel="icon" href="x"', '<head><link rel="mask-icon" href="x"></head>', '<head><link rel="manifest"></head><body><link rel="icon" href="x"></body>',
  '<meta name="description" content="x"></head>after</head>', '</head><meta name="description" content="x">', "<head>é\u{1F600}</head>é",
  '<!doctype html><html><head><meta charset="utf-8" /><meta name="description" content="Built-in words." /><link rel="icon" href="/favicon.ico" sizes="32x32" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><link rel="manifest" href="/manifest.webmanifest" /><title>omega</title></head><body><div id="app"></div></body></html>',
];
const METAS = ["", "<m/>", siteMeta("http://localhost:5173", null), 'x$&y$1$`$\'$$', "\u{1F600}"];

const withMetaCases = () => PAGES.flatMap((page) => METAS.map((meta) => ({ input: [page, meta], ok: true, output: withMeta(page, meta) })));

const SEGMENTS = ["", ".", "..", "%2e", "%2E", "%2e%2e", ".%2e", "%2e.", "a", "b%20c", "%41", "%2f", "%5c", "%25", "%25%32", "...", ".a", "%C3%A9", "%E4%BD%A0", "%C3", "%00", "%0a", "%ff", "%7e", "%3b%3a", "r", "assets"];

function paths(): string[] {
  const out = new Set<string>(["/", "//", "///", "/a//b", "/a/b/", "/..", "/../..", "/./", "/.", "/a/.", "/a/..", "/a/../", "/a/./b/../c", "/healthz", "/rooms", "/rooms/", "/rooms/abc/share"]);
  for (const a of SEGMENTS) {
    out.add(`/${a}`);
    for (const b of SEGMENTS) {
      out.add(`/${a}/${b}`);
      for (const c of ["", "..", "%2e%2e", "x", "%25", "%C3%A9", "%2f"]) out.add(`/${a}/${b}/${c}`);
    }
  }
  return [...out];
}

const pathnameOf = (p: string): string => new URL("http://h" + p).pathname;
const routePathOf = (p: string): string => getPath(new Request(new URL("http://h" + p)));

const FILES = [
  "a.js", "a.JS", "a.css", "a.html", "a.htm", "a.png", "a.ico", "a.webmanifest", "a.txt", "a.map", "a.mjs", "a.svg", "a.woff2", "a.wasm", "a.json", "a.xml", "a.unknown", "noext",
  "a.tar.gz", "a.", ".js", ".hidden", "a.b-c", "a.j s", "a.js/", "dir/a.js", "assets/index-Ab12Cd34.js", "x.ts", "x.mp4", "x.webp", "x.avif", "x.csv", "x.pdf", "x.ttf", "x.otf", "x.glb", "x.3gp",
  "/", "", ".", "..", "a.9", "a.ÿ", "a.é", "a.JpEg", "a.jpeg", "a.jpg", "a.gif", "a.zip", "a.opus", "a.weba", "a.webm",
];

export const httpCorpora: Corpus[] = [
  { name: "site-meta", cases: siteMetaCases },
  { name: "with-meta", cases: withMetaCases },
  { name: "security-txt", cases: () => decided(ORIGINS, securityTxt) },
  { name: "url-pathname", cases: () => decided(paths(), pathnameOf) },
  { name: "route-path", cases: () => decided(paths(), routePathOf) },
  { name: "mime-type", cases: () => decided(FILES, (f) => getMimeType(f) ?? null) },
];
