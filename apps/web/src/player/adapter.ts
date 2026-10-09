import type { PlaybackCaps } from "@omega/shared";
import type { QualityControl } from "./quality";

/** What the sync loop sees of a player. "ad" = the player is showing something other than the room's video. */
export type PlayerState = "unstarted" | "playing" | "paused" | "buffering" | "ended" | "cued" | "ad";

export type PlayerEvent =
  | { readonly type: "ready" }
  | { readonly type: "state"; readonly state: PlayerState }
  /** The provider refused or lost the video. `code` is the provider's own, for the notice and logs. */
  | { readonly type: "error"; readonly reason: PlayerErrorReason; readonly code: string }
  /** The browser blocked sound; we're now playing muted. The UI shows Unmute (outside the player). */
  | { readonly type: "autoplay-blocked" }
  /** A play/pause the user made inside the player (not an echo of our own command) → room `control`. */
  | { readonly type: "intent"; readonly playing: boolean; readonly position: number }
  /** The quality list or the quality playing changed (OME-599): re-read `quality`. */
  | { readonly type: "quality" };

/** Why a player can't play the room's video (research §6.2), provider-neutral. */
export type PlayerErrorReason = "refused" | "not-found" | "restricted" | "offline" | "timeout" | "other";

export interface PlayerError {
  readonly reason: PlayerErrorReason;
  readonly code: string;
}

/**
 * The seam between sync logic and a real player (research §4.1). The YouTube
 * implementation is `attachYouTube()`; tests use a fake. Commands before `ready()` are dropped.
 */
export interface PlayerAdapter {
  /** `playbackCaps(embed)` of the embed this player shows (ADR 0014 §3). */
  readonly caps: PlaybackCaps;
  ready(): boolean;
  play(): void;
  pause(): void;
  /** Seconds. */
  seek(seconds: number): void;
  setRate(rate: number): void;
  unmute(): void;
  /** 0–100, this user only (ADR 0002). */
  setVolume(volume: number): void;
  /** Seconds, as the player reports it. */
  time(): number;
  /** The room video's duration, seconds; 0 until known. Never an ad's. */
  duration(): number;
  state(): PlayerState;
  /** Rates the player accepts. For `caps.rate === "probe"` this must be final once `ready()` is true. */
  rates(): readonly number[];
  /** Per-viewer quality (OME-599). Absent where the provider has no API (YouTube since 2019, the generic tier). */
  readonly quality?: QualityControl;
  onEvent(cb: (e: PlayerEvent) => void): () => void;
  destroy(): void;
}
