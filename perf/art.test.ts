import { describe, expect, test } from "bun:test";
import { artReport, isArt, presetArt } from "./art";

const WEB = "http://localhost:5183";
const r = (path: string, type: string, bytes: number, origin = WEB) => ({ url: `${origin}${path}`, type, bytes });

describe("isArt (OME-2152)", () => {
  test("images and JSON files from the site count; scripts, stylesheets, the document, API JSON and data: URLs don't", () => {
    expect(isArt(r("/assets/furniture-v8-a1.png", "image", 1), WEB)).toBe(true);
    // Pixi fetches its sheets and manifests, so they come in as fetch, not image.
    expect(isArt(r("/assets/motion-b2.json", "fetch", 1), WEB)).toBe(true);
    expect(isArt(r("/assets/bare-c3.png?v=1", "fetch", 1), WEB)).toBe(true);
    expect(isArt(r("/assets/site.svg", "image", 1), WEB)).toBe(true);
    expect(isArt(r("/assets/index-a1.js", "script", 1), WEB)).toBe(false);
    expect(isArt(r("/assets/index-b2.css", "stylesheet", 1), WEB)).toBe(false);
    expect(isArt(r("/r/abc", "document", 1), WEB)).toBe(false);
    expect(isArt(r("/assets/font.woff2", "font", 1), WEB)).toBe(false);
    expect(isArt(r("/rooms", "fetch", 1, "http://localhost:8797"), WEB)).toBe(false);
    expect(isArt(r("/x.json", "fetch", 1, "http://localhost:8797"), WEB)).toBe(false);
    expect(isArt({ url: "data:image/png;base64,AAAA", type: "image", bytes: 1 }, WEB)).toBe(false);
  });
});

describe("presetArt (OME-2152)", () => {
  test("keeps only art, each URL once", () => {
    const a = presetArt("classic", [r("/a.png", "image", 100), r("/a.png", "image", 100), r("/b.json", "fetch", 50), r("/c.js", "script", 999)], WEB);
    expect(a.preset).toBe("classic");
    expect([...a.files]).toEqual([
      [`${WEB}/a.png`, 100],
      [`${WEB}/b.json`, 50],
    ]);
  });
});

describe("artReport (OME-2152)", () => {
  test("reports the dearest preset, lists every preset dearest first, and the union counts shared files once", () => {
    const classic = presetArt("classic", [r("/shared.png", "image", 1024), r("/rug.png", "image", 1024)], WEB);
    const studio = presetArt("studio", [r("/shared.png", "image", 1024), r("/desk.png", "image", 2048), r("/desk.json", "fetch", 1024)], WEB);
    const out = artReport([classic, studio]);
    expect(out.kb).toBe(4);
    expect(out.note).toBe("dearest studio; studio 4.0 KB (3 files), classic 2.0 KB (2 files); union 5.0 KB (4 files)");
  });

  test("no presets is an error, not a 0 KB pass", () => {
    expect(() => artReport([])).toThrow();
  });
});
