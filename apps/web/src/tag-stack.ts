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

/**
 * How far (stage px) each tag of height `h` moves so no two overlap; a tag that overlaps nothing stays put. A tag drops
 * under the tags it hits, or, where that would take it past `maxY` (the room's bottom), rises over them instead.
 */
export function stackTags(tags: readonly TagBox[], h: number, maxY = Infinity): TagPlace[] {
  const dy = tags.map(() => 0);
  // Back row first, then left to right: the same tags stack the same way in any order.
  const order = tags.map((t, i) => ({ t, i })).sort((a, b) => a.t.y - b.t.y || a.t.x - b.t.x || a.t.w - b.t.w);
  const placed: { readonly x0: number; readonly x1: number; readonly y: number }[] = [];
  // Each hit moves the tag strictly one way, past a box placed before it: at most `placed.length` passes.
  const settle = (x0: number, x1: number, y0: number, down: boolean): number => {
    let y = y0;
    for (let hit = true; hit; ) {
      hit = false;
      for (const p of placed) {
        if (x0 < p.x1 && p.x0 < x1 && y < p.y + h && p.y < y + h) {
          y = down ? p.y + h + GAP : p.y - h - GAP;
          hit = true;
        }
      }
    }
    return y;
  };
  for (const { t, i } of order) {
    const x0 = t.x - t.w / 2;
    const x1 = t.x + t.w / 2;
    const below = settle(x0, x1, t.y, true);
    const y = below + h > maxY && below !== t.y ? settle(x0, x1, t.y, false) : below;
    placed.push({ x0, x1, y });
    dy[i] = y - t.y;
  }
  return dy.map((d) => ({ dx: 0, dy: d, led: false }));
}
