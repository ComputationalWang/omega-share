// Crowd applause (OME-1389): 3 different members clapping or cheering within 3 s plays one confetti burst, derived on
// each client from the relayed emotes (nothing on the wire), at most once per 10 s.
import type { EmoteKind, MemberId } from "@omega/shared";

export const APPLAUSE_MEMBERS = 3;
export const APPLAUSE_WINDOW_MS = 3000;
export const APPLAUSE_COOLDOWN_MS = 10_000;

export interface Applause {
  /** A relayed emote at `now`; true when it completes a crowd applause and the burst should play. */
  push(id: MemberId, kind: EmoteKind, now: number): boolean;
}

export function createApplause(): Applause {
  /** Each member's last clap or cheer; the emote rate limit and the room cap keep it small. */
  const last = new Map<MemberId, number>();
  let quietUntil = -Infinity;
  return {
    push(id, kind, now) {
      if (kind !== "clap" && kind !== "cheer") return false;
      last.set(id, now);
      for (const [m, t] of last) if (now - t >= APPLAUSE_WINDOW_MS) last.delete(m);
      if (last.size < APPLAUSE_MEMBERS || now < quietUntil) return false;
      last.clear();
      quietUntil = now + APPLAUSE_COOLDOWN_MS;
      return true;
    },
  };
}
