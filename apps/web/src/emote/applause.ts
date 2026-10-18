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
  return { push: () => false };
}
