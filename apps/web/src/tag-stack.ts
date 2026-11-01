import { TILE_H, TILE_W } from "./layout";

// Name tags that would overlap stack (OME-2118): by a doorway or a sofa the tags of avatars a few px apart piled on one
// another. Each tag, back row first, drops under any tag already placed that it would cover. Never per frame: the stage
// runs it on a render, when a walk ends, and when a tag's size or the label scale changes.

/** A tag as shown (stage px): its anchor (top centre) and its width. */
export interface TagBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  /** The owner's head top (stage px), if known: other tags keep off the head under it. */
  readonly top?: number;
}

/** Where a tag goes: how far it moves (stage px), and whether it left its owner's cell and wears a leader pip. */
export interface TagPlace {
  readonly dx: number;
  readonly dy: number;
  readonly led: boolean;
}

/** An avatar's head under its `top` (stage px), as other tags keep off it. */
export const HEAD_W = 24;
export const HEAD_H = 24;

/** The gap (stage px) between stacked tags. */
const GAP = 2;

/** A box on the stage (stage px). */
interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** The sideways nudges (stage px) a tag tries, by its owner, before it stacks away. */
const NUDGES = [0, -16, 16];

/**
 * Where each tag of height `h` goes so no two overlap and none covers another avatar's head (OME-2149). A tag first
 * tries the spots by its owner: where it hangs, one tag lower, above the owner's head, each nudged sideways. Only where
 * all are taken (or outside `minY`–`maxY`, the shown room) does it drop under what it hits, or, where that would take it
 * past `maxY`, rise over it; a tag that ends up outside its owner's cell is `led` (it wears a leader pip).
 */
export function stackTags(tags: readonly TagBox[], h: number, maxY = Infinity, minY = -Infinity): TagPlace[] {
  const out: TagPlace[] = tags.map(() => ({ dx: 0, dy: 0, led: false }));
  // Back row first, then left to right: the same tags stack the same way in any order.
  const order = tags.map((t, i) => ({ t, i })).sort((a, b) => a.t.y - b.t.y || a.t.x - b.t.x || a.t.w - b.t.w);
  const heads = tags.map((t): Box | null => (t.top === undefined ? null : { x0: t.x - HEAD_W / 2, x1: t.x + HEAD_W / 2, y0: t.top, y1: t.top + HEAD_H }));
  const placed: Box[] = [];
  /** What a tag of `i`'s at (x0, x1, y) would cover first: a tag placed before it, or another avatar's head. */
  const blocker = (i: number, x0: number, x1: number, y: number): Box | undefined => {
    const hit = (b: Box | null): b is Box => b !== null && x0 < b.x1 && b.x0 < x1 && y < b.y1 && b.y0 < y + h;
    return placed.find(hit) ?? heads.find((b, j): b is Box => j !== i && hit(b));
  };
  // Each hit moves the tag strictly one way, past a box it hit: at most one pass per box.
  const settle = (i: number, x0: number, x1: number, y0: number, down: boolean): number => {
    let y = y0;
    for (let b = blocker(i, x0, x1, y); b !== undefined; b = blocker(i, x0, x1, y)) y = down ? b.y1 + GAP : b.y0 - h - GAP;
    return y;
  };
  /** Within one cell of its owner: sideways of its feet, above its head or under its tag's anchor. */
  const near = (t: TagBox, dx: number, y: number): boolean => Math.abs(dx) <= TILE_W / 2 && y + h >= (t.top ?? t.y) - TILE_H && y <= t.y + TILE_H;
  for (const { t, i } of order) {
    const rows = [t.y, t.y + h + GAP, ...(t.top === undefined ? [] : [t.top - GAP - h])];
    let at: { dx: number; y: number } | undefined;
    for (const dx of NUDGES) {
      at = rows.map((y) => ({ dx, y })).find(({ y }) => y >= minY && y + h <= maxY && near(t, dx, y) && blocker(i, t.x + dx - t.w / 2, t.x + dx + t.w / 2, y) === undefined);
      if (at !== undefined) break;
    }
    if (at === undefined) {
      const x0 = t.x - t.w / 2;
      const x1 = t.x + t.w / 2;
      const below = settle(i, x0, x1, t.y, true);
      at = { dx: 0, y: below + h > maxY && below !== t.y ? settle(i, x0, x1, t.y, false) : below };
    }
    placed.push({ x0: t.x + at.dx - t.w / 2, x1: t.x + at.dx + t.w / 2, y0: at.y, y1: at.y + h });
    out[i] = { dx: at.dx, dy: at.y - t.y, led: !near(t, at.dx, at.y) };
  }
  return out;
}
