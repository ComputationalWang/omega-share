import { describe, expect, test } from "bun:test";
import { artChunks, artReport, isArt, presetArt } from "./art";

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

describe("artChunks (OME-2163)", () => {
  // The shapes of the preview build's manifest and sourcemaps (repo-relative module paths).
  const manifest = {
    "index.html": { file: "assets/index-a.js", src: "index.html", isEntry: true },
    "src/walk/motion-atlas.ts": { file: "assets/motion-atlas-b.js", src: "src/walk/motion-atlas.ts", isDynamicEntry: true },
    "_furniture-c.js": { file: "assets/furniture-c.js", name: "furniture" },
    "src/furniture-atlas.ts": { file: "assets/furniture-atlas-d.js", src: "src/furniture-atlas.ts", isDynamicEntry: true },
    "_stage-e.js": { file: "assets/stage-e.js", name: "stage" },
    "src/room.ts": { file: "assets/room-f.js", src: "src/room.ts", isDynamicEntry: true },
    "../../assets/furniture/furniture.png": { file: "assets/furniture-g.png", src: "../../assets/furniture/furniture.png" },
  };
  const modules: Record<string, string[]> = {
    "assets/index-a.js": ["assets/presets/presets.json", "apps/web/src/main.ts"],
    "assets/motion-atlas-b.js": ["assets/avatars/motion.json", "assets/avatars/motion.png", "apps/web/src/walk/motion-atlas.ts"],
    "assets/furniture-c.js": ["assets/furniture/furniture.json"],
    "assets/furniture-atlas-d.js": ["assets/furniture/furniture.png", "apps/web/src/furniture-atlas.ts"],
    "assets/stage-e.js": ["assets/avatars/tints.json", "apps/web/src/stage.ts"],
    "assets/room-f.js": ["assets/room/room.json", "apps/web/src/room.ts", "apps/web/src/room-view.ts"],
  };
  const modulesOf = (file: string): readonly string[] => modules[file] ?? [];

  test("a lazy chunk of art JSON (plus at most its own loader) is art; entries, chunks without JSON and app code are not", () => {
    expect([...artChunks(manifest, modulesOf)].sort()).toEqual(["/assets/furniture-c.js", "/assets/motion-atlas-b.js"]);
  });

  test("a malformed manifest is an error, not zero art", () => {
    expect(() => artChunks({ "x.ts": { src: "x.ts" } }, modulesOf)).toThrow();
  });

  test("presetArt counts the art chunks it fetched; the note lists them", () => {
    const chunks = artChunks(manifest, modulesOf);
    const a = presetArt("studio", [r("/assets/motion-atlas-b.js", "script", 2048), r("/assets/stage-e.js", "script", 9999), r("/a.png", "image", 1024)], WEB, chunks);
    expect([...a.files.keys()]).toEqual([`${WEB}/assets/motion-atlas-b.js`, `${WEB}/a.png`]);
    expect(artReport([a]).note).toBe("dearest studio; studio 3.0 KB (2 files); union 3.0 KB (2 files); art in JS chunks: motion-atlas-b.js 2.0 KB");
  });
});
