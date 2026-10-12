// Standing spots for members without a seat (OME-408). Each keeps their spot while it exists, so someone leaving
// doesn't send everyone behind them walking; newcomers take the lowest free spot (the front of the room first).
import type { MemberId } from "@omega/shared";

/** Spot index per standing member, given last time's; members beyond `spotCount` get none. */
export function standingSpots(standers: readonly MemberId[], spotCount: number, prev: ReadonlyMap<MemberId, number>, claimed: ReadonlySet<number> = new Set()): Map<MemberId, number> {
  const out = new Map<MemberId, number>();
  const taken = new Set<number>(claimed);
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

/**
 * Where each non-seated member stands (OME-911, ADR 0043). A member with a server `standingSlot` stands on that point; a
 * slot the layout has no point for (a smaller layout) falls back to the local allocation, so nobody vanishes. The rest keep the local allocation, avoiding every slot in `claimed`
 * (all members' slots, seated ones included). Pure: the stage calls it on membership/layout changes only.
 */
export function standingPlacement(standers: readonly { readonly id: MemberId; readonly standingSlot?: number | undefined }[], claimed: ReadonlySet<number>, spotCount: number, prev: ReadonlyMap<MemberId, number>): Map<MemberId, number> {
  const legacy: MemberId[] = [];
  const slotted: [MemberId, number][] = [];
  for (const m of standers) {
    if (m.standingSlot === undefined || m.standingSlot >= spotCount) legacy.push(m.id);
    else slotted.push([m.id, m.standingSlot]);
  }
  const out = standingSpots(legacy, spotCount, prev, claimed);
  for (const [id, slot] of slotted) out.set(id, slot);
  return out;
}
