import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTLINE } from "./palette";
import { POPUP_KIT_SLICES } from "./popupkit";
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
});

describe("popup kit (OME-1041)", () => {
  const css = readFileSync(join(import.meta.dir, "..", "ui", "popup", "kit.css"), "utf8");
  test("every slice kit.css points at is in POPUP_KIT_SLICES, and every listed slice is used", () => {
    const used = new Set([...css.matchAll(/\.\.\/slices\/([a-z0-9-]+)\.png/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...POPUP_KIT_SLICES].sort());
  });
});
