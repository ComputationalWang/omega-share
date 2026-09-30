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

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * YouTube's Required Minimum Functionality: the player is at least 200×200 CSS px and nothing
 * of ours covers it. So the TV lives outside the scaled stage, at 16:9 and never below 356×200.
 */
const TV_MIN_W = 356;
const TV_MAX_W = 560;
/** Room for the TV's bezel, drawn as an outline outside the player rect. */
const TV_BEZEL = 6;
const GAP = 8;
/** Set (e) chrome at 1×: 8 px panel border + 4 px padding around a 20 px key, top and bottom. */
export const CONTROL_BAR_H = 44;

/** Everything in container CSS px. `stage` is the scaled 960×600 stage's box on the page. */
export interface RoomLayout {
  readonly tv: Rect;
  readonly controls: Rect;
  readonly stage: Rect;
  readonly scale: number;
  readonly height: number;
}

export function roomLayout(containerWidth: number): RoomLayout {
  const width = Math.floor(containerWidth);
  const tvW = Math.max(TV_MIN_W, Math.min(TV_MAX_W, width - 2 * TV_BEZEL));
  const tv = { x: Math.max(0, Math.floor((width - tvW) / 2)), y: TV_BEZEL, w: tvW, h: Math.round((tvW * 9) / 16) };
  const controls = { x: tv.x, y: tv.y + tv.h + GAP, w: tv.w, h: CONTROL_BAR_H };
  const scale = Math.min(1, width / STAGE_W);
  const stage = { x: 0, y: controls.y + controls.h + GAP, w: STAGE_W * scale, h: STAGE_H * scale };
  return { tv, controls, stage, scale, height: stage.y + stage.h };
}

/** A stage-space rect on the page. */
export function stageToPage(l: RoomLayout, r: Rect): Rect {
  return { x: l.stage.x + r.x * l.scale, y: l.stage.y + r.y * l.scale, w: r.w * l.scale, h: r.h * l.scale };
}

/** Name tags hang below the avatar's feet; `style.css` caps them at this box. */
export const TAG_OFFSET_Y = 10;
export const TAG_MAX_W = 160;
export const TAG_H = 20;
/** Bubbles float above the head, bottom-anchored; `style.css` caps them at this box. */
export const BUBBLE_OFFSET_Y = -48;
export const BUBBLE_MAX_W = 220;
export const BUBBLE_MAX_H = 180;

export function tagRect(p: Point): Rect {
  return { x: p.x - TAG_MAX_W / 2, y: p.y + TAG_OFFSET_Y, w: TAG_MAX_W, h: TAG_H };
}

export function bubbleRect(p: Point): Rect {
  return { x: p.x - BUBBLE_MAX_W / 2, y: p.y + BUBBLE_OFFSET_Y - BUBBLE_MAX_H, w: BUBBLE_MAX_W, h: BUBBLE_MAX_H };
}

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
