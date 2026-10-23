// Lying pose (OME-1687): clothed in the avatar's own roles, eyes shut, a 2-frame breath that moves only the body, a lie anchor
// for every facing of the sofas and the cat bed, and a lazy sheet inside its 12 KB budget.
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { AVATARS, composeMotion } from "./avatars";
import { BREATH_FRAMES, LIE_ANCHORS, LIE_CELL, LIE_DIRS, LIE_STYLES, lieGrid } from "./lying";
import type { Grid } from "./sprite";

const ROOT = join(import.meta.dir, "..");
const roles = (g: Grid): Set<string> => new Set(g.flat().filter((c) => c !== "."));
const flat = (g: Grid): string => g.map((r) => r.join("")).join("\n");

test("every lying frame fits the cell and wears only the avatar's own roles", () => {
  for (const a of AVATARS) {
    const own = new Set([...roles(composeMotion(a, "idle", "se", { blink: true })), ...roles(composeMotion(a, "idle", "nw", {}))]);
    for (const st of LIE_STYLES) for (const d of LIE_DIRS) for (let n = 0; n < BREATH_FRAMES; n++) {
      const g = lieGrid(a, d, st, n);
      expect(g.length).toBe(LIE_CELL.h);
      expect(g[0]?.length).toBe(LIE_CELL.w);
      for (const r of roles(g)) expect(own.has(r)).toBe(true);
    }
  }
});

test("the breath loop is 2 frames that differ, and sw/ne mirror se/nw", () => {
  expect(BREATH_FRAMES).toBeLessThanOrEqual(2);
  for (const a of AVATARS) for (const st of LIE_STYLES) {
    expect(flat(lieGrid(a, "se", st, 0))).not.toBe(flat(lieGrid(a, "se", st, 1)));
    expect(flat(lieGrid(a, "sw", st, 0))).toBe(flat(lieGrid(a, "se", st, 0).map((r) => [...r].reverse())));
  }
});

test("both sofas and the cat bed have a lie anchor in every facing they ship", () => {
  const v1 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture.json"), "utf8")) as { meta: { omega: { pieces: { id: string; dirs: string[] }[] } } };
  const v2 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture-v2.json"), "utf8")) as typeof v1;
  for (const id of ["sofa", "couch", "cat"]) {
    const piece = [...v1.meta.omega.pieces, ...v2.meta.omega.pieces].find((p) => p.id === id);
    for (const d of piece?.dirs ?? ["missing"]) expect(LIE_ANCHORS[id]?.dirs[d as "se"]).toBeDefined();
  }
});

test("the shipped sheet lists every key and stays inside 12 KB on the wire", () => {
  const atlas = JSON.parse(readFileSync(join(ROOT, "avatars", "lying.json"), "utf8")) as { animations: Record<string, string[]>; meta: { omega: { dirs: Record<string, string[]> } } };
  for (const a of AVATARS) for (const st of LIE_STYLES) for (const d of atlas.meta.omega.dirs[st] ?? []) expect(atlas.animations[`${st}/${a.id}/${d}`]?.length).toBe(BREATH_FRAMES);
  const bytes = statSync(join(ROOT, "avatars", "lying.png")).size + gzipSync(readFileSync(join(ROOT, "avatars", "lying.json")), { level: 9 }).length;
  expect(bytes).toBeLessThanOrEqual(12 * 1024);
});

test("the sheet shares avatars.png's palette, so the tint and hair swaps apply to it", () => {
  const plte = (f: string): string => {
    const b = readFileSync(join(ROOT, "avatars", f));
    const i = b.indexOf("PLTE");
    return b.subarray(i, i + 4 + b.readUInt32BE(i - 4)).toString("hex");
  };
  expect(plte("lying.png")).toBe(plte("avatars.png"));
});
