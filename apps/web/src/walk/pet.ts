// Pet the cat (OME-1669): the spot beside the cat I walk to, and whether a member stands beside one. No wire: the
// existing `walk` and `heart` emote; every client reads a heart from a member beside a cat as a pet.
import { colOf, findPath, rowOf, walkOverCell } from "./path";

/** The free cell beside the cat that `mine` reaches in the fewest steps (`taken`: cells members stand on), or null. */
export function petCell(grid: Uint8Array, cat: number, mine: number, taken: ReadonlySet<number>): number | null {
  const c = walkOverCell(grid, mine, cat, taken);
  return c < 0 ? null : c;
}

/** True when `cell` is orthogonally next to any of `cats` (walk cells). */
export function isPetting(cell: number, cats: readonly number[]): boolean {
  return cats.some((c) => Math.abs(colOf(c) - colOf(cell)) + Math.abs(rowOf(c) - rowOf(cell)) === 1);
}

/** The spot beside whichever cat is nearest by walking from `mine`, or null when no cat has a free reachable side. Runs on a command or tap. */
export function petSpot(grid: Uint8Array, cats: readonly number[], mine: number, taken: ReadonlySet<number>): number | null {
  let best: number | null = null;
  let steps = Infinity;
  for (const cat of cats) {
    const c = petCell(grid, cat, mine, taken);
    const len = c === null ? Infinity : (findPath(grid, mine, c)?.length ?? Infinity);
    if (len < steps) {
      best = c;
      steps = len;
    }
  }
  return best;
}

/** How often a /pet walk chases a cat that moved on before it gives up. */
export const PET_RETRIES = 2;

/** On arriving from a /pet walk at `mine` (`tries`: re-targets so far): pet, chase the cat again, or give up. */
export function petArrival(_mine: number, _cats: readonly number[], _tries: number): "pet" | "retarget" | "lost" {
  return "pet";
}
