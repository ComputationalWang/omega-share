// Pet the cat (OME-1669): the spot beside the cat I walk to, and whether a member stands beside one. No wire: the
// existing `walk` and `heart` emote; every client reads a heart from a member beside a cat as a pet.

/** The free cell beside the cat that `mine` reaches in the fewest steps (`taken`: cells members stand on), or null. */
export function petCell(_grid: Uint8Array, _cat: number, _mine: number, _taken: ReadonlySet<number>): number | null {
  return null;
}

/** True when `cell` is orthogonally next to any of `cats` (walk cells). */
export function isPetting(_cell: number, _cats: readonly number[]): boolean {
  return false;
}
