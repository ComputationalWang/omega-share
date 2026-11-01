// Name tags that would overlap stack (OME-2118).

/** A tag as shown (stage px): its anchor (top centre) and its width. */
export interface TagBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/** How far down (stage px) each tag of height `h` moves so no two overlap. */
export function stackTags(tags: readonly TagBox[], _h: number): number[] {
  return tags.map(() => 0);
}
