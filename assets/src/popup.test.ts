import { describe, expect, test } from "bun:test";
import { OUTLINE, PALETTE } from "./palette";
import { encodeIndexedPng } from "./png";
import { POPUP_STATES, POPUP_VIGNETTE, buildPopupVignettes } from "./popup";

// OME-842: the extension popup's three empty/error states get small vignettes, shipped at 1× and 2× as standalone PNGs.
const files = buildPopupVignettes();
const one = files.filter((f) => !f.file.includes("@2x"));

/** Re-index to the colours used, as build.ts does, so the byte count is what ships. */
function bytes(f: { w: number; h: number; img: Uint8Array }): number {
  const used = [0, ...new Set([...f.img].filter((v) => v !== 0))];
  const pixels = f.img.map((v) => used.indexOf(v));
  return encodeIndexedPng(f.w, f.h, pixels, used.map((v) => PALETTE[v] ?? { r: 0, g: 0, b: 0, a: 0 })).length;
}

describe("popup state vignettes (OME-842)", () => {
  test("three states, each at 1× (48×40) and an exact 2× (96×80)", () => {
    expect(POPUP_STATES).toEqual(["nothing-found", "cant-read", "server-away"]);
    expect(files.map((f) => f.file).sort()).toEqual(POPUP_STATES.flatMap((s) => [`${s}.png`, `${s}@2x.png`]).sort());
    for (const s of POPUP_STATES) {
      const a = files.find((f) => f.file === `${s}.png`), b = files.find((f) => f.file === `${s}@2x.png`);
      expect([a?.w, a?.h, b?.w, b?.h]).toEqual([POPUP_VIGNETTE.w, POPUP_VIGNETTE.h, POPUP_VIGNETTE.w * 2, POPUP_VIGNETTE.h * 2]);
      for (let y = 0; y < 80; y++) for (let x = 0; x < 96; x++) expect(b?.img[y * 96 + x]).toBe(a?.img[(y >> 1) * 48 + (x >> 1)]);
    }
  });

  test("readable on the popup's white: every opaque pixel touching transparency (or the edge) is the plum outline", () => {
    for (const f of one) {
      const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= f.w || y >= f.h ? 0 : (f.img[y * f.w + x] ?? 0));
      let opaque = 0;
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        const v = at(x, y);
        if (v === 0) continue;
        opaque++;
        if (at(x - 1, y) === 0 || at(x + 1, y) === 0 || at(x, y - 1) === 0 || at(x, y + 1) === 0) expect(v).toBe(OUTLINE);
      }
      expect(opaque / (f.w * f.h)).toBeGreaterThan(0.3);
    }
  });

  test("the three states look clearly different (over a quarter of pixels differ pairwise)", () => {
    for (let i = 0; i < one.length; i++) for (let j = i + 1; j < one.length; j++) {
      const a = one[i]?.img ?? new Uint8Array(), b = one[j]?.img ?? new Uint8Array();
      let d = 0;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) d++;
      expect(d / a.length).toBeGreaterThan(0.25);
    }
  });

  test("all six files fit in 3 KB", () => {
    expect(files.reduce((n, f) => n + bytes(f), 0)).toBeLessThanOrEqual(3072);
  });
});
