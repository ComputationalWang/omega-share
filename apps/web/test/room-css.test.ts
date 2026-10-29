import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as v from "valibot";
import { build } from "vite";

/**
 * OME-1023: the landing, the legal pages and the directory ship only the site's stylesheet. The room's chrome (the
 * generated reference.css and the app's room rules) loads with the room chunk and the pop-out entries, so a visitor who
 * never enters a room never downloads it. Checked on a real `vite build` of apps/web into a scratch dir.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

/** Selectors only the room views render: stage, TV, chat, playback, queue, pop-outs, portrait, and set (c)–(k) chrome. */
const ROOM_ONLY = [".seat", ".tv", ".chat-log", ".float-motion", ".controls", ".room-portrait", ".room-wide", ".poproom", ".ui-bubble", ".ui-tag", ".ui-seat-cursor", ".ui-queue", ".ui-fs", ".ui-transport", ".ui-panel"] as const;
/** The site's stylesheet, gzipped at zlib level 6 as `perf/landing.perf.ts` counts it: the Dusk doorstep and the base. */
const SITE_CSS_GZIP_MAX = 8 * 1024;

const Manifest = v.record(v.string(), v.object({ file: v.string(), css: v.optional(v.array(v.string())), imports: v.optional(v.array(v.string())) }));

let out = "";
let manifest: v.InferOutput<typeof Manifest> = {};

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "omega-room-css-"));
  await build({ root: web, configFile: join(web, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true, sourcemap: false, manifest: true } });
  manifest = v.parse(Manifest, JSON.parse(readFileSync(join(out, ".vite", "manifest.json"), "utf8")));
}, 60_000);

afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

/** The stylesheets a built page links in its head, by URL path. */
const linkedCss = (page: string): string[] =>
  [...readFileSync(join(out, page), "utf8").matchAll(/<link rel="stylesheet"[^>]*href="\/([^"]+\.css)"/g)].map((m) => m[1] ?? "");
const css = (files: readonly string[]): string => files.map((f) => readFileSync(join(out, f), "utf8")).join("\n");
/** Every stylesheet a chunk brings, its static imports' included: Vite's preload fetches them all before the chunk resolves. */
const chunkCss = (key: string, seen = new Set<string>()): string[] => {
  if (seen.has(key)) return [];
  seen.add(key);
  const chunk = manifest[key];
  return [...(chunk?.css ?? []), ...(chunk?.imports ?? []).flatMap((k) => chunkCss(k, seen))];
};
/** A class selector as written in CSS, not as a prefix of a longer one (`.tv` is not `.tv-shelf`). */
const hasSelector = (sheet: string, sel: string): boolean => new RegExp(`\\${sel}(?![\\w-])`).test(sheet);

describe("room-only CSS stays off the site pages", () => {
  for (const page of ["index.html", "privacy.html", "terms.html", "contact.html", "licenses.html"]) {
    test(`${page} links no room-only selector`, () => {
      const sheet = css(linkedCss(page));
      expect(sheet.length).toBeGreaterThan(0);
      expect(ROOM_ONLY.filter((sel) => hasSelector(sheet, sel))).toEqual([]);
    });
  }

  test("the site stylesheet is small: the landing pays for its own look only", () => {
    const gz = gzipSync(css(linkedCss("index.html")), { level: 6 }).length;
    expect(gz).toBeLessThanOrEqual(SITE_CSS_GZIP_MAX);
  });

  test("the directory chunk brings no room CSS either", () => {
    expect(manifest["src/home.ts"]).toBeDefined();
    expect(ROOM_ONLY.filter((sel) => hasSelector(css(chunkCss("src/home.ts")), sel))).toEqual([]);
  });
});

describe("the room's chrome loads with the room", () => {
  test("the room chunk carries the room stylesheet, so Vite loads it before room.ts resolves", () => {
    expect(manifest["src/room.ts"]).toBeDefined();
    const sheet = css(chunkCss("src/room.ts"));
    expect(ROOM_ONLY.filter((sel) => !hasSelector(sheet, sel))).toEqual([]);
  });

  for (const page of ["chat.html", "room.html"]) {
    test(`the ${page} pop-out links the room stylesheet in its head`, () => {
      const sheet = css(linkedCss(page));
      expect([".ui-bubble", ".ui-fs", ".chat-log", ".ui-panel"].filter((sel) => !hasSelector(sheet, sel))).toEqual([]);
      // The site base first, the room chrome over it: a room rule wins a tie with a base rule, as it does in the room tab.
      expect(sheet.indexOf("color-scheme:dark")).toBeGreaterThanOrEqual(0);
      expect(sheet.indexOf("color-scheme:dark")).toBeLessThan(sheet.indexOf(".ui-bubble"));
    });
  }
});

// OME-1755: body:has() / main:has() make the whole page's styles depend on every DOM change under it. Chromium re-styles
// body and everything its :has() rules reach on each chat line, bubble or hidden toggle (the wide chat burst's tail).
// The room marks the body with a class instead (room-is-wide, room-is-portrait, room-is-pseudo-fs).
test("room.css keys no rule on body:has() or main:has()", () => {
  const src = readFileSync(join(web, "src", "room.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(src.match(/(?<![\w-])(?:body|main)(?:[.#[][^\s,{>+~]*)?:has\(/g) ?? []).toEqual([]);
});

// OME-1985: the same for the wide chat column. `.room-side:has(> .people:not([hidden]))` made Chromium re-style the
// column (~150 elements, ~4 ms) on every chat line put in its log; the layout marks it people-open / poll-open instead.
// (.room-side.is-typing:has() stays: it's only tried while a touch keyboard is up.)
test("room.css keys no rule on .room-side:has()", () => {
  const src = readFileSync(join(web, "src", "room.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(src.match(/\.room-side(?::not\()?:has\(/g) ?? []).toEqual([]);
});
