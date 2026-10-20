import { describe, expect, test } from "bun:test";
import { FLOOR_CELLS, type RoomLayout } from "@omega/shared";
import { CAT_RANGE, CAT_SLOT_MS, catRest, catSeed, catSlot, catTarget, catWait } from "../src/walk/cat";
import { cellOf, findPath, walkGrid } from "../src/walk/path";

// OME-1520: the room cat wanders with no wire. Every client works out the same resting cell from the room id, the
// piece's index, the 20 s slot of server time and who stands where now; a member in the way makes it wait, never re-roll.

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


describe("catSeed", () => {
  test("the same room, piece and slot give the same seed; any of them changing gives another", () => {
    expect(catSeed("lobby", 1, 90_000)).toBe(catSeed("lobby", 1, 90_000));
    const seeds = new Set([catSeed("lobby", 1, 90_000), catSeed("lobby", 1, 90_001), catSeed("lobby", 2, 90_000), catSeed("den", 1, 90_000)]);
    expect(seeds.size).toBe(4);
  });
});

describe("catRest", () => {
  const rest = (grid: Uint8Array, slot: number, taken: ReadonlySet<number> = NOBODY): number => catRest(grid, HOME, "lobby", 1, slot, taken);
  const target = (grid: Uint8Array, slot: number): number => catTarget(grid, HOME, catSeed("lobby", 1, slot));

  test("two clients (each with its own grid) put the cat on the same cell for the same slot", () => {
    for (let slot = 0; slot < 50; slot++) expect(rest(walkGrid(ROOM), slot)).toBe(rest(walkGrid(ROOM), slot));
  });

  test("with nobody about it rests on the slot's target: home or a free cell within 3 of home", () => {
    const grid = walkGrid(ROOM);
    const ends = new Set<number>();
    for (let slot = 0; slot < 200; slot++) {
      const end = rest(grid, slot);
      expect(end).toBe(target(grid, slot));
      expect(Math.max(Math.abs(col(end) - 5), Math.abs(row(end) - 5))).toBeLessThanOrEqual(CAT_RANGE);
      expect(end === HOME || grid[end] === 0).toBe(true);
      ends.add(end);
    }
    // It goes to many cells, never the lamp's.
    expect(ends.size).toBeGreaterThan(20);
    expect(ends.has(cellOf(6, 5))).toBe(false);
  });

  test("a member on the way from the last slot's target to this one: it stays on the last target", () => {
    const grid = walkGrid(ROOM);
    let slot = 1;
    let path: number[] = [];
    for (; slot < 500; slot++) {
      path = findPath(grid, target(grid, slot - 1), target(grid, slot)) ?? [];
      if (path.length >= 3) break;
    }
    expect(path.length).toBeGreaterThanOrEqual(3);
    const last = target(grid, slot - 1);
    expect(rest(grid, slot, new Set([path.at(-1) ?? -1]))).toBe(last);
    expect(rest(grid, slot, new Set([path[1] ?? -1]))).toBe(last);
    // Someone elsewhere doesn't stop it.
    expect(rest(grid, slot, new Set([cellOf(9, 0)]))).toBe(target(grid, slot));
  });

  test("QA OME-1525: a member standing next to home never pins it home; where it rests needs no history", () => {
    // Every client computes the slot from scratch (a late joiner, the editor closing, a new layout), so a member on
    // the only way out of home holds it home only in slots whose last target was home.
    const grid = walkGrid(ROOM);
    const taken = new Set([cellOf(5, 4)]);
    let away = 0;
    for (let slot = 1; slot < 200; slot++) {
      const end = rest(grid, slot, taken);
      expect([target(grid, slot), target(grid, slot - 1)]).toContain(end);
      if (end !== HOME) away++;
    }
    expect(away).toBeGreaterThan(100);
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
    for (let slot = 0; slot < 300; slot++) expect(rest(grid, slot)).not.toBe(cellOf(8, 8));
  });
});

describe("the slot timer (OME-1526)", () => {
  // The clock sync refines the server offset after the timer is armed, so it can fire a hair before the boundary.
  test("a timer armed for slot 611 that fires 0.25 ms early still shows slot 611", () => {
    expect(catSlot(611 * CAT_SLOT_MS - 0.25, 611)).toBe(611);
  });
  test("then it waits for slot 612, not a whole extra slot", () => {
    expect(catWait(611 * CAT_SLOT_MS - 0.25, 611)).toBe(CAT_SLOT_MS + 1.25);
  });
  test("a late timer shows the slot it lands in", () => {
    expect(catSlot(613 * CAT_SLOT_MS + 5, 611)).toBe(613);
  });
  test("with no timer, the slot of now; the wait lands 1 ms into the next one", () => {
    expect(catSlot(611 * CAT_SLOT_MS + 7)).toBe(611);
    expect(catWait(611 * CAT_SLOT_MS + 7, 611)).toBe(CAT_SLOT_MS - 6);
  });
});
