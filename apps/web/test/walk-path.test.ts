import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, FLOOR_CELLS, layoutSeats, type RoomLayout } from "@omega/shared";
import { cellCenter } from "../src/layout";
import { standingPoints } from "../src/furniture";
import { DOOR, cellAt, cellOf, findPath, walkGrid } from "../src/walk/path";

// OME-408: avatars walk on the layout grid, once per seat change. Solid pieces block; the start and goal may be solid
// (a seat is its armchair's cell).

const at = (col: number, row: number): number => cellOf(col, row);
const seatCells = (l: RoomLayout): number[] => layoutSeats(l).map((s) => at(s.col, s.row));

/** Every step moves one cell along a grid axis (an iso direction: ne/nw/se/sw). */
function connected(path: readonly number[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] ?? -1;
    const b = path[i] ?? -1;
    const dc = Math.abs(Math.floor(a / FLOOR_CELLS) - Math.floor(b / FLOOR_CELLS));
    const dr = Math.abs((a % FLOOR_CELLS) - (b % FLOOR_CELLS));
    if (dc + dr !== 1) return false;
  }
  return true;
}

describe("cellAt", () => {
  test("maps a cell's floor point back to the cell, and anything off the floor to -1", () => {
    expect(cellAt(cellCenter(0, 0))).toBe(at(0, 0));
    expect(cellAt(cellCenter(3, 7))).toBe(at(3, 7));
    expect(cellAt(cellCenter(9, 9))).toBe(at(9, 9));
    expect(cellAt({ x: 0, y: 0 })).toBe(-1);
    expect(cellAt(cellCenter(10, 0))).toBe(-1);
  });
});

describe("walkGrid", () => {
  test("solid pieces block their cells; rugs and empty floor don't", () => {
    const g = walkGrid(DEFAULT_LAYOUT);
    expect(g[at(0, 0)]).toBe(1); // tv
    expect(g[at(1, 5)]).toBe(1); // armchair
    expect(g[at(0, 9)]).toBe(1); // plant
    expect(g[at(3, 3)]).toBe(0); // rug
    expect(g[at(9, 9)]).toBe(0);
  });
});

describe("findPath", () => {
  const grid = walkGrid(DEFAULT_LAYOUT);

  test("door to every seat: a connected, shortest path that never crosses a solid cell between its ends", () => {
    for (const seat of seatCells(DEFAULT_LAYOUT)) {
      const path = findPath(grid, DOOR, seat);
      expect(path).not.toBeNull();
      if (path === null) continue;
      expect(path[0]).toBe(DOOR);
      expect(path.at(-1)).toBe(seat);
      expect(connected(path)).toBe(true);
      expect(path.slice(1, -1).every((c) => grid[c] === 0)).toBe(true);
    }
  });

  test("on open floor it is a shortest path (Manhattan length)", () => {
    const path = findPath(grid, at(9, 9), at(6, 8));
    expect(path?.length).toBe(3 + 1 + 1);
  });

  test("goes around solid pieces: diagonal seats (1,5) and (2,4) share no edge, so one free cell lies between", () => {
    const path = findPath(grid, at(1, 5), at(2, 4));
    expect(path).not.toBeNull();
    expect(connected(path ?? [])).toBe(true);
    expect((path ?? []).length).toBe(3);
  });

  test("from a seat to a standing spot and back", () => {
    const spot = cellAt(standingPoints(DEFAULT_LAYOUT)[0] ?? { x: 0, y: 0 });
    const seat = seatCells(DEFAULT_LAYOUT)[4] ?? -1;
    expect(connected(findPath(grid, seat, spot) ?? [])).toBe(true);
    expect(connected(findPath(grid, spot, seat) ?? [])).toBe(true);
  });

  test("same cell: a one-cell path", () => {
    expect(findPath(grid, at(4, 4), at(4, 4))).toEqual([at(4, 4)]);
  });

  test("an unreachable goal gives null", () => {
    // A goal walled in on all four sides.
    const g = walkGrid(DEFAULT_LAYOUT);
    for (const c of [at(7, 8), at(9, 8), at(8, 7), at(8, 9)]) g[c] = 1;
    expect(findPath(g, DOOR, at(8, 8))).toBeNull();
  });

  test("8 paths (door to each seat) take well under 1 ms each", () => {
    const seats = seatCells(DEFAULT_LAYOUT);
    for (let i = 0; i < 50; i++) for (const s of seats) findPath(grid, DOOR, s);
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) for (const s of seats) findPath(grid, DOOR, s);
    const perPath = (performance.now() - t0) / (runs * seats.length);
    expect(perPath).toBeLessThan(1);
  });
});
