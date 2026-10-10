// Where set (l)'s emote wheel opens (OME-732), in viewport px. Page chrome at 2× (assets/README.md § Set (l)): the
// 77 art px disc, its 9×7 tail hanging from 3 px above the rim, the label chip above it.
import type { Point, Rect } from "../layout";

const PX = 2;
/** The disc, CSS px. */
export const WHEEL_SIZE = 77 * PX;
/** From the wheel's top to its tail tip (reference.css `.ui-wheel::after`: top 100% − 3, 7 tall). */
const TAIL_TIP = WHEEL_SIZE + (7 - 3) * PX;
/** Room kept above the wheel for the label chip (`.ui-wheel-label`: a 2× chip and its 3 px gap). */
const CHIP_ROOM = 34;
/** Docked, the wheel sits this far above the composer. */
const DOCK_GAP = 4 * PX;

export interface WheelPlace {
  readonly x: number;
  readonly y: number;
  /** False when docked or clamped sideways: the tail would point past you. */
  readonly tail: boolean;
}

/**
 * Over `head` (your avatar's emote point, viewport px) with the tail tip on it, if that's inside `room` (the room's
 * visible box) with the wheel and its chip fitting above; clamped sideways inside the room. Otherwise docked centred
 * above `dock` (the composer).
 */
export function placeWheel(head: Point | null, room: Rect, dock: Rect): WheelPlace {
  if (head !== null && room.w >= WHEEL_SIZE) {
    const inRoom = head.x >= room.x && head.x <= room.x + room.w && head.y >= room.y && head.y <= room.y + room.h;
    const left = Math.round(head.x - WHEEL_SIZE / 2);
    const top = Math.round(head.y) - TAIL_TIP;
    if (inRoom && top - CHIP_ROOM >= room.y) {
      const x = Math.min(Math.max(left, Math.ceil(room.x)), Math.floor(room.x + room.w) - WHEEL_SIZE);
      return { x, y: top, tail: x === left };
    }
  }
  return { x: Math.max(0, Math.round(dock.x + dock.w / 2 - WHEEL_SIZE / 2)), y: Math.max(CHIP_ROOM, Math.round(dock.y) - WHEEL_SIZE - DOCK_GAP), tail: false };
}
