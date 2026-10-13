import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTLINE, RAMPS, colorIndex } from "./palette";
import { POPUP_KIT_SLICES, brightDots } from "./popupkit";
import { TOOLBAR_SIZES, lampGeom, renderFoundIcon, renderIcon } from "./store";

// OME-1041: the toolbar's found state and the popup kit the extension copies.
describe("toolbar found icon (OME-1041)", () => {
  for (const S of TOOLBAR_SIZES) {
    const pad = S === 48 ? 1 : 0;
    const idle = renderIcon(S, pad), found = renderFoundIcon(S, pad);
    test(`${String(S)} px: only the lamp's corner changes, and its edge on the toolbar is plum`, () => {
      const { r, cx, cy } = lampGeom(S, pad);
      let changed = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        if (found[y * S + x] === idle[y * S + x]) continue;
        changed++;
        expect(Math.hypot(x + 0.5 - cx, y + 0.5 - cy)).toBeLessThan(r + 1.5);
      }
      expect(changed).toBeGreaterThan(r * r * 2);
      const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= S || y >= S ? 0 : (found[y * S + x] ?? 0));
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const v = at(x, y);
        if (v !== 0 && (at(x - 1, y) === 0 || at(x + 1, y) === 0 || at(x, y - 1) === 0 || at(x, y + 1) === 0)) expect(v).toBe(OUTLINE);
      }
    });
  }
  test("16 px (OME-1061): the lamp has a light mustard rim inside its plum ring, so it holds on #f9f9fb", () => {
    const { r, cx, cy } = lampGeom(16, 0);
    const inDisc = (x: number, y: number): boolean => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r;
    const found = renderFoundIcon(16, 0), light = colorIndex("mustard", 0);
    let rim = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (!inDisc(x, y) || (inDisc(x - 1, y) && inDisc(x + 1, y) && inDisc(x, y - 1) && inDisc(x, y + 1))) continue;
      rim++;
      expect(found[y * 16 + x]).toBe(light);
    }
    expect(rim).toBeGreaterThan(8);
    expect(r).toBeLessThan(3.3);
  });
});

describe("popup kit (OME-1041)", () => {
  const css = readFileSync(join(import.meta.dir, "..", "ui", "popup", "kit.css"), "utf8");
  test("every slice kit.css points at is in POPUP_KIT_SLICES, and every listed slice is used", () => {
    const used = new Set([...css.matchAll(/\.\.\/slices\/([a-z0-9-]+)\.png/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...POPUP_KIT_SLICES].sort());
  });
});

// OME-1061: the judge asked for more contrast on the popup's muted host text and the scanning dots.
describe("popup kit contrast (OME-1061)", () => {
  const css = readFileSync(join(import.meta.dir, "..", "ui", "popup", "kit.css"), "utf8");
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
  };
  const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  test("the host and the state line use --ui-hint, a palette colour at ≥ 10:1 on the panel", () => {
    expect(css).toMatch(/\.pk-head \.host \{[^}]*color: var\(--ui-hint\)/);
    expect(css).toMatch(/\.pk-state \{[^}]*color: var\(--ui-hint\)/);
    const hint = /--ui-hint: (#[0-9a-f]{6});/.exec(css)?.[1] ?? "";
    expect(Object.values(RAMPS).flat()).toContain(hint);
    expect(ratio(hint, RAMPS.charcoal[2])).toBeGreaterThanOrEqual(10);
  });
  test("brightDots lifts the resting dots off cream[2]", () => {
    const dim = colorIndex("cream", 2);
    const img = new Uint8Array([0, dim, colorIndex("cream", 0), dim]);
    const out = brightDots(img);
    expect([...out]).not.toContain(dim);
    expect(out[0]).toBe(0);
  });
});
