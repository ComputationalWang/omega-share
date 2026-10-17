// The owner editor's keyboard cursor outline (OME-1245): one Graphics, redrawn only on key input. Part of the lazy editor chunk.
import type { Graphics } from "pixi.js";
import { TILE_H, TILE_W, cellCenter } from "../layout";
import { cursorStrokes, type Slot } from "./pick";

/** How tall the keyboard cursor's frame stands on a wall slot. */
const WALL_CURSOR_H = 64;

/** The keyboard cursor's outline: the cell's diamond, or the wall face above its back edge. Dark under light, so one of the two lines has 3:1 on any floor or wall. */
export function drawCursor(g: Graphics, s: Slot, scale: number): void {
  const p = cellCenter(s.col, s.row);
  const top = { x: p.x, y: p.y - TILE_H / 2 };
  const side = { x: s.wall === "se" ? p.x - TILE_W / 2 : p.x + TILE_W / 2, y: p.y };
  const points =
    s.wall === null
      ? [top.x, top.y, p.x + TILE_W / 2, p.y, p.x, p.y + TILE_H / 2, p.x - TILE_W / 2, p.y]
      : [top.x, top.y, side.x, side.y, side.x, side.y - WALL_CURSOR_H, top.x, top.y - WALL_CURSOR_H];
  const w = cursorStrokes(scale);
  g.clear().poly(points).stroke({ width: w.dark, color: 0x101018 }).poly(points).stroke({ width: w.light, color: 0xffffff });
}
