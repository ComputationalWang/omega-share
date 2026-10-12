// The room tab's durable-session decisions (OME-911, ADR 0043), pure so room.ts and stage.ts only wire them.
import type { MemberId } from "@omega/shared";

/**
 * The away hint to send now, or null. Only on a transition and only on an open, joined socket. The server clears away on
 * every (re)join, so the caller resets `sent` to false on each snapshot: a tab still hidden then owes one hint.
 */
export function presenceHint(s: { readonly hidden: boolean; readonly sent: boolean; readonly open: boolean }): boolean | null {
  if (!s.open || s.hidden === s.sent) return null;
  return s.hidden;
}

/** Which avatars to dim (`on`) and undim (`off`, including members who left), given who was dimmed before. */
export function awayChanges(prev: ReadonlySet<MemberId>, members: readonly { readonly id: MemberId; readonly away?: boolean | undefined }[]): { on: MemberId[]; off: MemberId[]; now: Set<MemberId> } {
  const now = new Set<MemberId>();
  const on: MemberId[] = [];
  for (const m of members) {
    if (m.away !== true) continue;
    now.add(m.id);
    if (!prev.has(m.id)) on.push(m.id);
  }
  const off: MemberId[] = [];
  for (const id of prev) if (!now.has(id)) off.push(id);
  return { on, off, now };
}
