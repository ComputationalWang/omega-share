// OME-1670: the "Dank Dungeon" room's meme emote poses. Slapstick, fully clothed: B bends forward at the waist with
// hands on knees and grins back over the shoulder at the camera; A stands behind B and does a silly hip-thrust dance.
// Both are built from the set (a) idle frame (composeMotion), so heads, hair, hats, shirts and the shading are the
// avatar's own: the head block is moved, the body below it is redrawn (bend) or sheared row by row (thrust).
import { composeMotion, type AvatarDef, type Dir } from "./avatars";
import { blank, mirror, stamp, type Grid } from "./sprite";

/** Wider than the 32×64 avatar cell: a bent body reaches forward, and the thrust frame stands behind its partner. */
export const DUNGEON_CELL = { w: 48, h: 64 } as const;
/** `bendover`: the bender's own floor point (feet). */
export const BEND_FLOOR = { x: 24, y: 61 } as const;
/** `thrust`: the **partner's** floor point (the bender's cell centre). The thruster stands up-left of it, a little behind. */
export const THRUST_FLOOR = { x: 38, y: 61 } as const;
/** Where the thruster's own feet sit relative to the partner's floor point, in px (facing se; mirror x for sw). */
export const THRUST_OFFSET = { x: -11, y: -5 } as const;
export const DUNGEON_DIRS: readonly Dir[] = ["se", "sw"];

/** Hip-thrust loop: back, mid, forward; played 0 1 2 1. */
export const THRUST_FRAMES = 3;
export const THRUST_SEQUENCE: readonly number[] = [0, 1, 2, 1];
export const THRUST_MS = 110;

const PAD = (DUNGEON_CELL.w - 32) / 2;
/** Set (a) idle, facing se, padded to the wider cell. Rows: head block < 40, torso 40–50, legs 51–60. */
function idleWide(a: AvatarDef): Grid {
  const g = composeMotion(a, "idle", "se", {});
  return g.map((row) => [...Array<string>(PAD).fill("."), ...row, ...Array<string>(PAD).fill(".")]);
}

function copyRows(from: Grid, to: Grid, y0: number, y1: number, dx: number, dy: number): void {
  for (let y = y0; y <= y1; y++) {
    const src = from[y], dst = to[y + dy];
    if (!src || !dst) continue;
    src.forEach((ch, x) => {
      if (ch !== "." && x + dx >= 0 && x + dx < dst.length) dst[x + dx] = ch;
    });
  }
}

const finish = (g: Grid, dir: Dir): Grid => (dir === "sw" ? mirror(g) : g);

// Bent torso, drawn facing se at cell x 12, y 36: shirt (T), far arm (r, shade) reaching down to the far knee, near arm (T)
// to the near knee, hands (S) on the knees, hips (B) pushed up and back.
const BENT = [
  "..........TTTTTTTTTTT.....",
  "......TTTTTTTTTTTTTTTTT...",
  "....TTTTTTTTTTTTTTTTTTTT..",
  "...BTTTTTTTTTTTTTTTTTTTT..",
  "..BBBTTTTTTTTTTTTTTTTTTr..",
  "..BBBBTTTTTTTTTTTTTTTTrr..",
  "..BBBBBBTTTTTTTTTTTTTrrr..",
  "..BBBBBBBBTTTTTTTTTTrrr...",
  "..BBBBBBBBBB..TTT..rrr....",
  "...BBBBBBBBB..TTT.rrr.....",
  "....BBBBBBBB.TTT.rrr......",
  "......BBBBBB.TTTrrr.......",
  "........BBB.SSSSSS........",
  "............SSSSS.........",
];

/** `bendover`: legs straight, bent 90° at the waist, hands on knees, the head lifted to grin at the camera. */
export function bendGrid(a: AvatarDef, dir: Dir): Grid {
  const idle = idleWide(a);
  const g = blank(DUNGEON_CELL.w, DUNGEON_CELL.h);
  copyRows(idle, g, 51, 60, 0, 0);
  stamp(g, BENT, 12, 39);
  copyRows(idle, g, 0, 39, 10, 9);
  // Kiki keeps her popcorn: the bucket waits on the floor in front of her feet.
  if (a.holds === true) stamp(g, [".YYYYY.", "YYYYYYY", "PRPRPRP", ".RPRPR.", ".RPRPR."], 32, 55);
  return finish(g, dir);
}

/** `thrust` frame n: the idle body sheared row by row, hips forward and shoulders back, feet planted. Drawn at THRUST_OFFSET
 *  from the partner's floor point. */
export function thrustGrid(a: AvatarDef, dir: Dir, n: number): Grid {
  const hip = [-2, 1, 4][n] ?? 0;
  const head = [1, 0, -2][n] ?? 0;
  const idle = idleWide(a);
  const g = blank(DUNGEON_CELL.w, DUNGEON_CELL.h);
  const ox = THRUST_FLOOR.x - BEND_FLOOR.x + THRUST_OFFSET.x, oy = THRUST_OFFSET.y;
  const shift = (y: number): number => {
    if (y >= 51) return Math.round((hip * (60 - y)) / 9);
    if (y >= 47) return hip;
    if (y >= 40) return Math.round(head + ((hip - head) * (y - 40)) / 7);
    return head;
  };
  for (let y = 0; y <= 60; y++) copyRows(idle, g, y, y, ox + shift(y), oy);
  return finish(g, dir);
}
