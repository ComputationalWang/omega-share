import { describe, expect, test } from "bun:test";
import { FLOOR_CELLS, type RoomLayout } from "@omega/shared";
import { CAT_RANGE, catMove, catSeed } from "../src/walk/cat";
import { cellOf, walkGrid } from "../src/walk/path";

// OME-1520: the room cat wanders with no wire. Every client works out the same target and path from the room id, the
// piece's index and the 20 s slot of server time; a member in the way makes it wait for the slot, never re-roll.

const col = (c: number): number => Math.floor(c / FLOOR_CELLS);
const row = (c: number): number => c % FLOOR_CELLS;

/** A cat in the middle of the floor, a TV, a lamp next to the cat. */
const ROOM: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "cat", col: 5, row: 5, facing: "sw" },
    { kind: "lamp", col: 6, row: 5, facing: "se" },
  ],
};
const HOME = cellOf(5, 5);
const NOBODY: ReadonlySet<number> = new Set();

function connected(path: readonly number[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] ?? -1;
    const b = path[i] ?? -1;
    if (Math.abs(col(a) - col(b)) + Math.abs(row(a) - row(b)) !== 1) return false;
  }
  return true;
}

describe("catSeed", () => {
  test("the same room, piece and slot give the same seed; any of them changing gives another", () => {
    expect(catSeed("lobby", 1, 90_000)).toBe(catSeed("lobby", 1, 90_000));
    const seeds = new Set([catSeed("lobby", 1, 90_000), catSeed("lobby", 1, 90_001), catSeed("lobby", 2, 90_000), catSeed("den", 1, 90_000)]);
    expect(seeds.size).toBe(4);
  });
});

describe("catMove", () => {
  test("two clients (each with its own grid) get the same path for the same seed", () => {
    for (let slot = 0; slot < 50; slot++) {
      const seed = catSeed("lobby", 1, slot);
      const a = catMove(walkGrid(ROOM), HOME, HOME, seed, NOBODY);
      const b = catMove(walkGrid(ROOM), HOME, HOME, seed, NOBODY);
      expect(a).toEqual(b);
    }
  });

  test("the path starts where the cat is, steps cell by cell, and ends on its home or a free cell within 3 of home", () => {
    const grid = walkGrid(ROOM);
    const ends = new Set<number>();
    let from = HOME;
    for (let slot = 0; slot < 200; slot++) {
      const path = catMove(grid, HOME, from, catSeed("lobby", 1, slot), NOBODY);
      expect(path[0]).toBe(from);
      expect(connected(path)).toBe(true);
      const end = path.at(-1) ?? -1;
      expect(Math.max(Math.abs(col(end) - 5), Math.abs(row(end) - 5))).toBeLessThanOrEqual(CAT_RANGE);
      expect(end === HOME || grid[end] === 0).toBe(true);
      for (const c of path.slice(1, -1)) expect(grid[c]).toBe(0);
      ends.add(end);
      from = end;
    }
    // It goes to many cells, never the lamp's.
    expect(ends.size).toBeGreaterThan(20);
    expect(ends.has(cellOf(6, 5))).toBe(false);
  });

  test("a member on its target or its way: it waits where it is for the slot", () => {
    const grid = walkGrid(ROOM);
    let slot = 0;
    let path: number[] = [];
    for (; slot < 500; slot++) {
      path = catMove(grid, HOME, HOME, catSeed("lobby", 1, slot), NOBODY);
      if (path.length >= 3) break;
    }
    expect(path.length).toBeGreaterThanOrEqual(3);
    const seed = catSeed("lobby", 1, slot);
    expect(catMove(grid, HOME, HOME, seed, new Set([path.at(-1) ?? -1]))).toEqual([HOME]);
    expect(catMove(grid, HOME, HOME, seed, new Set([path[1] ?? -1]))).toEqual([HOME]);
    // Someone elsewhere doesn't stop it.
    expect(catMove(grid, HOME, HOME, seed, new Set([cellOf(9, 0)]))).toEqual(path);
  });

  test("a cell within range it can't reach (walled in) is never its target", () => {
    // (8, 8) boxed in by lamps on all four sides.
    const walled: RoomLayout = {
      furniture: [
        { kind: "tv", col: 0, row: 0, facing: "se" },
        { kind: "cat", col: 5, row: 5, facing: "sw" },
        ...([[7, 8], [9, 8], [8, 7], [8, 9]] as const).map(([c, r]) => ({ kind: "lamp" as const, col: c, row: r, facing: "se" as const })),
      ],
    };
    const grid = walkGrid(walled);
    for (let slot = 0; slot < 300; slot++) expect(catMove(grid, HOME, HOME, catSeed("lobby", 1, slot), NOBODY).at(-1)).not.toBe(cellOf(8, 8));
  });
});
