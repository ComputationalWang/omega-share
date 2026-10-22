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

test("the shipped atlases hold every pose key and the six v6 pieces", () => {
  const poses = JSON.parse(readFileSync(join(ROOT, "avatars", "dungeon.json"), "utf8")) as { frames: Record<string, unknown>; animations: Record<string, string[]> };
  for (const a of AVATARS) for (const d of DUNGEON_DIRS) {
    expect(poses.frames[`bendover/${a.id}/${d}/0`]).toBeDefined();
    expect(poses.animations[`thrust/${a.id}/${d}`]?.length).toBe(4);
  }
  const v6 = JSON.parse(readFileSync(join(ROOT, "furniture", "furniture-v6.json"), "utf8")) as { meta: { omega: { pieces: { id: string; seatsByDir?: object }[] } } };
  const ids = v6.meta.omega.pieces.map((p) => p.id).sort();
  expect(ids).toEqual(["bed", "desk", "minibar", "mirror", "washbasin", "whirlpool"]);
  expect(v6.meta.omega.pieces.filter((p) => p.seatsByDir).map((p) => p.id).sort()).toEqual(["bed", "whirlpool"]);
});
