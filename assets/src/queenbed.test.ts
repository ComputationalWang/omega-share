// Queen bed (OME-1983): the v6 `bed` is a 2×2 double in every colour and facing, with two seats on its front half, a duvet
// cover frame per sleeper, and a `sleep` pose (head up on the pillows) with an anchor for each of two sleepers side by side.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATARS } from "./avatars";
import { BREATH_FRAMES, LIE_ANCHORS, lieGrid } from "./lying";

const ROOT = join(import.meta.dir, "..");
const DIRS = ["ne", "nw", "se", "sw"] as const;
interface F { frame: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }
interface Piece { id: string; colours: string[]; dirs: string[]; footprint: { cols: number; rows: number }; footprintByDir: Record<string, { cols: number; rows: number }>; seatsByDir?: Record<string, { col: number; row: number }[]>; layersByDir: Record<string, string[]> }
const v6 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture-v6.json"), "utf8")) as { frames: Record<string, F>; meta: { omega: { pieces: Piece[]; coverKey?: string } } };
const bed = v6.meta.omega.pieces.find((p) => p.id === "bed");

test("the bed is a 2×2 queen in all four facings, with two seats side by side on one row of its front half", () => {
  expect(bed?.footprint).toEqual({ cols: 2, rows: 2 });
  expect(bed?.dirs).toEqual([...DIRS]);
  for (const d of DIRS) {
    expect(bed?.footprintByDir[d]).toEqual({ cols: 2, rows: 2 });
    const seats = bed?.seatsByDir?.[d] ?? [];
    expect(seats.length).toBe(2);
    for (const s of seats) for (const v of [s.col, s.row]) expect(v === 0 || v === 1).toBe(true);
    expect(new Set(seats.map((s) => `${String(s.col)},${String(s.row)}`)).size).toBe(2);
  }
});

test("every bed colour and facing has a back frame wider than the twin's and a cover per sleeper in the back frame's rect", () => {
  expect(v6.meta.omega.coverKey).toBe("furniture/<id>/<colour>/cover/<dir>/<sleeper>");
  for (const c of bed?.colours ?? ["missing"]) for (const d of DIRS) {
    const back = v6.frames[`furniture/bed/${c}/${d}/back`];
    expect(back).toBeDefined();
    // A 2×2 piece spans 4 tile half-widths on screen (128 px); the twin was 96.
    expect(back?.frame.w ?? 0).toBeGreaterThan(110);
    for (const n of [0, 1]) {
      const cover = v6.frames[`furniture/bed/${c}/cover/${d}/${String(n)}`];
      expect(cover?.frame.w).toBe(back?.frame.w);
      expect(cover?.frame.h).toBe(back?.frame.h);
      expect(cover?.anchor).toEqual(back?.anchor);
    }
    expect(bed?.layersByDir[d]).toEqual(["back"]);
  }
});

test("two sleepers lie side by side: an anchor each per facing, a cell apart across the bed", () => {
  const an = LIE_ANCHORS["bed"];
  expect(an?.style).toBe("sleep");
  for (const d of DIRS) {
    const a = an?.dirs[d], b = an?.beside?.[d];
    expect(a && b).toBeTruthy();
    if (!a || !b) continue;
    // One row across a 2:1 tile: 32 px sideways and 16 down (or up).
    expect(Math.abs(a.x - b.x)).toBe(32);
    expect(Math.abs(a.y - b.y)).toBe(16);
  }
});

test("the sleep pose lies head-up toward the headboard: the face is on the high end, and sw mirrors se", () => {
  for (const a of AVATARS) for (let n = 0; n < BREATH_FRAMES; n++) {
    const se = lieGrid(a, "se", "sleep", n), sw = lieGrid(a, "sw", "sleep", n);
    // "/" axis: the high end is on the right. Skin (S) is mostly the face; the hands are near the middle.
    const skin = se.flatMap((r, y) => r.flatMap((c, x) => (c === "S" ? [{ x, y }] : [])));
    const mean = (k: "x" | "y"): number => skin.reduce((t, p) => t + p[k], 0) / skin.length;
    expect(mean("x")).toBeGreaterThan((se[0]?.length ?? 0) / 2);
    const body = se.flatMap((r, y) => r.flatMap((c) => (c !== "." ? [y] : [])));
    expect(mean("y")).toBeLessThan(body.reduce((t, y) => t + y, 0) / body.length);
    expect(sw.map((r) => r.join("")).join()).toBe(se.map((r) => [...r].reverse().join("")).join());
    expect(lieGrid(a, "nw", "sleep", n).map((r) => r.join("")).join()).toBe(se.map((r) => r.join("")).join());
  }
});

test("lying.json lists the sleep loop for every avatar in all four facings", () => {
  const atlas = JSON.parse(readFileSync(join(ROOT, "avatars", "lying.json"), "utf8")) as { frames: Record<string, unknown>; animations: Record<string, string[]>; meta: { omega: { pieces: Record<string, unknown> } } };
  for (const a of AVATARS) for (const d of DIRS) {
    expect(atlas.animations[`sleep/${a.id}/${d}`]?.length).toBe(BREATH_FRAMES);
    for (let n = 0; n < BREATH_FRAMES; n++) expect(atlas.frames[`sleep/${a.id}/${d}/${String(n)}`]).toBeDefined();
  }
  expect(atlas.meta.omega.pieces["bed"]).toBeDefined();
});
