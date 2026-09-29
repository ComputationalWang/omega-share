import { MAX_ROOM_MEMBERS, SEAT_COUNT } from "@omega/shared";

/** Logical stage size; the DOM stage is CSS-scaled to fit, the canvas matches it 1:1. */
export const STAGE_W = 960;
export const STAGE_H = 600;

export const TILE_W = 64;
export const TILE_H = 32;
export const FLOOR_CELLS = 10;
/** Screen position of the floor's back corner. */
const ORIGIN_X = STAGE_W / 2;
const ORIGIN_Y = 220;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Centre of iso cell (col, row). */
export function cellCenter(col: number, row: number): Point {
  return { x: ORIGIN_X + (col - row) * (TILE_W / 2), y: ORIGIN_Y + (col + row + 1) * (TILE_H / 2) };
}

/** The TV sits on the back wall, above the floor's back corner. */
export const TV = { x: ORIGIN_X - 160, y: 24, w: 320, h: 180 } as const;

/** Two rows of four facing the TV, split by an aisle. */
const SEAT_CELLS: readonly (readonly [number, number])[] = [
  [1, 5], [2, 4], [4, 2], [5, 1],
  [3, 7], [4, 6], [6, 4], [7, 3],
];
export const SEATS: readonly Point[] = SEAT_CELLS.map(([c, r]) => cellCenter(c, r));

/** Spots for members without a seat, at the front of the room, filled in order. */
export const STANDING: readonly Point[] = (() => {
  const spots: Point[] = [];
  for (const sum of [13, 15, 17, 12, 14, 16]) {
    for (let col = 0; col < FLOOR_CELLS; col++) {
      const row = sum - col;
      if (row >= 0 && row < FLOOR_CELLS) spots.push(cellCenter(col, row));
    }
  }
  return spots.slice(0, MAX_ROOM_MEMBERS);
})();

if (SEATS.length !== SEAT_COUNT) throw new Error("layout: seat count mismatch");

/** Placeholder avatar colours until the sprites land. */
export const AVATAR_COLORS: readonly number[] = [0xe4572e, 0x29335c, 0xf3a712, 0x669bbc];
export const cssColor = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
