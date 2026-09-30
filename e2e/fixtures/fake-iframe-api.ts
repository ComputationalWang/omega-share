// Fake YouTube IFrame Player API (M1b, OME-85). Spec: docs/research/m1b-youtube-sync.md §1.1, §4.2.3.
// Served at https://www.youtube.com/iframe_api by e2e/support/network.ts as `(${installFakeYt})(window)`,
// so installFakeYt must stay self-contained: no references to anything outside its own body.

export interface FrameLike {
  tagName: string;
  src?: string;
  id?: string;
  replaceWith?: (node: FrameLike) => void;
}

export interface FakeYtHost {
  performance: { now(): number };
  setTimeout(handler: () => void, ms: number): unknown;
  document?: { getElementById(id: string): FrameLike | null; createElement(tag: "iframe"): FrameLike };
  YT?: FakeYtNamespace;
  __fakeYt?: FakeYtHooks;
  onYouTubeIframeAPIReady?: () => void;
}

export interface PlayerEvent<T = number | null> {
  target: FakePlayer;
  data: T;
}

export interface PlayerOptions {
  videoId?: string;
  events?: {
    onReady?: (e: PlayerEvent<null>) => void;
    onStateChange?: (e: PlayerEvent<number>) => void;
    onPlaybackRateChange?: (e: PlayerEvent<number>) => void;
    onError?: (e: PlayerEvent<number>) => void;
    onAutoplayBlocked?: (e: PlayerEvent<null>) => void;
  };
}

export interface VideoData {
  video_id: string;
  title: string;
  author: string;
}

export interface FakePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getVideoData(): VideoData;
  getIframe(): FrameLike;
  destroy(): void;
}

export interface FakeYtNamespace {
  Player: new (el: string | FrameLike, options?: PlayerOptions) => FakePlayer;
  PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 };
  loaded: 1;
  ready(cb: () => void): void;
}

/** One entry per event the fake emitted, in order; `t` is performance.now() at emit time. */
export interface FakeYtEvent {
  type: "ready" | "state" | "rate" | "error" | "autoplayBlocked";
  data: number | null;
  t: number;
}

export interface FakeYtConfig {
  /** Content duration in seconds. Default 634.5 (Big Buck Bunny). */
  duration: number;
  /** Ad duration in seconds, reported by getDuration() during ad(ms). Default 15. */
  adDuration: number;
  /** Video id reported by getVideoData() during ad(ms). Default "fake-ad-0001". */
  adVideoId: string;
  availableRates: number[];
  /** false: setPlaybackRate rounds down to an available rate in the direction of 1 (documented behaviour). Default true (§1.3 spike). */
  fineRates: boolean;
  /** false: getPlaybackRate echoes the set rate but the media clock keeps playing at 1 (the §1.3 effective-rate trap). Default true. */
  applyRate: boolean;
  /** Delay before onReady, ms. Default 20. */
  readyDelayMs: number;
}

/** window.__fakeYt: fault injection and read-outs for the most recently created player. */
export interface FakeYtHooks {
  /** Emit state 3, freeze the media clock for `ms`, then return to the previous state. */
  buffering(ms: number): void;
  /** Play an ad for `ms`: emit 3 then 1; getVideoData/getDuration/getCurrentTime follow the ad; content clock frozen; then emit 3 and restore the previous state. */
  ad(ms: number): void;
  /** Block unmuted playback from now on (like a browser autoplay policy). If playing unmuted, pause (state 2). Emits onAutoplayBlocked on each blocked attempt. */
  autoplayBlocked(): void;
  /** Lift the autoplayBlocked() policy. */
  allowAutoplay(): void;
  /** Emit onError(code) and halt the media clock. */
  error(code: number): void;
  /** Delay applied to later seekTo calls: emit 3, hold at the target for `ms`, then restore the previous state. 0 = instant (default). */
  seekLatency(ms: number): void;
  /** A user click on the video: toggles play/pause, ignoring the autoplay policy (it is a user gesture). */
  clickToggle(): void;
  configure(config: Partial<FakeYtConfig>): void;
  readonly currentTime: number;
  readonly rate: number;
  readonly state: number;
  readonly events: readonly FakeYtEvent[];
  readonly player: FakePlayer | null;
}

export function installFakeYt(win: FakeYtHost): void {
  if (win.YT) return;
  throw new Error("not implemented");
}

declare global {
  interface Window {
    YT?: FakeYtNamespace;
    __fakeYt?: FakeYtHooks;
    onYouTubeIframeAPIReady?: () => void;
  }
}
