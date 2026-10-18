// Follow (OME-1389): while I follow someone, each of their `walked` sends me a Walk over beside them.
import type { MemberId } from "@omega/shared";
import type { ViewState } from "../state";

/** What one state change means for following `target`: walk over again, stop, or nothing. Runs per state change, not per frame. */
export function followStep(prev: ViewState, next: ViewState, target: MemberId): "walk" | "stop" | null {
  const room = next.room;
  if (next.status !== "open" || room === null || next.self === null) return "stop";
  const them = room.members.find((m) => m.id === target);
  if (them === undefined || room.seats.includes(target) || room.seats.includes(next.self)) return "stop";
  // A `walked` replaces the member, so its cell is a new object even to the same spot.
  return prev.room?.members.find((m) => m.id === target)?.cell !== them.cell ? "walk" : null;
}
