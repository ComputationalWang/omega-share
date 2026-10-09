import { playbackCaps, type PlaybackCaps } from "@omega/shared";
import type { PlayerAdapter, PlayerEvent, PlayerState } from "../../src/player/adapter";
import type { QualityControl, QualityOption } from "../../src/player/quality";

export type FakeCall =
  | { op: "play" }
  | { op: "pause" }
  | { op: "seek"; to: number }
  | { op: "rate"; rate: number }
  | { op: "unmute" }
  | { op: "volume"; volume: number }
  | { op: "quality"; id: string };

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
  /** ms the player sits in "buffering" after play() from a stop (paused, cued), content clock frozen. */
  startLatencyMs?: number;
  ready?: boolean;
  /** play() is recorded but does nothing (loading, or a blocked autoplay). */
  ignorePlay?: boolean;
  state?: PlayerState;
  position?: number;
  /** Content duration, s; 0 = unknown. */
  duration?: number;
  /** Give the fake a quality capability (Twitch, Vimeo) with this list; absent = none (YouTube). */
  qualities?: readonly QualityOption[];
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
  qualityList: readonly QualityOption[] = [];
  qualityNow: string | null = null;
  readonly quality?: QualityControl;

  constructor(private readonly o: FakePlayerOptions) {
    this.caps = o.caps ?? YOUTUBE_CAPS;
    this.isReady = o.ready ?? true;
    this.st = o.state ?? "cued";
    this.pos = o.position ?? 0;
    this.last = o.now();
    if (o.qualities !== undefined) {
      this.qualityList = o.qualities;
      this.quality = {
        options: () => this.qualityList,
        current: () => this.qualityNow,
        set: (id) => {
          if (!this.qualityList.some((q) => q.id === id)) return;
          this.calls.push({ op: "quality", id });
          this.qualityNow = id;
          this.emit({ type: "quality" });
        },
      };
    }
  }

  /** Test hook: the provider's list arrives or changes (a quality event follows). */
  setQualities(list: readonly QualityOption[], current: string | null = null): void {
    this.qualityList = list;
    this.qualityNow = current;
    this.emit({ type: "quality" });
  }

  private sync(): void {
    const t = this.o.now();
    if (this.resumeAt >= 0 && t >= this.resumeAt) {
      // The media starts at resumeAt, not at the first read after it.
      this.last = this.resumeAt;
      this.resumeAt = -1;
      this.st = "playing";
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
    if (this.resumeAt >= 0 || this.o.ignorePlay === true || this.st === "playing") return;
    const lat = this.o.startLatencyMs ?? 0;
    if (lat > 0) {
      this.st = "buffering";
      this.resumeAt = this.o.now() + lat;
    } else {
      this.st = "playing";
    }
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
