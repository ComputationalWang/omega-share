// /hug and /highfive (OME-1453), zero new wire: walk over to a member with the existing `walk`, then the existing
// `emote` once I'm there. A walk elsewhere, or them leaving, drops it unsent.
import type { FloorCell, Member, MemberId } from "@omega/shared";
import type { SystemLine } from "../controls/sysline";
import type { ViewState } from "../state";
import { foldName } from "./mention";

export type MemberMatch = { readonly type: "match"; readonly id: MemberId; readonly nickname: string } | { readonly type: "none" } | { readonly type: "ambiguous" };

// Folded like a mention (OME-1531). Not the full UTS #39 skeleton: its table is server-only (ADR 0023), and the server
// already keeps confusable twins out of one room.
const fold = (s: string): string => foldName(s).trim();

/** The member other than me called `name`. */
export function matchMember(members: readonly Member[], self: MemberId | null, name: string): MemberMatch {
  const want = fold(name);
  const hits = members.filter((m) => m.id !== self && fold(m.nickname) === want);
  const [hit] = hits;
  if (hit === undefined) return { type: "none" };
  return hits.length > 1 ? { type: "ambiguous" } : { type: "match", id: hit.id, nickname: hit.nickname };
}

export interface PendingHug {
  /** Who I walk over to; null for the cat (OME-1669), who is no member. */
  readonly target: MemberId | null;
  /** Where the walk over goes. */
  readonly cell: FloorCell;
}

/** What one state change means for a pending hug. Runs per state change, not per frame. */
export function hugStep(prev: ViewState, next: ViewState, hug: PendingHug): "arrived" | "cancel" | null {
  const room = next.room;
  if (next.status !== "open" || room === null || next.self === null) return "cancel";
  const self = next.self;
  // Sitting down cancels; being seated already doesn't (the walk over stands me up first).
  const sat = room.seats.includes(self) && !(prev.room?.seats.includes(self) ?? false);
  if (sat || !room.members.some((m) => m.id === hug.target)) return "cancel";
  const mine = room.members.find((m) => m.id === self)?.cell;
  // A `walked` replaces my member, so a new cell object means I walked.
  if (mine === undefined || mine === prev.room?.members.find((m) => m.id === self)?.cell) return null;
  return mine.x === hug.cell.x && mine.y === hug.cell.y ? "arrived" : "cancel";
}

/** What a /hug with no one to hug says, to me only; nothing is sent. */
export const hugHint = (verb: string): SystemLine => ({ glyph: "host", actor: null, verb, time: null, self: true });
