// Name tags that would overlap stack (OME-2118): by a doorway or a sofa the tags of avatars a few px apart piled on one
// another. Each tag, back row first, drops under any tag already placed that it would cover. Never per frame: the stage
// runs it on a render, when a walk ends, and when a tag's size or the label scale changes.

/** A tag as shown (stage px): its anchor (top centre) and its width. */
export interface TagBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/** The gap (stage px) between stacked tags. */
const GAP = 2;

/** How far down (stage px) each tag of height `h` moves so no two overlap; a tag that overlaps nothing stays put. */
export function stackTags(tags: readonly TagBox[], h: number): number[] {
  const dy = tags.map(() => 0);
  // Back row first, then left to right: the same tags stack the same way in any order.
  const order = tags.map((t, i) => ({ t, i })).sort((a, b) => a.t.y - b.t.y || a.t.x - b.t.x || a.t.w - b.t.w);
  const placed: { readonly x0: number; readonly x1: number; readonly y: number }[] = [];
  for (const { t, i } of order) {
    const x0 = t.x - t.w / 2;
    const x1 = t.x + t.w / 2;
    let y = t.y;
    // Each hit moves the tag strictly down, past a box placed before it: at most `placed.length` passes.
    for (let hit = true; hit; ) {
      hit = false;
      for (const p of placed) {
        if (x0 < p.x1 && p.x0 < x1 && y < p.y + h && p.y < y + h) {
          y = p.y + h + GAP;
          hit = true;
        }
      }
    }
    placed.push({ x0, x1, y });
    dy[i] = y - t.y;
  }
  return dy;
}
