import { describe, expect, test } from "bun:test";
import { OUTLINE, colorIndex } from "./palette";
import { buildResponsiveScenes } from "./responsive";

// OME-1799 judge fixes: the curtain tiles must repeat without a visible seam or a glitchy white stripe.
describe("empty-TV curtain tiles (OME-1799)", () => {
  const byKey = new Map(buildResponsiveScenes().map((f) => [f.key, f]));

  test("pelmet edge columns hold no outline or tassel, so the repeat shows no join", () => {
    const p = byKey.get("scene/curtain-pelmet");
    expect(p).toBeDefined();
    if (!p) return;
    const tassel = colorIndex("mustard", 1);
    for (let y = 3; y < 7; y++) {
      for (const x of [0, p.w - 1]) {
        expect(p.img[y * p.w + x]).not.toBe(OUTLINE);
        expect(p.img[y * p.w + x]).not.toBe(tassel);
      }
    }
  });

  test("seam is one art pixel of dim glow, never the near-white highlight", () => {
    const s = byKey.get("scene/curtain-seam");
    expect(s?.w).toBe(3);
    expect(s?.img.includes(colorIndex("glow", 0))).toBe(false);
    expect(s?.img.includes(colorIndex("glow", 1))).toBe(false);
  });
});
