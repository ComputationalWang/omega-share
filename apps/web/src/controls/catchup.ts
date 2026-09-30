import type { PlayerState } from "../player/adapter";

/** A stall must last this long before we say "catching up", so seek/buffer blips never flash the hourglass. */
export const CATCHUP_SHOW_MS = 500;

export interface Catchup {
  readonly catching: boolean;
  /** When the current stall began, ms; -1 = not stalled. */
  readonly since: number;
}

export interface CatchupInput {
  readonly now: number;
  readonly playerState: PlayerState;
  readonly roomPlaying: boolean;
}

export const NOT_CATCHING: Catchup = { catching: false, since: -1 };

/**
 * Pure: this client is catching up while the room plays and its own player is
 * buffering or showing an ad (research §1.4). Returns `prev` when nothing changed.
 */
export function stepCatchup(prev: Catchup, i: CatchupInput): Catchup {
  const stalled = i.roomPlaying && (i.playerState === "buffering" || i.playerState === "ad");
  if (!stalled) return prev.since < 0 && !prev.catching ? prev : NOT_CATCHING;
  if (prev.since < 0) return { catching: false, since: i.now };
  if (prev.catching || i.now - prev.since < CATCHUP_SHOW_MS) return prev;
  return { catching: true, since: prev.since };
}
