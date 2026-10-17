// Shirt tints (OME-1347): tints touch only shirt/accent pixels, stay apart from each other and from skin/hair,
// and tints.json's PLTE slots match the shipped sheets byte for byte.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATARS, composeFrame } from "./avatars";
import { RAMPS } from "./palette";
import { render } from "./sprite";
import { TINTS, applyRemap, assertTintable, deltaE, tintRemap, tintSpread } from "./tints";

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

describe.each(AVATARS.map((a) => [a.id, a] as const))("%s", (_id, a) => {
  test("swatch ramp only on shirt roles, no tint reuses a ramp it already wears", () => {
    assertTintable(a);
  });
  test("tints are ΔE ≥ 20 apart and ≥ 20 from skin and hair", () => {
    const s = tintSpread(a);
    expect(s.tints).toBeGreaterThanOrEqual(20);
    expect(s.skinHair).toBeGreaterThanOrEqual(20);
  });
  test("every tint reads on the dark site bg and the light floor (ΔE ≥ 25)", () => {
    for (const r of TINTS[a.id] ?? []) {
      expect(deltaE(RAMPS[r][1], "#1d1a2b")).toBeGreaterThanOrEqual(25);
      expect(deltaE(RAMPS[r][1], RAMPS.floor[1])).toBeGreaterThanOrEqual(25);
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
