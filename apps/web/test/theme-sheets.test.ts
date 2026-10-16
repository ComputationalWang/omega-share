// The holiday themes' real sheets (OME-1188, OME-1189): every sheet parses at the boundary, its decor hangs in the
// classic room, every avatar body frame has a hat, and it stays within the 40 KB budget (ADR 0052).
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT } from "@omega/shared";
import { RoomManifestSchema, sceneOf } from "../src/furniture";
import { decorSprites } from "../src/theme/decor";
import { ThemeManifestSchema } from "../src/theme/sheet";
import { packEffectFrames } from "../src/theme/effect";

const asset = (p: string): URL => new URL(`../../../assets/${p}`, import.meta.url);
const room = v.parse(RoomManifestSchema, await Bun.file(asset("room/room.json")).json());
const classic = sceneOf(DEFAULT_LAYOUT, [], room);

/** Every avatar frame key the room draws a body for (emote bubbles float over the head; they are not the avatar). */
const bodyFrames: string[] = [];
for (const f of ["avatars", "motion", "expressions"]) {
  const { frames } = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await Bun.file(asset(`avatars/${f}.json`)).json());
  for (const k of Object.keys(frames)) if (!k.startsWith("emote/")) bodyFrames.push(k);
}

describe("decorSprites: `wall/l` / `wall/r` repeat along every segment of that wall (assets/README.md, themes B)", () => {
  test("a garland on `wall/l` hangs once per left segment, not on the wall's open end", () => {
    const segments = classic.sprites.filter((s) => s.layer === "wall" && s.key.startsWith("wall/l/") && s.key !== "wall/l/end");
    expect(segments.length).toBeGreaterThan(1);
    expect(decorSprites(classic, [{ key: "t/garland", on: "wall/l" }])).toEqual(segments.map((s) => ({ key: "t/garland", x: s.x, y: s.y })));
  });
  test("bunting on `wall/r` hangs once per right segment", () => {
    const right = classic.sprites.filter((s) => s.layer === "wall" && s.key.startsWith("wall/r/") && s.key !== "wall/r/end");
    expect(decorSprites(classic, [{ key: "t/bunting", on: "wall/r" }])).toHaveLength(right.length);
  });
});

const SHEETS = ["halloween", "sinterklaas", "christmas", "valentines", "easter"] as const;
const raw = new Map<string, unknown>();
for (const id of SHEETS) raw.set(id, await Bun.file(asset(`themes/${id}/${id}.json`)).json());
const parseSheet = (id: string): v.InferOutput<typeof ThemeManifestSchema> => v.parse(ThemeManifestSchema, raw.get(id));

for (const id of SHEETS) {
  describe(`${id} sheet`, () => {
    test("every decor piece and effect frame is in the sheet, and every decor piece hangs in the classic room", () => {
      const { frames, meta } = parseSheet(id);
      const { decor, effect } = meta.omega;
      for (const k of [...decor.map((d) => d.key), ...effect.frames]) expect(frames[k]).toBeDefined();
      const hung = new Set(decorSprites(classic, decor).map((d) => d.key));
      expect(decor.filter((d) => !hung.has(d.key))).toEqual([]);
    });

    test("every avatar body frame (all four avatars, every facing and pose) has a hat", () => {
      const { frames, meta } = parseSheet(id);
      expect(bodyFrames.filter((k) => frames[meta.omega.hat.prefix + k] === undefined)).toEqual([]);
    });

    test("the sheet is at most 40 KB gzipped", async () => {
      expect(Bun.gzipSync(await Bun.file(asset(`themes/${id}/${id}.png`)).bytes()).length).toBeLessThanOrEqual(40 * 1024);
    });
  });
}

describe("effect timing at the boundary", () => {
  test("Christmas's snowflakes have no `ms`: they're variants, so a flake keeps its frame (step never advances)", () => {
    const sheet = parseSheet("christmas");
    expect(sheet.meta.omega.effect.ms).toBe(Number.POSITIVE_INFINITY);
    expect(Math.floor(3_600_000 / sheet.meta.omega.effect.ms)).toBe(0);
  });
  test("an animated effect keeps its frame time", () => {
    expect(parseSheet("sinterklaas").meta.omega.effect.ms).toBe(160);
  });
});

describe("packEffectFrames: the effect draws from its own small canvas, not the sheet's <img> (QA OME-1223: +2 ms work a frame on a phone)", () => {
  test("frames sit side by side from x 0, top-aligned, anchors kept; the canvas fits them exactly", () => {
    const packed = packEffectFrames([
      { sx: 100, sy: 40, w: 5, h: 5, ox: 2, oy: 2 },
      { sx: 120, sy: 40, w: 3, h: 4, ox: 1, oy: 2 },
      { sx: 9, sy: 200, w: 8, h: 7, ox: 4, oy: 3 },
    ]);
    expect(packed).toEqual({
      w: 16,
      h: 7,
      frames: [
        { sx: 0, sy: 0, w: 5, h: 5, ox: 2, oy: 2 },
        { sx: 5, sy: 0, w: 3, h: 4, ox: 1, oy: 2 },
        { sx: 8, sy: 0, w: 8, h: 7, ox: 4, oy: 3 },
      ],
    });
  });
});
