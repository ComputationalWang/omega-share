// The cell cursor outline: the owner editor's keyboard cursor (OME-1245) and free walking's hover diamond (OME-1350). One
// Graphics, redrawn only on input. Outside editor/ so the room can draw it without loading the lazy editor chunk.
import type { Graphics } from "pixi.js";
import { TILE_H, TILE_W, cellCenter } from "./layout";
import type { Slot } from "./editor/pick";

/**
 * The keyboard cursor's dark and light line widths in stage px, for a stage shown at `scale` screen px per stage px. The
 * editor shows the room small (≈0.29 at 1280×720), so the lines grow to stay ≥2 px light inside ≥5 px dark on screen
 * (QA OME-1274); at full size and above, the drawn design.
 */
export function cursorStrokes(scale: number): { readonly dark: number; readonly light: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { dark: Math.max(5, 5 / s), light: Math.max(2.5, 2 / s) };
}

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
  // Closed: without it Pixi strokes an open path and the fourth side is missing.
  g.clear().poly(points, true).stroke({ width: w.dark, color: 0x101018 }).poly(points, true).stroke({ width: w.light, color: 0xffffff });
}
