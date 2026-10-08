// Standing spots for members without a seat (OME-408). Each keeps their spot while it exists, so someone leaving
// doesn't send everyone behind them walking; newcomers take the lowest free spot (the front of the room first).
import type { MemberId } from "@omega/shared";

/** Spot index per standing member, given last time's; members beyond `spotCount` get none. */
export function standingSpots(standers: readonly MemberId[], spotCount: number, prev: ReadonlyMap<MemberId, number>): Map<MemberId, number> {
  const out = new Map<MemberId, number>();
  const taken = new Set<number>();
  for (const id of standers) {
    const p = prev.get(id);
    if (p === undefined || p >= spotCount || taken.has(p)) continue;
    out.set(id, p);
    taken.add(p);
  }
  let next = 0;
  for (const id of standers) {
    if (out.has(id)) continue;
    while (taken.has(next)) next++;
    if (next >= spotCount) break;
    out.set(id, next);
    taken.add(next);
  }
  return out;
}
