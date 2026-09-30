import { playbackCaps, type PlaybackCaps } from "@omega/shared";
import type { PlayerAdapter, PlayerEvent, PlayerState } from "../../src/player/adapter";

export type FakeCall =
  | { op: "play" }
  | { op: "pause" }
  | { op: "seek"; to: number }
  | { op: "rate"; rate: number }
  | { op: "unmute" }
  | { op: "volume"; volume: number };

/** What a YouTube embed can do; the default for a fake. */
export const YOUTUBE_CAPS: PlaybackCaps = playbackCaps({ provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" });

export interface FakePlayerOptions {
  /** Test clock, ms. */
  now: () => number;
  /** Static capabilities of the embed this fake stands in for. Default: YouTube's. */
  caps?: PlaybackCaps;
  rates?: readonly number[];
  /** Which requested rates the media actually plays at. Others play at 1. Default: all. */
  applies?: (rate: number) => boolean;
  /** The media plays the requested rate floored to this step, as YouTube does (OME-109): 1.02 → 1, 0.98 → 0.95. */
  rateStep?: number;
  /** ms the player sits in "buffering" after a seek while playing, content clock frozen. */
  seekLatencyMs?: number;
  ready?: boolean;
  /** play() is recorded but does nothing (loading, or a blocked autoplay). */
  ignorePlay?: boolean;
  state?: PlayerState;
  position?: number;
  /** Content duration, s; 0 = unknown. */
  duration?: number;
}

/** A PlayerAdapter with a deterministic media clock driven by the test's `now()`. */
export class FakePlayer implements PlayerAdapter {
  readonly calls: FakeCall[] = [];
  readonly caps: PlaybackCaps;
  isReady: boolean;
  destroyed = false;
  private st: PlayerState;
  private pos: number;
  private reqRate = 1;
  private last: number;
  private resumeAt = -1;
  private listeners = new Set<(e: PlayerEvent) => void>();

  constructor(private readonly o: FakePlayerOptions) {
    this.caps = o.caps ?? YOUTUBE_CAPS;
    this.isReady = o.ready ?? true;
    this.st = o.state ?? "cued";
    this.pos = o.position ?? 0;
    this.last = o.now();
  }

  private sync(): void {
    const t = this.o.now();
    if (this.resumeAt >= 0 && t >= this.resumeAt) {
      this.resumeAt = -1;
      this.st = "playing";
      this.last = t;
      return;
    }
    if (this.st === "playing") {
      const applies = this.o.applies ?? (() => true);
      const step = this.o.rateStep;
      const req = step === undefined ? this.reqRate : Math.floor(this.reqRate / step + 1e-9) * step;
      const eff = applies(req) ? req : 1;
      this.pos += ((t - this.last) / 1000) * eff;
    }
    this.last = t;
  }

  /** Test hook: jump the local media clock (simulates drift). */
  shift(seconds: number): void {
    this.sync();
    this.pos += seconds;
  }

  /** Test hook: force a state (buffering, ad, ...). */
  setState(s: PlayerState): void {
    this.sync();
    this.st = s;
  }

  emit(e: PlayerEvent): void {
    for (const l of this.listeners) l(e);
  }

  ready(): boolean {
    return this.isReady;
  }
  play(): void {
    this.sync();
    this.calls.push({ op: "play" });
    if (this.resumeAt < 0 && this.o.ignorePlay !== true) this.st = "playing";
  }
  pause(): void {
    this.sync();
    this.calls.push({ op: "pause" });
    this.resumeAt = -1;
    this.st = "paused";
  }
  seek(seconds: number): void {
    this.sync();
    this.calls.push({ op: "seek", to: seconds });
    this.pos = seconds;
    const lat = this.o.seekLatencyMs ?? 0;
    if (this.st === "playing" && lat > 0) {
      this.st = "buffering";
      this.resumeAt = this.o.now() + lat;
    }
  }
  setRate(rate: number): void {
    this.sync();
    this.calls.push({ op: "rate", rate });
    this.reqRate = rate;
  }
  unmute(): void {
    this.calls.push({ op: "unmute" });
  }
  setVolume(volume: number): void {
    this.calls.push({ op: "volume", volume });
  }
  time(): number {
    this.sync();
    return this.pos;
  }
  state(): PlayerState {
    this.sync();
    return this.st;
  }
  duration(): number {
    return this.o.duration ?? 0;
  }
  rates(): readonly number[] {
    return this.o.rates ?? [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  }
  onEvent(cb: (e: PlayerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}
