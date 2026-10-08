// Walk paths on the room's floor grid (OME-408). A cell is `col * FLOOR_CELLS + row`. Solid pieces block their cells;
// the ends of a walk may be solid (a seat is its chair's cell). BFS over 4 neighbours, i.e. the four iso directions.
// Runs once per seat change, never per frame.
import { FLOOR_CELLS, FURNITURE, footprintCells, type RoomLayout } from "@omega/shared";
import { TILE_H, TILE_W, cellCenter, type Point } from "../layout";

const N = FLOOR_CELLS * FLOOR_CELLS;

export const cellOf = (col: number, row: number): number => col * FLOOR_CELLS + row;
export const colOf = (cell: number): number => Math.floor(cell / FLOOR_CELLS);
export const rowOf = (cell: number): number => cell % FLOOR_CELLS;
export const centerOf = (cell: number): Point => cellCenter(colOf(cell), rowOf(cell));

/** Where people walk in from: the floor's front corner, nearest the camera. */
export const DOOR = cellOf(FLOOR_CELLS - 1, FLOOR_CELLS - 1);

/** The cell whose floor point is `p` (the inverse of `cellCenter`), or -1 off the floor. */
export function cellAt(p: Point): number {
  const origin = cellCenter(0, 0);
  const diff = (p.x - origin.x) / (TILE_W / 2); // col - row
  const sum = (p.y - origin.y) / (TILE_H / 2); // col + row
  const col = Math.round((sum + diff) / 2);
  const row = Math.round((sum - diff) / 2);
  return col >= 0 && col < FLOOR_CELLS && row >= 0 && row < FLOOR_CELLS ? cellOf(col, row) : -1;
}

/** 1 for every cell a solid piece stands on. Built once per layout. */
export function walkGrid(layout: RoomLayout): Uint8Array {
  const g = new Uint8Array(N);
  for (const f of layout.furniture) {
    if (FURNITURE[f.kind].layer !== "object") continue;
    for (const [c, r] of footprintCells(f)) if (c < FLOOR_CELLS && r < FLOOR_CELLS) g[cellOf(c, r)] = 1;
  }
  return g;
}

const prev = new Int16Array(N);
const queue = new Int16Array(N);

/** Shortest 4-neighbour path from `from` to `to`, both included; null if solid cells cut them apart. */
export function findPath(grid: Uint8Array, from: number, to: number): number[] | null {
  if (from < 0 || from >= N || to < 0 || to >= N) return null;
  prev.fill(-1);
  prev[from] = from;
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  while (head < tail) {
    const c = queue[head++] ?? 0;
    if (c === to) break;
    const col = colOf(c);
    const row = rowOf(c);
    for (let k = 0; k < 4; k++) {
      const nc = k === 0 ? col + 1 : k === 1 ? col - 1 : col;
      const nr = k === 2 ? row + 1 : k === 3 ? row - 1 : row;
      if (nc < 0 || nc >= FLOOR_CELLS || nr < 0 || nr >= FLOOR_CELLS) continue;
      const n = cellOf(nc, nr);
      if (prev[n] !== -1 || (grid[n] === 1 && n !== to)) continue;
      prev[n] = c;
      queue[tail++] = n;
    }
  }
  if (prev[to] === -1) return null;
  const path = [to];
  for (let c = to; c !== from; ) {
    c = prev[c] ?? from;
    path.push(c);
  }
  return path.reverse();
}
