// Name tags sit over their owner's head (OME-2172) and, where they'd overlap, stack (OME-2118): by a doorway or a sofa
// the tags of avatars a few px apart piled on one another. Each tag, back row first, rises over any tag already placed
// that it would cover. Never per frame: the stage runs it on a render, when a walk ends, and when a tag's size or the
// label scale changes.

/** A tag as shown (stage px): its anchor (top centre, under the feet) and its width. */
export interface TagBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  /** The owner's head top (stage px): the tag sits just above it, and no tag covers a head. */
  readonly top: number;
}

/** Where a tag goes: how far it moves (stage px), and whether it lies off its owner's head and wears a leader pip. */
export interface TagPlace {
  readonly dx: number;
  readonly dy: number;
  readonly led: boolean;
}

/** An avatar's head under its `top` (stage px), as tags keep off it. */
export const HEAD_W = 24;
export const HEAD_H = 24;

/** The gap (stage px) between a tag and the head under it, and between stacked tags. */
export const TAG_GAP = 2;
/** A tag further than this (stage px) from its owner's head wears a leader pip (OME-2172). */
const NEAR = 12;

/** A tag's spot: its sideways move and its top (stage px). */
interface Spot {
  readonly dx: number;
  readonly y: number;
}

/** A box on the stage (stage px). */
export interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** Heads closer than this (stage px) to a tag than its owner's still count as a tie: avatars on one spot share their tags' spots. */
const TIE = 4;

/** The sideways nudges (stage px) a tag tries over its owner's head before it stacks away. */
const NUDGES = [0, -16, 16];

/** How far (stage px, centre to head box) a tag of height `h` goes before spots further off count (OME-2518): a tag
 * stacked once over the one on the head. In a dense phone room the upward stack climbed the back wall instead. */
export const reachOf = (h: number): number => 1.5 * h + 2 * TAG_GAP;

/**
 * Where each tag of height `h` goes so no two overlap and none covers a head (its owner's included) or an `avoid` box
 * (the screen, OME-2196) (OME-2149, OME-2172). A tag sits TAG_GAP above its owner's head, nudged sideways if that's
 * taken; else it stacks upward over what it hits; else it sits beside the head; else it hangs under the feet, nudged
 * likewise (under the feet before beside the head where the window cuts the spot over it); else it stacks upward, nudged. Of those spots in `minY`–`maxY` (the shown room), within `reachOf(h)` of the head if any are (OME-2518), it
 * takes the first nearer its owner's head than any other (OME-2196: in a cluster a tag stacked over the heads behind
 * named the wrong avatar), else the one nearest it by the most. With none in the window,
 * it stacks upward, or under the feet where that leaves the window, dropping under what it hits or, past `maxY`,
 * rising over it. A tag more than NEAR px off its owner's head is `led` (wears a leader pip).
 */
export function stackTags(tags: readonly TagBox[], h: number, maxY = Infinity, minY = -Infinity, avoid: readonly Box[] = []): TagPlace[] {
  const out: TagPlace[] = tags.map(() => ({ dx: 0, dy: 0, led: false }));
  // Back row first, then left to right: the same tags stack the same way in any order.
  const order = tags.map((t, i) => ({ t, i })).sort((a, b) => a.t.y - b.t.y || a.t.x - b.t.x || a.t.w - b.t.w);
  const heads = tags.map((t): Box => ({ x0: t.x - HEAD_W / 2, x1: t.x + HEAD_W / 2, y0: t.top, y1: t.top + HEAD_H }));
  const placed: Box[] = [];
  /** What a tag at (x0, x1, y) would cover first: a tag placed before it, or a head. */
  const blocker = (x0: number, x1: number, y: number): Box | undefined => {
    const hit = (b: Box): boolean => x0 < b.x1 && b.x0 < x1 && y < b.y1 && b.y0 < y + h;
    return placed.find(hit) ?? heads.find(hit) ?? avoid.find(hit);
  };
  // Each hit moves the tag strictly one way, past a box it hit: at most one pass per box.
  const settle = (x0: number, x1: number, y0: number, down: boolean): number => {
    let y = y0;
    for (let b = blocker(x0, x1, y); b !== undefined; b = blocker(x0, x1, y)) y = down ? b.y1 + TAG_GAP : b.y0 - h - TAG_GAP;
    return y;
  };
  /** How far a tag at (dx, y) lies from its owner's head; Infinity if it isn't over the head's width. */
  const fromHead = (t: TagBox, dx: number, y: number): number =>
    t.x + dx + t.w / 2 < t.x - HEAD_W / 2 || t.x + HEAD_W / 2 < t.x + dx - t.w / 2 ? Infinity : Math.max(0, t.top - (y + h), y - (t.top + HEAD_H));
  for (const { t, i } of order) {
    const over = t.top - TAG_GAP - h;
    const x0 = t.x - t.w / 2;
    const x1 = t.x + t.w / 2;
    /** How much nearer its owner's head a spot is than any other head (negative: another is nearer; Infinity alone). */
    const margin = ({ dx, y }: Spot): number => {
      const d = (o: TagBox): number => Math.hypot(o.x - t.x - dx, o.top + HEAD_H / 2 - y - h / 2);
      const own = d(t);
      return tags.reduce((m, o, j) => (j === i ? m : Math.min(m, d(o) - own)), Infinity);
    };
    /** How far (stage px) a spot's centre lies from its owner's head box. */
    const reach = ({ dx, y }: Spot): number => Math.hypot(Math.max(0, Math.abs(dx) - HEAD_W / 2), Math.max(0, t.top - y - h / 2, y + h / 2 - t.top - HEAD_H));
    const up = { dx: 0, y: settle(x0, x1, over, false) };
    const side = t.w / 2 + HEAD_W / 2 + TAG_GAP;
    const beside = t.top + (HEAD_H - h) / 2;
    const cut = over < minY;
    const under = NUDGES.map((dx) => ({ dx, y: t.y }));
    const sides = [{ dx: -side, y: beside }, { dx: side, y: beside }];
    // Stacked upward, nudged: in a row of wide phone tags the step up missed the one beside it by a few px (OME-2535).
    const ups = NUDGES.slice(1).map((dx) => ({ dx, y: settle(x0 + dx, x1 + dx, over, false) }));
    // Over the head, stacked upward, beside the head, under the feet (before beside it where the window cuts the spot over
    // the head, OME-2118): the free ones in the window, the first nearest its owner's head, else the one nearest it by the
    // most. Those within one stack step of the head, or under the feet where the window cuts, count first (OME-2518: in a
    // dense phone room the upward stack climbed the back wall).
    const spots = [...NUDGES.map((dx) => ({ dx, y: over })), up, ...(cut ? [...under, ...sides] : [...sides, ...under]), ...ups].filter(
      (c) => c.y >= minY && c.y + h <= maxY && (c === up || blocker(x0 + c.dx, x1 + c.dx, c.y) === undefined),
    );
    const pick = (cs: readonly Spot[]): Spot | undefined => cs.find((c) => margin(c) + TIE >= 0) ?? cs.reduce<Spot | undefined>((b, c) => (b === undefined || margin(c) > margin(b) ? c : b), undefined);
    let at = pick(spots.filter((c) => reach(c) <= reachOf(h) || (cut && under.includes(c)))) ?? pick(spots);
    if (at === undefined) {
      if (up.y >= minY) at = up;
      else {
        const below = settle(x0, x1, t.y, true);
        // A tag that starts in the window ends in it (OME-2170); one whose owner is below the window leaves with them.
        const rise = t.y < maxY ? Math.min(t.y, maxY - h) : t.y;
        at = { dx: 0, y: below + h > maxY && (below !== t.y || rise !== t.y) ? settle(x0, x1, rise, false) : below };
      }
    }
    placed.push({ x0: x0 + at.dx, x1: x1 + at.dx, y0: at.y, y1: at.y + h });
    out[i] = { dx: at.dx, dy: at.y - t.y, led: fromHead(t, at.dx, at.y) > NEAR };
  }
  return out;
}

/** `stackTags` that returns its last places when called again with equal tags, height, window and avoid boxes (OME-2317). */
export function createTagStacker(): (tags: readonly TagBox[], h: number, maxY: number, minY: number, avoid: readonly Box[]) => readonly TagPlace[] {
  let last: { tags: readonly TagBox[]; h: number; maxY: number; minY: number; avoid: readonly Box[]; out: readonly TagPlace[] } | null = null;
  const sameBox = (a: Box, b: Box | undefined): boolean => a.x0 === b?.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
  const sameTag = (a: TagBox, b: TagBox | undefined): boolean => a.x === b?.x && a.y === b.y && a.w === b.w && a.top === b.top;
  return (tags, h, maxY, minY, avoid) => {
    const was = last;
    if (was?.h === h && was.maxY === maxY && was.minY === minY && was.tags.length === tags.length && was.avoid.length === avoid.length && tags.every((t, i) => sameTag(t, was.tags[i])) && avoid.every((b, i) => sameBox(b, was.avoid[i]))) return was.out;
    last = { tags, h, maxY, minY, avoid, out: stackTags(tags, h, maxY, minY, avoid) };
    return last.out;
  };
}

/** The boxes (stage px) of the sprites marked `screen` (furniture.ts), each its frame around its anchor, down to the anchor
 * at most: under it is the stand's front (classic's TV console, OME-2246), not the picture; `frame` gives a loaded frame's
 * size and anchor. Tags keep off them (OME-2196). */
export function screenBoxes(sprites: readonly { readonly key: string; readonly x: number; readonly y: number; readonly screen?: true }[], frame: (key: string) => { w: number; h: number; ax: number; ay: number } | undefined): Box[] {
  return sprites.flatMap(({ key, x, y, screen }) => {
    const f = screen === true ? frame(key) : undefined;
    if (f === undefined) return [];
    const x0 = x - f.ax * f.w;
    const y0 = y - f.ay * f.h;
    return [{ x0, x1: x0 + f.w, y0, y1: Math.min(y0 + f.h, y) }];
  });
}

/** What `wearPlace` writes: a tag's or hit pad's style and classes. */
export interface PlaceWearer {
  readonly style: { marginLeft: string; marginTop: string };
  readonly classList: { toggle(c: string, on: boolean): boolean };
}

/** Write place `m` on a tag (`tag`: its pip classes too) or its hit pad, unless it already wears an equal one: a walker's
 * tag keeps one place for the whole walk and a render's restack mostly repeats the last, and re-writing them cost the
 * /conga row its headroom (OME-2213). */
export function wearPlace(e: PlaceWearer, m: TagPlace, worn: WeakMap<object, TagPlace>, tag: boolean): void {
  const was = worn.get(e);
  if (was?.dx === m.dx && was.dy === m.dy && was.led === m.led) return;
  worn.set(e, m);
  e.style.marginLeft = `${String(m.dx)}px`;
  e.style.marginTop = `${String(m.dy)}px`;
  if (!tag) return;
  e.classList.toggle("is-led", m.led);
  // Over its owner the pip points down at the head; hung under the feet, up at them.
  e.classList.toggle("is-above", m.dy < 0);
}
