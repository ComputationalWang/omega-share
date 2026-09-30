/** What the sync loop sees of a player. "ad" = the player is showing something other than the room's video. */
export type PlayerState = "unstarted" | "playing" | "paused" | "buffering" | "ended" | "cued" | "ad";

export type PlayerEvent =
  | { readonly type: "ready" }
  | { readonly type: "state"; readonly state: PlayerState }
  | { readonly type: "error"; readonly code: number }
  /** The browser blocked sound; we're now playing muted. The UI shows Unmute (outside the player). */
  | { readonly type: "autoplay-blocked" }
  /** A play/pause the user made inside the player (not an echo of our own command) → room `control`. */
  | { readonly type: "intent"; readonly playing: boolean; readonly position: number };

/**
 * The seam between sync logic and a real player (research §4.1). The YouTube
 * implementation is `attachYouTube()`; tests use a fake. Commands before `ready()` are dropped.
 */
export interface PlayerAdapter {
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
  state(): PlayerState;
  rates(): readonly number[];
  onEvent(cb: (e: PlayerEvent) => void): () => void;
  destroy(): void;
}
