// Shirt tints (OME-1347): tints touch only shirt/accent pixels, stay apart from each other and from skin/hair,
// and tints.json's PLTE slots match the shipped sheets byte for byte. OME-1360: they also stay apart under
// deuteranopia and protanopia, and clear 3:1 on the dark site bg.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATARS, composeFrame } from "./avatars";
import { RAMPS } from "./palette";
import { render } from "./sprite";
import { TINTS, applyRemap, assertTintable, contrast, deltaE, tintRamp, tintRemap, tintSpread } from "./tints";

const ROOT = join(import.meta.dir, "..");
const table = JSON.parse(readFileSync(join(ROOT, "avatars", "tints.json"), "utf8")) as {
  sheets: string[];
  avatars: Record<string, { slots: number[]; tints: { colors: string[] }[] }>;
};

/** PLTE entries of a PNG as #rrggbb. */
function plte(file: string): string[] {
  const b = readFileSync(join(ROOT, "avatars", file));
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    if (b.toString("latin1", o + 4, o + 8) === "PLTE") {
      const out: string[] = [];
      for (let i = 0; i < len; i += 3) out.push("#" + b.subarray(o + 8 + i, o + 11 + i).toString("hex"));
      return out;
    }
    o += 12 + len;
  }
  throw new Error(`${file}: no PLTE`);
}

test("Pip's small tint area never carries both olive and mustard", () => {
  const pip = TINTS["pip"] ?? [];
  expect(pip.includes("olive") && pip.includes("mustard")).toBe(false);
});

describe.each(AVATARS.map((a) => [a.id, a] as const))("%s", (_id, a) => {
  test("swatch ramp only on shirt roles, no tint reuses a ramp it already wears", () => {
    assertTintable(a);
  });
  test("tints are ΔE ≥ 20 apart (also under deutan and protan) and ≥ 20 from skin and hair", () => {
    const s = tintSpread(a);
    expect(s.tints).toBeGreaterThanOrEqual(20);
    expect(s.cvd).toBeGreaterThanOrEqual(20);
    expect(s.skinHair).toBeGreaterThanOrEqual(20);
  });
  test("every tint reads on the dark site bg (≥ 3:1, ΔE ≥ 25) and the light floor (ΔE ≥ 25)", () => {
    for (const r of TINTS[a.id] ?? []) {
      const c = tintRamp(r)[1] ?? "";
      for (const bg of ["#1d1a2b", "#1c1a2e"]) {
        expect(contrast(c, bg)).toBeGreaterThanOrEqual(3);
        expect(deltaE(c, bg)).toBeGreaterThanOrEqual(25);
      }
      expect(deltaE(c, RAMPS.floor[1])).toBeGreaterThanOrEqual(25);
    }
  });
  test("a tint changes only shirt pixels", () => {
    const g = composeFrame(a, "idle", "se", false);
    const base = render(g, a.roles);
    for (let t = 1; t < 6; t++) {
      const tinted = applyRemap(base, tintRemap(a, t));
      const changed = [...tinted].flatMap((v, i) => (v === base[i] ? [] : [g[Math.floor(i / 32)]?.[i % 32] ?? "?"]));
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.filter((ch) => !"TorxBbP".includes(ch))).toEqual([]);
    }
  });
  test("tints.json slots hold the tint-0 colours in every shipped sheet", () => {
    const row = table.avatars[a.id];
    expect(row?.tints.length).toBe(6);
    for (const f of table.sheets) {
      const p = plte(f);
      expect(row?.slots.map((i) => p[i])).toEqual([...RAMPS[a.swatch]]);
    }
  });
});
