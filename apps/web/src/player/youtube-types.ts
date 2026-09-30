// Minimal typed view of the YouTube IFrame Player API (research §1.1). Only what we
// call. Read-outs are `unknown`: the API is third-party code, so the adapter guards them.

export interface YtEvent {
  readonly target: unknown;
  readonly data?: unknown;
}

export interface YtPlayerOptions {
  readonly events: {
    readonly onReady?: (e: YtEvent) => void;
    readonly onStateChange?: (e: YtEvent) => void;
    readonly onError?: (e: YtEvent) => void;
    readonly onAutoplayBlocked?: (e: YtEvent) => void;
  };
}

export interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  destroy(): void;
  getCurrentTime(): unknown;
  getDuration(): unknown;
  getPlayerState(): unknown;
  getVideoData(): unknown;
  getAvailablePlaybackRates(): unknown;
}

/**
 * `window.YT`. We only ever attach to our own iframe (ADR 0011), so the constructor
 * is typed to take an iframe element and events, never a div + videoId.
 */
export interface YtNamespace {
  readonly Player: new (el: HTMLIFrameElement, options: YtPlayerOptions) => YtPlayer;
}

/** Boundary guard for the `YT` global. */
export function asYtNamespace(x: unknown): YtNamespace | null {
  if (typeof x !== "object" || x === null || !("Player" in x) || typeof x.Player !== "function") return null;
  // Checked above: Player is a constructor we can call with `new`; its shape is guarded per call.
  return x as YtNamespace;
}
