// Theatre set v2 (OME-1639): its own lazy sheet, furniture-v5, with the kinds proposed to contract B (OME-1625), raised rows
// that tell the web how far to lift a sitter, and the whole set inside its +30 KB compressed budget.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = join(import.meta.dir, "..");
interface Piece {
  id: string;
  layer: string;
  mount: string;
  colours: string[];
  dirs: string[];
  footprint: { cols: number; rows: number };
  walkable: boolean;
  seatsByDir?: Record<string, { col: number; row: number; dir: string }[]>;
  seatLiftByColour?: Record<string, number>;
  layersByDir: Record<string, string[]>;
}
const atlasPath = join(ROOT, "furniture", "furniture-v5.json");
const atlas = (): { frames: Record<string, unknown>; meta: { image: string; omega: { license: string; pieces: Piece[] } } } =>
  JSON.parse(readFileSync(atlasPath, "utf8")) as never;
const piece = (id: string): Piece => {
  const p = atlas().meta.omega.pieces.find((q) => q.id === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
};

describe("theatre sheet (furniture-v5)", () => {
  test("ships the five theatre kinds, CC BY-SA", () => {
    expect(existsSync(atlasPath)).toBe(true);
    const a = atlas();
    expect(a.meta.image).toBe("furniture-v5.png");
    expect(a.meta.omega.license).toBe("CC-BY-SA-4.0");
    expect(a.meta.omega.pieces.map((p) => p.id).sort()).toEqual(["aislelight", "bigscreen", "carpet", "curtain", "theatrerow"]);
  });

  test("specs match the contract B proposal", () => {
    const spec = (id: string): unknown => {
      const p = piece(id);
      return { layer: p.layer, dirs: p.dirs, footprint: p.footprint, variants: p.colours.length, seats: p.seatsByDir !== undefined };
    };
    expect(spec("theatrerow")).toEqual({ layer: "object", dirs: ["ne", "nw"], footprint: { cols: 2, rows: 1 }, variants: 3, seats: true });
    expect(spec("curtain")).toEqual({ layer: "wall", dirs: ["se", "sw"], footprint: { cols: 0, rows: 0 }, variants: 1, seats: false });
    expect(spec("bigscreen")).toEqual({ layer: "object", dirs: ["se"], footprint: { cols: 1, rows: 1 }, variants: 1, seats: false });
    expect(spec("aislelight")).toEqual({ layer: "floor", dirs: ["ne", "nw"], footprint: { cols: 1, rows: 1 }, variants: 1, seats: false });
    expect(spec("carpet")).toEqual({ layer: "floor", dirs: ["se"], footprint: { cols: 2, rows: 2 }, variants: 1, seats: false });
  });

  test("raised rows: variant n lifts its sitters n riser steps, and the backrests draw over them", () => {
    const row = piece("theatrerow");
    expect(row.colours).toEqual(["floor", "step", "high"]);
    expect(row.seatLiftByColour).toEqual({ floor: 0, step: 10, high: 20 });
    for (const d of row.dirs) expect(row.layersByDir[d]).toEqual(["back", "front"]);
  });

  test("every frame the manifest names is in the atlas", () => {
    const a = atlas();
    for (const p of a.meta.omega.pieces) for (const c of p.colours) for (const d of p.dirs) for (const l of p.layersByDir[d] ?? []) {
      expect(a.frames[`furniture/${p.id}/${c}/${d}/${l}`]).toBeDefined();
    }
  });

  test("the set stays inside +30 KB compressed", () => {
    const png = readFileSync(join(ROOT, "furniture", "furniture-v5.png")).length;
    const json = gzipSync(readFileSync(atlasPath)).length;
    expect(png + json).toBeLessThanOrEqual(30 * 1024);
  });

  test("the judge's previews exist", () => {
    for (const f of ["theatre-room@1x.png", "theatre-room@2x.png", "theatre-seats@2x.png", "furniture-v5-atlas@2x.png"]) expect(existsSync(join(ROOT, "preview", f))).toBe(true);
  });
});
