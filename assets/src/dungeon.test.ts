// Dank Dungeon (OME-1670): the emote poses stand on their floor point and stay clothed in the avatar's own roles, the thrust
// loop moves only the body above the feet, and the shipped atlases list what the README promises.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATARS, composeMotion } from "./avatars";
import { BEND_FLOOR, DUNGEON_CELL, DUNGEON_DIRS, THRUST_FLOOR, THRUST_FRAMES, THRUST_OFFSET, bendGrid, thrustGrid } from "./dungeon";
import type { Grid } from "./sprite";

const ROOT = join(import.meta.dir, "..");
const lowest = (g: Grid): number => g.reduce((y, row, i) => (row.some((c) => c !== ".") ? i : y), -1);
const roles = (g: Grid): Set<string> => new Set(g.flat().filter((c) => c !== "."));

test("bend over stands on its feet and uses only the avatar's own roles", () => {
  for (const a of AVATARS) {
    const idle = roles(composeMotion(a, "idle", "se", {}));
    for (const dir of DUNGEON_DIRS) {
      const g = bendGrid(a, dir);
      expect(g.length).toBe(DUNGEON_CELL.h);
      expect(lowest(g)).toBe(BEND_FLOOR.y - 1);
      for (const r of roles(g)) expect(idle.has(r)).toBe(true);
    }
  }
});

test("thrust keeps the feet planted behind the partner and moves the hips", () => {
  for (const a of AVATARS) {
    const frames = Array.from({ length: THRUST_FRAMES }, (_, n) => thrustGrid(a, "se", n));
    const feetRow = THRUST_FLOOR.y + THRUST_OFFSET.y - 1;
    for (const g of frames) {
      expect(lowest(g)).toBe(feetRow);
      expect(g[feetRow]?.join("")).toBe(frames[0]?.[feetRow]?.join(""));
    }
    expect(frames[0]?.map((r) => r.join("")).join()).not.toBe(frames[2]?.map((r) => r.join("")).join());
  }
});

test("the shipped atlases hold every pose key and the seven v6 pieces", () => {
  const poses = JSON.parse(readFileSync(join(ROOT, "avatars", "dungeon.json"), "utf8")) as { frames: Record<string, unknown>; animations: Record<string, string[]> };
  for (const a of AVATARS) for (const d of DUNGEON_DIRS) {
    expect(poses.frames[`bendover/${a.id}/${d}/0`]).toBeDefined();
    expect(poses.animations[`thrust/${a.id}/${d}`]?.length).toBe(4);
  }
  const v6 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture-v6.json"), "utf8")) as { meta: { omega: { pieces: { id: string; seatsByDir?: object }[] } } };
  const ids = v6.meta.omega.pieces.map((p) => p.id).sort();
  expect(ids).toEqual(["bed", "desk", "minibar", "mirror", "partition", "washbasin", "whirlpool"]);
  expect(v6.meta.omega.pieces.filter((p) => p.seatsByDir).map((p) => p.id).sort()).toEqual(["bed", "whirlpool"]);
});

test("every v6 animation frame is in the atlas (the whirlpool's use loop on a seat with a front layer)", () => {
  const v6 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture-v6.json"), "utf8")) as { frames: Record<string, unknown>; animations: Record<string, string[]> };
  const keys = Object.values(v6.animations).flat();
  expect(keys.length).toBe(8);
  for (const k of keys) expect(v6.frames[k]).toBeDefined();
});

test("partition (OME-1959): solid and glass, se and sw, each with a low cut stub on the same floor point", () => {
  interface F { frame: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }
  const v6 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture-v6.json"), "utf8")) as { frames: Record<string, F>; meta: { omega: { cutKey?: string; pieces: { id: string; colours: string[]; cut?: boolean }[] } } };
  const piece = v6.meta.omega.pieces.find((p) => p.id === "partition");
  expect(piece?.colours).toEqual(["solid", "glass"]);
  expect(piece?.cut).toBe(true);
  expect(v6.meta.omega.cutKey).toBe("furniture/<id>/<colour>/cut/<dir>");
  for (const c of ["solid", "glass"]) for (const d of ["se", "sw"]) {
    const back = v6.frames[`furniture/partition/${c}/${d}/back`], cut = v6.frames[`furniture/partition/${c}/cut/${d}`];
    expect(back && cut).toBeTruthy();
    if (!back || !cut) continue;
    // Same floor point in sheet pixels from the bottom (anchors are fractions of each frame), and the stub is at most a fifth of the wall.
    expect(Math.round(cut.frame.h * (1 - cut.anchor.y))).toBe(Math.round(back.frame.h * (1 - back.anchor.y)));
    expect(Math.round(cut.frame.w * cut.anchor.x)).toBe(Math.round(back.frame.w * back.anchor.x));
    expect(cut.frame.h).toBeLessThan(back.frame.h / 5);
    expect(back.frame.h).toBeGreaterThan(212);
  }
});
