// Minimal typed view of the Vimeo Player SDK (research M2 §1.2). Only what we call. Every method is a
// postMessage round trip that resolves with whatever the iframe sent back, so results are `unknown`.

export interface VimeoPlayer {
  ready(): Promise<void>;
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  setCurrentTime(seconds: number): Promise<unknown>;
  setPlaybackRate(rate: number): Promise<unknown>;
  /** 0–1. */
  setVolume(volume: number): Promise<unknown>;
  setMuted(muted: boolean): Promise<unknown>;
  getVideoId(): Promise<unknown>;
  getDuration(): Promise<unknown>;
  destroy(): Promise<unknown>;
  on(event: string, callback: (data?: unknown) => void): void;
  off(event: string, callback?: (data?: unknown) => void): void;
}

/**
 * `window.Vimeo`. We only ever attach to our own iframe (ADR 0014 §5), so the constructor is typed
 * to take an iframe element and no options: the SDK never gets to choose src, sandbox or allow.
 */
export interface VimeoNamespace {
  readonly Player: new (el: HTMLIFrameElement) => VimeoPlayer;
}

/** Boundary guard for the `Vimeo` global. */
export function asVimeoNamespace(x: unknown): VimeoNamespace | null {
  if (typeof x !== "object" || x === null || !("Player" in x) || typeof x.Player !== "function") return null;
  // Checked above: Player is a constructor; what it returns is guarded per call.
  return x as VimeoNamespace;
}
