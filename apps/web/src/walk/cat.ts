// The room cat wanders (OME-1520), with no wire: every client works out the same walk from the room id, the piece's
// index and the 20 s slot of server time. A slot's target is its home or a free cell within 3 of it that home reaches;
// a member on the target or the way makes it wait out the slot where it is (no re-roll, so clients stay in step).
// Runs once per cat per slot, never per frame.
import { FLOOR_CELLS } from "@omega/shared";
import { colOf, findPath, rowOf } from "./path";

export const CAT_SLOT_MS = 20_000;
/** How far from home a target may be, in cells along each axis. */
export const CAT_RANGE = 3;

/** FNV-1a over `room:piece:slot`: the same 32-bit seed on every client. */
export function catSeed(roomId: string, piece: number, slot: number): number {
  const s = `${roomId}:${String(piece)}:${String(slot)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** One mulberry32 step: spreads a seed's bits so neighbouring slots pick unrelated cells. */
function mix(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/**
 * The cat's walk this slot: from `from` (where it rests) to its target, both included, or `[from]` when a member
 * (`taken`, walk cells) stands on the target or the way. `grid` is the layout's walk grid (home is the cat's own solid cell).
 */
export function catMove(grid: Uint8Array, home: number, from: number, seed: number, taken: ReadonlySet<number>): number[] {
  const hc = colOf(home);
  const hr = rowOf(home);
  const cells: number[] = [];
  for (let c = Math.max(0, hc - CAT_RANGE); c <= Math.min(FLOOR_CELLS - 1, hc + CAT_RANGE); c++) {
    for (let r = Math.max(0, hr - CAT_RANGE); r <= Math.min(FLOOR_CELLS - 1, hr + CAT_RANGE); r++) {
      const cell = c * FLOOR_CELLS + r;
      if (cell === home || (grid[cell] === 0 && findPath(grid, home, cell) !== null)) cells.push(cell);
    }
  }
  const target = cells[mix(seed) % cells.length] ?? home;
  const path = findPath(grid, from, target);
  if (path === null || path.slice(1).some((c) => taken.has(c))) return [from];
  return path;
}

/** The slot's target: home or a free cell within CAT_RANGE of it that home reaches. */
export function catTarget(_grid: Uint8Array, home: number, _seed: number): number {
  return home;
}

/** Where the cat rests in `slot`. */
export function catRest(_grid: Uint8Array, home: number, _roomId: string, _piece: number, _slot: number, _taken: ReadonlySet<number>): number {
  return home;
}
