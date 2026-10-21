import { describe, expect, test } from "bun:test";
import { PALETTE } from "./palette";
import { GLYPH_CELL, MINI, RECAP_TEXT, REACTIONS, REACTION_SEQUENCE, buildReactionFrames, contrast } from "./reactions";

const frames = buildReactionFrames();
const byKey = new Map(frames.map((f) => [f.key, f]));

/** Opaque bounding box of a frame. */
function bbox(img: Uint8Array, w: number, h: number): { w: number; h: number } {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((img[y * w + x] ?? 0) !== 0) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe("reaction glyphs (OME-1641)", () => {
  test("heart, laugh, wow and clap, at most 6 frames each", () => {
    expect(REACTIONS.map((r) => r.id)).toEqual(["heart", "laugh", "wow", "clap"]);
    expect(REACTION_SEQUENCE.length).toBeLessThanOrEqual(6);
    for (const r of REACTIONS) {
      const keys = frames.filter((f) => f.key.startsWith(`react/${r.id}/`));
      expect(keys.length).toBe(REACTION_SEQUENCE.length);
    }
  });

  test("every glyph fits 16 px wide, inside its cell, and the 4 settled glyphs all differ", () => {
    for (const f of frames.filter((f) => f.key.startsWith("react/"))) {
      expect(f.w).toBe(GLYPH_CELL.w);
      expect(f.h).toBe(GLYPH_CELL.h);
      expect(bbox(f.img, f.w, f.h).w).toBeLessThanOrEqual(16);
      // A clear column on each side and a clear top row: nothing touches the cell border.
      for (let y = 0; y < f.h; y++) expect([f.img[y * f.w], f.img[y * f.w + f.w - 1]]).toEqual([0, 0]);
      expect([...f.img.subarray(0, f.w)].every((v) => v === 0)).toBe(true);
    }
    const settled = REACTIONS.map((r) => byKey.get(`react/${r.id}/1`)?.img.join(","));
    expect(new Set(settled).size).toBe(4);
  });

  test("the glyph rises and fades out (later frames sit higher and hold fewer pixels)", () => {
    for (const r of REACTIONS) {
      const n = (k: number): number => [...(byKey.get(`react/${r.id}/${String(k)}`)?.img ?? [])].filter((v) => v !== 0).length;
      expect(n(5)).toBeLessThan(n(4));
      expect(n(4)).toBeLessThan(n(3));
    }
  });

  test("a mini icon per reaction plus the strip's own icons, 9×9 (18 CSS px in page chrome)", () => {
    for (const id of [...REACTIONS.map((r) => r.id), "top", "catchup"]) {
      const f = byKey.get(`moments/${id}`);
      expect(f?.w).toBe(MINI);
      expect(f?.h).toBe(MINI);
    }
  });
});

describe("recap card chrome (OME-1641)", () => {
  test("every text/background pair passes WCAG AA (4.5:1)", () => {
    for (const p of RECAP_TEXT) expect(contrast(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("its colours are palette colours", () => {
    const hexes = new Set(PALETTE.slice(1).map((c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`));
    for (const p of RECAP_TEXT) {
      expect(hexes.has(p.fg)).toBe(true);
      expect(hexes.has(p.bg)).toBe(true);
    }
  });
});
